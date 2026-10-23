import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parsePrs, type Branch } from "../shared/prs";

const exec = promisify(execFile);

// The plugin subprocess may start without the user's shell PATH; Homebrew installs gh and git here.
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");

async function run(cwd: string, command: string, args: string[]): Promise<string> {
  const { stdout } = await exec(command, args, { cwd, timeout: 20_000, env: { ...process.env, PATH } });
  return stdout.trim();
}

const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);

/** origin's default branch, from the remote HEAD git recorded at clone time; "main" when it never did. */
async function defaultBranch(cwd: string): Promise<string> {
  const ref = await git(cwd, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").catch(() => "");
  return ref.replace(/^refs\/remotes\/origin\//, "") || "main";
}

const PR_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup";

export async function readBranch(cwd: string): Promise<Branch> {
  const none: Branch = { cwd, branch: null, isDefault: false, ahead: 0, prs: [] };
  const branch = await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
  if (!branch) return none;
  const base = await defaultBranch(cwd);
  if (branch === base) return { ...none, branch, isDefault: true };
  const ahead = Number(await git(cwd, "rev-list", "--count", `origin/${base}..HEAD`).catch(() => "0")) || 0;
  const prs = parsePrs(await run(cwd, "gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "20", "--json", PR_FIELDS]));
  return { cwd, branch, isDefault: false, ahead, prs };
}

const TTL_MS = 30_000;

/** Reads per working directory, shared by every client and agent in it, at most once per TTL unless forced. */
export class BranchCache {
  private readonly entries = new Map<string, { at: number; value: Promise<Branch> }>();

  get(cwd: string, force = false): Promise<Branch> {
    const hit = this.entries.get(cwd);
    if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = readBranch(cwd).catch((error) => {
      console.error(`[prs] ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
      return { cwd, branch: null, isDefault: false, ahead: 0, prs: [] };
    });
    this.entries.set(cwd, { at: Date.now(), value });
    return value;
  }
}
