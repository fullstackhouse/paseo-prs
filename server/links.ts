import { parsePrRef, prStatus, prUrl as url, type LinkResult, type Pr, type PrRef, type WorkspaceLinks } from "../shared/prs";
import { readRepo, type PrCache } from "./github";
import type { LinkStore } from "./store";

export interface WorkspaceRef {
  workspaceId: string;
  cwd: string;
}

/** Linking and unlinking PRs to workspaces, shared by the UI's RPCs and the agents' MCP tools. */
export class Links {
  constructor(
    private readonly store: LinkStore,
    private readonly prs: PrCache,
    private readonly repoOf: (cwd: string) => Promise<string | null> = readRepo,
  ) {}

  /** Each workspace's linked PRs, fetched in one batch across workspaces. */
  async list(workspaceIds: readonly string[], force = false): Promise<WorkspaceLinks[]> {
    const refs = workspaceIds.map((workspaceId) => ({ workspaceId, refs: this.store.list(workspaceId) }));
    const prs = await this.prs.get(dedupe(refs.flatMap((entry) => entry.refs)), force);
    return refs.map(({ workspaceId, refs }) => ({
      workspaceId,
      prs: refs.map((ref) => prs.get(url(ref))).filter((pr): pr is Pr => Boolean(pr)),
    }));
  }

  /** Links PRs that exist on GitHub, stored under GitHub's spelling of the repo. */
  async link({ workspaceId, cwd }: WorkspaceRef, inputs: readonly string[]): Promise<LinkResult> {
    const { refs, errors } = await this.parse(cwd, inputs);
    const found = await this.prs.get(refs, true);
    const valid: PrRef[] = [];
    for (const ref of refs) {
      const pr = found.get(url(ref));
      if (!pr || pr.state === "UNKNOWN") errors.push(`${ref.repo}#${ref.number}: not found on GitHub (or gh cannot read it)`);
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
