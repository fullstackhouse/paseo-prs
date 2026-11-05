import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { linkedPrsQuery, parseLinkedPrs } from "./graphql";
import { z } from "zod";
import { parsePrs, parseRemote, prUrl, stackOf, type Branch, type Pr, type PrEdge, type PrRef } from "../shared/prs";

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

// Clients poll every 60 s; a read they did not force is served from cache for two polls.
const TTL_MS = 120_000;
// A merged or closed PR changes only when someone reopens it, which a forced read picks up sooner.
const TERMINAL_TTL_MS = 60 * 60_000;

const terminal = (pr: Pr) => pr.state === "MERGED" || pr.state === "CLOSED";

/** origin's default branch, from the remote HEAD git recorded at clone time; "main" when it never did. */
async function defaultBranch(cwd: string): Promise<string> {
  const ref = await git(cwd, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").catch(() => "");
  return ref.replace(/^refs\/remotes\/origin\//, "") || "main";
}

/** `owner/name` of the checkout's origin, null outside git or for a non-GitHub remote. */
export async function readRepo(cwd: string): Promise<string | null> {
  return parseRemote(await git(cwd, "remote", "get-url", "origin").catch(() => ""));
}

const PR_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup";

const noBranch = (cwd: string, repo: string | null = null): Branch => ({ cwd, repo, branch: null, isDefault: false, ahead: 0, prs: [], stack: [] });

export async function readBranch(cwd: string, force = false): Promise<Branch> {
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
  const [prs, stack] = await Promise.all([
    gh.run(cwd, ["pr", "list", "--head", head, "--state", "all", "--limit", "20", "--json", PR_FIELDS]).then(parsePrs),
    repo ? readStack(repo, head, force) : [],
  ]);
  return { cwd, repo, branch, isDefault: false, ahead, prs, stack };
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

/** The open PRs stacked with `head`: the repo's open-PR edges for the walk, one batch for their states. */
async function readStack(repo: string, head: string, force: boolean): Promise<Pr[]> {
  const refs = stackOf(head, await openEdges.get(repo, force)).map((number) => ({ repo, number }));
  const fetched = await ghPrFetcher(refs);
  return refs.flatMap((ref) => fetched.get(prUrl(ref)) ?? []);
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

/** Which branch the checkout is on and what it tracks, from git alone. */
export async function readCheckout(cwd: string): Promise<string> {
  const [branch, upstream] = await Promise.all([
    git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => ""),
    git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").catch(() => ""),
  ]);
  return `${branch} ${upstream}`;
}

/**
 * Reads per working directory, shared by every client and agent in it, at most once per TTL unless forced. A branch whose
 * PRs are all merged or closed, with no stack, keeps for TERMINAL_TTL_MS while the checkout stays on it. A failed read
 * serves the previous one.
 */
export class BranchCache {
  private readonly entries = new Map<string, { at: number; ttl: number; checkout: Promise<string>; value: Promise<Branch> }>();

  constructor(
    private readonly read: (cwd: string, force: boolean) => Promise<Branch> = readBranch,
    private readonly now: () => number = Date.now,
    private readonly checkout: (cwd: string) => Promise<string> = readCheckout,
  ) {}

  async get(cwd: string, force = false): Promise<Branch> {
    const hit = this.entries.get(cwd);
    if (hit && !force) {
      const age = this.now() - hit.at;
      if (age < TTL_MS) return hit.value;
      // Past the short TTL only a merged branch's snapshot is left, and it only holds while git is still on that branch.
      if (age < hit.ttl && (await hit.checkout) === (await this.checkout(cwd))) return hit.value;
      // Another read replaced the entry while git answered.
      const current = this.entries.get(cwd);
      if (current && current !== hit) return current.value;
    }
    const entry = { at: this.now(), ttl: TTL_MS, checkout: this.checkout(cwd), value: Promise.resolve(noBranch(cwd)) };
    entry.value = this.read(cwd, force).then(
      (branch) => {
        if (branch.prs.length && !branch.stack.length && branch.prs.every(terminal)) entry.ttl = TERMINAL_TTL_MS;
        return branch;
      },
      (error) => {
        if (!(error instanceof RateLimited)) console.error(`[prs] ${cwd}: ${message(error)}`);
        return hit?.value ?? noBranch(cwd);
      },
    );
    this.entries.set(cwd, entry);
    return entry.value;
  }
}

/** Fetches PRs by reference: one `gh api graphql` call for all of them, whatever their repos. */
export type PrFetcher = (refs: readonly PrRef[]) => Promise<Map<string, Pr>>;

export const ghPrFetcher: PrFetcher = async (refs) => {
  if (!refs.length) return new Map();
  const { query, aliases } = linkedPrsQuery(refs);
  // gh exits non-zero when any alias fails (a deleted PR), but still prints the data it has.
  const stdout = await gh.run(process.cwd(), ["api", "graphql", "-f", `query=${query}`]).catch((error: { stdout?: string }) => {
    if (error.stdout) return error.stdout;
    throw error;
  });
  return parseLinkedPrs(stdout, aliases);
};

/** Linked PR states by URL, at most once per TTL each (TERMINAL_TTL_MS once merged or closed); a batch fetches only what is missing or stale. */
export class PrCache {
  private readonly entries = new Map<string, { at: number; pr: Pr }>();

  constructor(private readonly fetch: PrFetcher = ghPrFetcher, private readonly now: () => number = Date.now) {}

  async get(refs: readonly PrRef[], force = false): Promise<Map<string, Pr>> {
    const stale = refs.filter((ref) => {
      const hit = this.entries.get(prUrl(ref));
      return force || !hit || this.now() - hit.at >= (terminal(hit.pr) ? TERMINAL_TTL_MS : TTL_MS);
    });
    if (stale.length) {
      const fetched = await this.fetch(stale).catch((error) => {
        if (!(error instanceof RateLimited)) console.error(`[prs] linked PRs: ${message(error)}`);
        return null;
      });
      // A failed call keeps what we had; a PR GitHub did not return shows as unavailable.
      if (fetched) {
        const at = this.now();
        for (const ref of stale) this.entries.set(prUrl(ref), { at, pr: fetched.get(prUrl(ref)) ?? unavailable(ref) });
      }
    }
    return new Map(refs.map((ref) => [prUrl(ref), this.entries.get(prUrl(ref))?.pr ?? unavailable(ref)]));
  }
}

const unavailable = (ref: PrRef): Pr => ({
  number: ref.number,
  title: `${ref.repo}#${ref.number}`,
  url: prUrl(ref),
  state: "UNKNOWN",
  draft: false,
  checks: "none",
  failing: 0,
  review: "none",
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
