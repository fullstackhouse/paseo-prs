import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { linkedPrsQuery, parseLinkedPrs } from "./graphql";
import { z } from "zod";
import { parsePrs, parseRemote, prUrl, stackOf, type Branch, type Pr, type PrRef } from "../shared/prs";

const exec = promisify(execFile);

// The plugin subprocess may start without the user's shell PATH; Homebrew installs gh and git here.
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");

async function run(cwd: string, command: string, args: string[]): Promise<string> {
  const { stdout } = await exec(command, args, { cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH } });
  return stdout.trim();
}

const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);

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

export async function readBranch(cwd: string): Promise<Branch> {
  const repo = await readRepo(cwd);
  const none: Branch = { cwd, repo, branch: null, isDefault: false, ahead: 0, prs: [], stack: [] };
  const branch = await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
  if (!branch) return none;
  const base = await defaultBranch(cwd);
  if (branch === base) return { ...none, branch, isDefault: true };
  const ahead = Number(await git(cwd, "rev-list", "--count", `origin/${base}..HEAD`).catch(() => "0")) || 0;
  const [prs, stack] = await Promise.all([
    run(cwd, "gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "20", "--json", PR_FIELDS]).then(parsePrs),
    repo ? readStack(cwd, repo, branch) : [],
  ]);
  return { cwd, repo, branch, isDefault: false, ahead, prs, stack };
}

const EdgesSchema = z.array(z.object({ number: z.number(), headRefName: z.string(), baseRefName: z.string(), isCrossRepository: z.boolean() }));

/** The open PRs stacked with `head`: one cheap list of the repo's open PRs for the walk, one batch for their states. */
async function readStack(cwd: string, repo: string, head: string): Promise<Pr[]> {
  const json = await run(cwd, "gh", ["pr", "list", "--state", "open", "--limit", "500", "--json", "number,headRefName,baseRefName,isCrossRepository"]);
  // A fork's branch names say nothing about ours.
  const edges = EdgesSchema.parse(JSON.parse(json))
    .filter((pr) => !pr.isCrossRepository)
    .map((pr) => ({ number: pr.number, head: pr.headRefName, base: pr.baseRefName }));
  const refs = stackOf(head, edges).map((number) => ({ repo, number }));
  const fetched = await ghPrFetcher(refs);
  return refs.flatMap((ref) => fetched.get(prUrl(ref)) ?? []);
}

const TTL_MS = 30_000;

/** Reads per working directory, shared by every client and agent in it, at most once per TTL unless forced. */
export class BranchCache {
  private readonly entries = new Map<string, { at: number; value: Promise<Branch> }>();

  get(cwd: string, force = false): Promise<Branch> {
    const hit = this.entries.get(cwd);
    if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = readBranch(cwd).catch((error) => {
      console.error(`[prs] ${cwd}: ${message(error)}`);
      return { cwd, repo: null, branch: null, isDefault: false, ahead: 0, prs: [], stack: [] };
    });
    this.entries.set(cwd, { at: Date.now(), value });
    return value;
  }
}

/** Fetches PRs by reference: one `gh api graphql` call for all of them, whatever their repos. */
export type PrFetcher = (refs: readonly PrRef[]) => Promise<Map<string, Pr>>;

export const ghPrFetcher: PrFetcher = async (refs) => {
  if (!refs.length) return new Map();
  const { query, aliases } = linkedPrsQuery(refs);
  // gh exits non-zero when any alias fails (a deleted PR), but still prints the data it has.
  const stdout = await run(process.cwd(), "gh", ["api", "graphql", "-f", `query=${query}`]).catch((error: { stdout?: string }) => {
    if (error.stdout) return error.stdout;
    throw error;
  });
  return parseLinkedPrs(stdout, aliases);
};

/** Linked PR states by URL, at most once per TTL each; a batch fetches only what is missing or stale. */
export class PrCache {
  private readonly entries = new Map<string, { at: number; pr: Pr }>();

  constructor(private readonly fetch: PrFetcher = ghPrFetcher, private readonly now: () => number = Date.now) {}

  async get(refs: readonly PrRef[], force = false): Promise<Map<string, Pr>> {
    const stale = refs.filter((ref) => {
      const hit = this.entries.get(prUrl(ref));
      return force || !hit || this.now() - hit.at >= TTL_MS;
    });
    if (stale.length) {
      const fetched = await this.fetch(stale).catch((error) => {
        console.error(`[prs] linked PRs: ${message(error)}`);
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
