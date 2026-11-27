import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { parseRemote, prUrl, stackOf, type Branch, type Pr, type PrEdge, type PrRef } from "../shared/prs";
import { prOf, type PrFollows } from "./follows";

const exec = promisify(execFile);

// The plugin subprocess may start without the user's shell PATH; Homebrew installs gh and git here.
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");

async function run(cwd: string, command: string, args: string[]): Promise<string> {
  const { stdout } = await exec(command, args, { cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH } });
  return stdout.trim();
}

const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);

// A spent quota without a reset time to wait for (a secondary limit, or `gh api rate_limit` failed).
const BACKOFF_MS = 5 * 60_000;

/** Thrown instead of calling gh while GitHub's rate limit is spent. */
export class RateLimited extends Error {
  constructor(readonly until: number) {
    super(`GitHub rate limit: gh calls paused until ${new Date(until).toISOString()}`);
  }
}

/**
 * gh reports a spent limit on stderr: "GraphQL: API rate limit already exceeded …", "HTTP 403: API rate limit exceeded …",
 * "HTTP 403: You have exceeded a secondary rate limit", "HTTP 429: …". Stdout is not searched: it can hold PR titles.
 */
export function isRateLimit(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" && /rate limit|HTTP 429/i.test(stderr);
}

/**
 * Every gh call of the plugin. Once GitHub says the quota is spent, calls fail fast with `RateLimited` until it resets,
 * and the caches serve what they have, instead of every read retrying into the limit.
 */
export class Gh {
  private until = 0;

  constructor(
    private readonly exec: (cwd: string, args: string[]) => Promise<string> = (cwd, args) => run(cwd, "gh", args),
    private readonly now: () => number = Date.now,
  ) {}

  async run(cwd: string, args: string[]): Promise<string> {
    if (this.now() < this.until) throw new RateLimited(this.until);
    try {
      return await this.exec(cwd, args);
    } catch (error) {
      if (!isRateLimit(error)) throw error;
      // Calls in flight when the limit hit fail too; only the first one pauses.
      if (this.now() >= this.until) this.pause(cwd);
      throw new RateLimited(this.until);
    }
  }

  private pause(cwd: string): void {
    this.until = this.now() + BACKOFF_MS;
    console.error(`[prs] GitHub rate limit hit; gh calls paused`);
    // `gh api rate_limit` costs no quota. A spent GraphQL quota is back at its reset; any other limit keeps the backoff.
    this.exec(cwd, ["api", "rate_limit", "--jq", '.resources.graphql | "\\(.remaining) \\(.reset)"']).then(
      (out) => {
        const [remaining, reset] = out.split(" ").map(Number);
        if (remaining === 0 && reset) this.until = reset * 1000;
      },
      () => {},
    );
  }
}

const gh = new Gh();

// The repo's open-PR list for stacks is shared by every checkout of the repo for this long, unless forced.
const TTL_MS = 120_000;

/** origin's default branch, from the remote HEAD git recorded at clone time; "main" when it never did. */
async function defaultBranch(cwd: string): Promise<string> {
  const ref = await git(cwd, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").catch(() => "");
  return ref.replace(/^refs\/remotes\/origin\//, "") || "main";
}

/** `owner/name` of the checkout's origin, null outside git or for a non-GitHub remote. */
export async function readRepo(cwd: string): Promise<string | null> {
  return parseRemote(await git(cwd, "remote", "get-url", "origin").catch(() => ""));
}

const noBranch = (cwd: string, repo: string | null = null): Branch => ({ cwd, repo, branch: null, isDefault: false, ahead: 0, prs: [], stack: [] });

/**
 * Reads a checkout's branch from git, its PRs from the host's PR service (`follows`), and its stack from the repo's
 * open-PR list. No call here reads PR state from GitHub itself.
 */
export async function readBranch(cwd: string, force: boolean, follows: PrFollows, active = true): Promise<Branch> {
  const repo = await readRepo(cwd);
  const none = noBranch(cwd, repo);
  const branch = await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
  if (!branch) return none;
  const base = await defaultBranch(cwd);
  if (branch === base) return { ...none, branch, isDefault: true };
  const ahead = Number(await git(cwd, "rev-list", "--count", `origin/${base}..HEAD`).catch(() => "0")) || 0;
  // A worktree's local branch can differ from the PR's head (`feat/x-1` tracking `origin/feat/x`, as checkout-pr does).
  const upstream = await git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").catch(() => "");
  const tracked = upstream.startsWith("origin/") ? upstream.slice("origin/".length) : "";
  // A new branch made from origin/main tracks it; that is not its PR head.
  const head = tracked && tracked !== base ? tracked : branch;
  if (!repo) return { cwd, repo, branch, isDefault: false, ahead, prs: [], stack: [] };
  // An inactive workspace's pill isn't looked at: follow its branch in the background and leave its stack unread.
  const [own, stack] = await Promise.all([
    follows.branch(repo, head, active ? "visible" : "background"),
    active ? readStack(repo, head, force, follows) : Promise.resolve({ prs: [], stale: false }),
  ]);
  return { cwd, repo, branch, isDefault: false, ahead, prs: own.prs, stack: stack.prs, ...(own.stale || stack.stale ? { stale: true } : {}) };
}

const EdgesSchema = z.array(z.object({ number: z.number(), headRefName: z.string(), baseRefName: z.string(), isCrossRepository: z.boolean() }));

/** The repo's open PRs as head → base edges, from one cheap list. */
async function listOpenEdges(repo: string): Promise<PrEdge[]> {
  const fields = "number,headRefName,baseRefName,isCrossRepository";
  const json = await gh.run(process.cwd(), ["pr", "list", "--repo", repo, "--state", "open", "--limit", "500", "--json", fields]);
  // A fork's branch names say nothing about ours.
  return EdgesSchema.parse(JSON.parse(json))
    .filter((pr) => !pr.isCrossRepository)
    .map((pr) => ({ number: pr.number, head: pr.headRefName, base: pr.baseRefName }));
}

/**
 * Open-PR edges per repo, not per checkout: every worktree of a repo shares one list per TTL, and one call in flight.
 * A forced read shares the call in flight too, since agents going idle together each force one.
 */
export class EdgeCache {
  private readonly entries = new Map<string, { at: number; pending: boolean; value: Promise<PrEdge[]> }>();

  constructor(private readonly list: (repo: string) => Promise<PrEdge[]> = listOpenEdges, private readonly now: () => number = Date.now) {}

  get(repo: string, force = false): Promise<PrEdge[]> {
    const key = repo.toLowerCase();
    const hit = this.entries.get(key);
    if (hit && (hit.pending || (!force && this.now() - hit.at < TTL_MS))) return hit.value;
    const entry = { at: this.now(), pending: true, value: this.list(repo) };
    // A failure is kept for the TTL too, so the worktrees of a repo do not each retry it.
    const settle = () => (entry.pending = false);
    entry.value.then(settle, settle);
    this.entries.set(key, entry);
    return entry.value;
  }
}

const openEdges = new EdgeCache();

/** The open PRs stacked with `head`: the repo's open-PR edges for the walk, the host's PR service for their states. */
async function readStack(repo: string, head: string, force: boolean, follows: PrFollows): Promise<{ prs: Pr[]; stale: boolean }> {
  const edges = await openEdges.get(repo, force).catch((error) => {
    if (!quiet(error)) console.error(`[prs] ${repo} open PRs: ${message(error)}`);
    return null;
  });
  if (!edges) return { prs: [], stale: true };
  const refs = stackOf(head, edges).map((number) => ({ repo, number }));
  if (!refs.length) return { prs: [], stale: false };
  const read = await follows.prs(refs, "background");
  return { prs: refs.flatMap((ref) => read.prs.get(prUrl(ref)) ?? []), stale: read.stale.size > 0 };
}

export interface PrDetails {
  number: number;
  title: string;
  url: string;
  body: string | null;
  baseRefName: string | null;
  headRefName: string | null;
}

/** What a `github_pr` attachment carries, from `gh pr view`. */
export async function readPrDetails(cwd: string, url: string): Promise<PrDetails> {
  const json = JSON.parse(await gh.run(cwd, ["pr", "view", url, "--json", "number,title,url,body,baseRefName,headRefName"]));
  return { body: null, baseRefName: null, headRefName: null, ...json };
}

/** Reads PR state by reference, whatever their repos; a PR the host couldn't read is left out. */
export type PrFetcher = (refs: readonly PrRef[]) => Promise<Map<string, Pr>>;

/** No PR state can be read: no daemon session yet, or a host older than `changeRequests.read`. */
export class PrReadsUnavailable extends Error {}

/**
 * The host holds GitHub reads to stay under the rate limit until `retryAt`. The pause covers every PR on the host, so
 * the caches keep what they have, marked stale, rather than showing PRs as unknown.
 */
export class PrReadsPaused extends Error {
  constructor(readonly retryAt: number | undefined) {
    super(`Paseo paused GitHub reads${retryAt ? ` until ${new Date(retryAt).toISOString()}` : ""}`);
  }
}

/** Expected while GitHub or the host can't be read; the caches serve what they have without logging each read. */
const quiet = (error: unknown) =>
  error instanceof RateLimited || error instanceof PrReadsUnavailable || error instanceof PrReadsPaused;

/**
 * PR state from the host (`paseo.changeRequests.read`), which reads every plugin's PRs through one batched reader with
 * one rate-limit pause. Older hosts lack it: reads fail with `PrReadsUnavailable`, logged once. While the host is
 * paused, reads fail with `PrReadsPaused`, logged once per pause, so the caches keep their last state marked stale.
 */
export function hostPrFetcher(paseo: () => PaseoApi | null): PrFetcher {
  let warned = false;
  // The pause last logged, so a pause is logged once however many reads hit it.
  let loggedPause: number | undefined | null = null;
  return async (refs) => {
    if (!refs.length) return new Map();
    const api = paseo();
    if (!api) throw new PrReadsUnavailable("No daemon session yet");
    if (!api.changeRequests) {
      if (!warned) console.error("[prs] this Paseo can't read pull requests for plugins; update it to see PR state");
      warned = true;
      throw new PrReadsUnavailable("Host lacks changeRequests.read");
    }
    const results = await api.changeRequests.read(refs.map(prUrl));
    const paused = results.find((read) => !read.ok && read.reason === "paused");
    if (paused && !paused.ok) {
      const error = new PrReadsPaused(paused.retryAt);
      if (loggedPause !== paused.retryAt) console.error(`[prs] ${error.message}; showing the last known PR state`);
      loggedPause = paused.retryAt;
      throw error;
    }
    const prs = new Map<string, Pr>();
    // One result per URL, in request order.
    refs.forEach((ref, index) => {
      const read = results[index];
      if (read?.ok) prs.set(prUrl(ref), prOf(read));
    });
    return prs;
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
