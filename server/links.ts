import { parsePrRef, prStatus, prUrl as url, type LinkResult, type Pr, type PrRef, type WorkspaceLinks } from "../shared/prs";
import type { PrFollows } from "./follows";
import { readRepo, type PrFetcher } from "./github";
import type { LinkStore } from "./store";

export interface WorkspaceRef {
  workspaceId: string;
  cwd: string;
}

/** Linking and unlinking PRs to workspaces, shared by the UI's RPCs and the agents' MCP tools. */
export class Links {
  constructor(
    private readonly store: LinkStore,
    private readonly follows: PrFollows,
    /** One-shot reads, to check a PR exists before linking it. */
    private readonly fetch: PrFetcher,
    private readonly repoOf: (cwd: string) => Promise<string | null> = readRepo,
  ) {}

  /** Each workspace's linked PRs, as the host's PR service last pushed them (shown on the pill, so followed as visible). */
  async list(workspaceIds: readonly string[]): Promise<WorkspaceLinks[]> {
    const refs = workspaceIds.map((workspaceId) => ({ workspaceId, refs: this.store.list(workspaceId) }));
    const { prs, stale } = await this.follows.prs(dedupe(refs.flatMap((entry) => entry.refs)), "visible");
    return refs.map(({ workspaceId, refs }) => ({
      workspaceId,
      prs: refs.map((ref) => prs.get(url(ref))).filter((pr): pr is Pr => Boolean(pr)),
      ...(refs.some((ref) => stale.has(url(ref))) ? { stale: true } : {}),
    }));
  }

  /**
   * Links PRs that exist on GitHub, stored under GitHub's spelling of the repo. A PR that can't be read right now
   * (Paseo paused GitHub reads, or the host is unreachable) is linked as given and shows stale until the next read:
   * agents link PRs they just opened, and auto-link has no second chance, so rejecting it would lose the link.
   */
  async link({ workspaceId, cwd }: WorkspaceRef, inputs: readonly string[]): Promise<LinkResult> {
    const { refs, errors } = await this.parse(cwd, inputs);
    // null: nothing could be read (paused or unreachable), so every PR is linked as given.
    const found = refs.length ? await this.fetch(refs).catch(() => null) : new Map<string, Pr>();
    const valid: PrRef[] = [];
    for (const ref of refs) {
      const pr = found?.get(url(ref));
      if (!found) valid.push(ref);
      else if (!pr) errors.push(`${ref.repo}#${ref.number}: not found on GitHub (or Paseo cannot read it)`);
      else valid.push(canonical(pr) ?? ref);
    }
    this.store.link(workspaceId, valid);
    return { linked: valid.map(url), errors };
  }

  async unlink({ workspaceId, cwd }: WorkspaceRef, inputs: readonly string[]): Promise<LinkResult> {
    const { refs, errors } = await this.parse(cwd, inputs);
    const removed = this.store.unlink(workspaceId, refs);
    const gone = new Set(removed.map((ref) => url(ref).toLowerCase()));
    for (const ref of refs) if (!gone.has(url(ref).toLowerCase())) errors.push(`${ref.repo}#${ref.number} was not linked`);
    return { linked: removed.map(url), errors };
  }

  /** The workspace's linked PRs as text, for an agent. */
  async describe(workspaceId: string): Promise<string> {
    const [entry] = await this.list([workspaceId]);
    if (!entry?.prs.length) return "No PRs are linked to this workspace.";
    return entry.prs.map((pr) => `#${pr.number} ${prStatus(pr)}: ${pr.title} (${pr.url})`).join("\n");
  }

  private async parse(cwd: string, inputs: readonly string[]): Promise<{ refs: PrRef[]; errors: string[] }> {
    const repo = inputs.some((input) => /^#?\d+$/.test(input.trim())) ? await this.repoOf(cwd) : null;
    const refs: PrRef[] = [];
    const errors: string[] = [];
    for (const input of inputs.flatMap((value) => value.split(/[\s,]+/)).filter(Boolean)) {
      const ref = parsePrRef(input, repo);
      if (ref) refs.push(ref);
      else errors.push(/^#?\d+$/.test(input) ? `${input}: this workspace has no GitHub remote; use a PR URL` : `${input}: not a PR URL or #number`);
    }
    return { refs: dedupe(refs), errors };
  }
}

function canonical(pr: Pr): PrRef | null {
  return parsePrRef(pr.url, null);
}

function dedupe(refs: readonly PrRef[]): PrRef[] {
  const seen = new Map<string, PrRef>();
  for (const ref of refs) seen.set(url(ref).toLowerCase(), ref);
  return [...seen.values()];
}
