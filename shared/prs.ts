import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PrSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  // UNKNOWN: a linked PR GitHub did not return (deleted, renamed repo, no access).
  state: z.enum(["OPEN", "MERGED", "CLOSED", "UNKNOWN"]),
  draft: z.boolean(),
  checks: z.enum(["passing", "failing", "pending", "none"]),
  failing: z.number(),
  review: z.enum(["approved", "changes_requested", "review_required", "none"]),
});
export type Pr = z.infer<typeof PrSchema>;

/** What a working directory's branch has on GitHub. `branch` is null outside a git checkout or on a detached HEAD. */
export const BranchSchema = z.object({
  cwd: z.string(),
  /** `owner/name` of origin on GitHub, null when it is not a GitHub remote. */
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  isDefault: z.boolean(),
  ahead: z.number(),
  prs: z.array(PrSchema),
  /** Open PRs stacked with the branch's: the chain below it and every PR built on top of it. */
  stack: z.array(PrSchema),
});
export type Branch = z.infer<typeof BranchSchema>;

export const WorkspaceLinksSchema = z.object({ workspaceId: z.string(), prs: z.array(PrSchema) });
export type WorkspaceLinks = z.infer<typeof WorkspaceLinksSchema>;

const WorkspaceRefSchema = z.object({ workspaceId: z.string(), cwd: z.string() });

export const listPrs = defineRpc({
  name: "prs.list",
  input: z.object({ workspaces: z.array(WorkspaceRefSchema), force: z.boolean().optional() }),
  output: z.object({ branches: z.array(BranchSchema), links: z.array(WorkspaceLinksSchema) }),
});

const LinkResultSchema = z.object({ linked: z.array(z.string()), errors: z.array(z.string()) });
export type LinkResult = z.infer<typeof LinkResultSchema>;

/** `refs`: PR URLs, `owner/name#123`, or `#123` / `123` in the workspace's repo. */
export const linkPrs = defineRpc({
  name: "prs.link",
  input: WorkspaceRefSchema.extend({ refs: z.array(z.string()) }),
  output: LinkResultSchema,
});

export const unlinkPrs = defineRpc({
  name: "prs.unlink",
  input: WorkspaceRefSchema.extend({ refs: z.array(z.string()) }),
  output: LinkResultSchema,
});

/** Labels on an agent forked into a PR workspace: its source agent, and the PR it focuses on. */
export const FORKED_FROM_LABEL = "prs.forkedFrom";
export const PR_LABEL = "prs.pr";

const ForkInputSchema = z.object({ agentId: z.string(), prUrl: z.string() });
export type ForkInput = z.infer<typeof ForkInputSchema>;
const ForkResultSchema = z.object({ agentId: z.string(), workspaceId: z.string().nullable() });
export type ForkResult = z.infer<typeof ForkResultSchema>;

/** Forks an agent's chat into a new workspace with the PR checked out. */
export const forkPr = defineRpc({ name: "prs.fork", input: ForkInputSchema, output: ForkResultSchema });

export const forkPrompt = (pr: Pick<Pr, "number" | "url">, sourceTitle: string | null) =>
  `Focus only on PR #${pr.number} (${pr.url}). This workspace has it checked out. ` +
  `You were forked from ${sourceTitle ? `the agent "${sourceTitle}"` : "another agent"}, which works on several related PRs; ` +
  `its chat history and the PR are attached. Read them, then say what state the PR is in and wait for instructions.`;

export const CREATE_PR_PROMPT = "Open a pull request for this branch.";
export const fixChecksPrompt = (pr: Pr) => `PR #${pr.number} (${pr.url}) has failing checks. Fix them and push.`;
export const addressReviewPrompt = (pr: Pr) =>
  `PR #${pr.number} (${pr.url}) has changes requested. Address the review comments and push.`;

// gh's statusCheckRollup mixes CheckRun (status + conclusion) and StatusContext (state) entries; GraphQL sends nulls.
const RollupSchema = z.array(
  z.object({ status: z.string().nullish(), conclusion: z.string().nullish(), state: z.string().nullish() }).passthrough(),
);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

export function summarizeChecks(rollup: unknown): Pick<Pr, "checks" | "failing"> {
  const entries = RollupSchema.catch([]).parse(rollup ?? []);
  if (entries.length === 0) return { checks: "none", failing: 0 };
  let failing = 0;
  let pending = 0;
  for (const entry of entries) {
    const result = (entry.conclusion || entry.state || "").toUpperCase();
    const status = (entry.status ?? "").toUpperCase();
    if (FAILED.has(result)) failing++;
    else if (PENDING.has(result) || (status && status !== "COMPLETED")) pending++;
  }
  return { checks: failing ? "failing" : pending ? "pending" : "passing", failing };
}

const GhPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable().optional(),
  statusCheckRollup: z.unknown().optional(),
});
type GhPr = z.infer<typeof GhPrSchema>;

const REVIEWS: Record<string, Pr["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

const toPr = (pr: GhPr): Pr => ({
  number: pr.number,
  title: pr.title,
  url: pr.url,
  state: pr.state,
  draft: pr.isDraft,
  review: REVIEWS[pr.reviewDecision ?? ""] ?? "none",
  ...summarizeChecks(pr.statusCheckRollup),
});

/** Parses `gh pr list --json number,title,url,state,isDraft,reviewDecision,statusCheckRollup`. */
export function parsePrs(json: string): Pr[] {
  return z.array(GhPrSchema).parse(JSON.parse(json)).map(toPr);
}

/** A PR on GitHub, by repository and number. */
export interface PrRef {
  repo: string;
  number: number;
}

export const prUrl = (ref: PrRef) => `https://github.com/${ref.repo}/pull/${ref.number}`;

/**
 * `https://github.com/o/r/pull/12` (any suffix), `o/r#12`, or `#12` / `12` in `defaultRepo`.
 * Null when the input is none of these, or is a bare number with no repo to resolve it in.
 */
export function parsePrRef(input: string, defaultRepo: string | null): PrRef | null {
  const text = input.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(text);
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text);
  const bare = /^#?(\d+)$/.exec(text);
  const [repo, number] = url ? [url[1]!, url[2]!] : short ? [short[1]!, short[2]!] : bare && defaultRepo ? [defaultRepo, bare[1]!] : [];
  if (!repo || !number || Number(number) <= 0) return null;
  return { repo, number: Number(number) };
}

/** `owner/name` from a GitHub remote URL (https, ssh or scp-like); null for other hosts. */
export function parseRemote(remote: string): string | null {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The branch PRs worth showing: every open one; with none open, the latest merged or closed one. */
export function visiblePrs(prs: readonly Pr[]): Pr[] {
  const open = prs.filter((pr) => pr.state === "OPEN").sort((a, b) => a.number - b.number);
  if (open.length) return open;
  const latest = [...prs].sort((a, b) => b.number - a.number)[0];
  return latest ? [latest] : [];
}

/** An open PR as the stack walk sees it: which branch it merges into which. */
export interface PrEdge {
  number: number;
  head: string;
  base: string;
}

/**
 * Numbers of the open PRs stacked with branch `head`: its PR's base PR, that one's base PR and so on
 * (down to a branch with no PR, the default branch), plus every PR based on `head` or on one of those.
 */
export function stackOf(head: string, open: readonly PrEdge[]): number[] {
  const byHead = new Map(open.map((edge) => [edge.head, edge]));
  const found = new Set<number>();
  for (let edge = byHead.get(byHead.get(head)?.base ?? ""); edge && !found.has(edge.number); edge = byHead.get(edge.base)) {
    found.add(edge.number);
  }
  const seen = new Set([head]);
  for (const queue = [head]; queue.length; ) {
    const branch = queue.shift()!;
    for (const edge of open) {
      if (edge.base !== branch || seen.has(edge.head)) continue;
      seen.add(edge.head);
      found.add(edge.number);
      queue.push(edge.head);
    }
  }
  found.delete(byHead.get(head)?.number ?? -1);
  return [...found].sort((a, b) => a - b);
}

/** A PR related to a workspace: on its branch, in its branch's stack, linked to it, or several. */
export type RelatedPr = Pr & { onBranch: boolean; stacked: boolean; linked: boolean };

/** The workspace branch's PRs ∪ its stack ∪ its linked PRs, one row per URL: open first, then by number. */
export function relatedPrs(branch: Branch | undefined, linked: readonly Pr[]): RelatedPr[] {
  const rows = new Map<string, RelatedPr>();
  const add = (pr: Pr, flag: "onBranch" | "stacked" | "linked") =>
    rows.set(pr.url, { ...(rows.get(pr.url) ?? { ...pr, onBranch: false, stacked: false, linked: false }), [flag]: true });
  for (const pr of visiblePrs(branch?.prs ?? [])) add(pr, "onBranch");
  for (const pr of branch?.stack ?? []) add(pr, "stacked");
  for (const pr of linked) add(pr, "linked");
  const rank = (pr: Pr) => (pr.state === "OPEN" ? 0 : 1);
  return [...rows.values()].sort((a, b) => rank(a) - rank(b) || a.number - b.number || a.url.localeCompare(b.url));
}

/** A short status after the PR number: the thing that needs attention first. */
export function prStatus(pr: Pr): string {
  if (pr.state === "UNKNOWN") return "unavailable";
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.checks === "failing") return `${pr.failing} failing`;
  if (pr.review === "changes_requested") return "changes requested";
  if (pr.draft) return "draft";
  if (pr.checks === "pending") return "checks running";
  if (pr.review === "approved") return "approved";
  if (pr.checks === "passing") return "checks pass";
  return "open";
}

export function prIcon(pr: Pr): string {
  if (pr.state === "UNKNOWN") return "CircleHelp";
  if (pr.state === "MERGED") return "GitMerge";
  if (pr.state === "CLOSED") return "GitPullRequestClosed";
  if (pr.checks === "failing") return "CircleX";
  if (pr.draft) return "GitPullRequestDraft";
  if (pr.checks === "pending") return "LoaderCircle";
  return "GitPullRequest";
}

const ROW_CHECKS: Record<Pr["checks"], string> = { passing: "checks pass", failing: "", pending: "checks running", none: "" };
const ROW_REVIEWS: Record<Pr["review"], string> = {
  approved: "approved",
  changes_requested: "changes requested",
  review_required: "review required",
  none: "",
};

/** `draft · 2 failing · changes requested`: state, checks and review, the parts that apply. */
export function rowDetail(pr: Pr): string {
  if (pr.state === "UNKNOWN") return "not found on GitHub";
  if (pr.state !== "OPEN") return pr.state.toLowerCase();
  const checks = pr.checks === "failing" ? `${pr.failing} failing` : ROW_CHECKS[pr.checks];
  return [pr.draft ? "draft" : "", checks, ROW_REVIEWS[pr.review]].filter(Boolean).join(" · ") || "open";
}

/** The one pill an agent gets, as data; the client turns it into a button. */
export type PillSpec =
  | { kind: "prs"; prs: RelatedPr[]; label: string; icon: string }
  | { kind: "create"; label: string; icon: string };

export function pillFor(branch: Branch | undefined, linked: readonly Pr[]): PillSpec | null {
  const prs = relatedPrs(branch, linked);
  if (prs.length === 1) {
    const pr = prs[0]!;
    return { kind: "prs", prs, label: `#${pr.number} · ${prStatus(pr)}`, icon: prIcon(pr) };
  }
  if (prs.length > 1) {
    const failing = prs.filter((pr) => pr.state === "OPEN" && pr.checks === "failing").length;
    return {
      kind: "prs",
      prs,
      label: `PRs · ${prs.length}${failing ? ` · ${failing} failing` : ""}`,
      icon: failing ? "CircleX" : "GitPullRequest",
    };
  }
  // No PR yet: offer one only for a feature branch with commits to propose.
  if (!branch?.branch || branch.isDefault || branch.ahead === 0) return null;
  return { kind: "create", label: "Create PR", icon: "GitPullRequestCreate" };
}

/** An agent as the PR row lookup sees it. */
export interface AgentRef {
  id: string;
  workspaceId: string;
  cwd: string;
  labels: Readonly<Record<string, string>>;
}

/** What a PR row offers besides opening GitHub: fork the chat into a new workspace, or open the one already on it. */
export type RowTarget = { kind: "fork" } | { kind: "open"; agentId: string };

/**
 * A live agent in another workspace that is on this PR: one forked for it, else one whose branch has
 * it open. The PR row offers Open instead of forking a duplicate.
 */
export function prAgentFor(
  prUrl: string,
  agents: readonly AgentRef[],
  branches: ReadonlyMap<string, Branch>,
  exceptWorkspaceId: string,
): AgentRef | null {
  const url = prUrl.toLowerCase();
  const others = agents.filter((agent) => agent.workspaceId !== exceptWorkspaceId);
  return (
    others.find((agent) => agent.labels[PR_LABEL]?.toLowerCase() === url) ??
    others.find((agent) => branches.get(agent.cwd)?.prs.some((pr) => pr.state === "OPEN" && pr.url.toLowerCase() === url)) ??
    null
  );
}

/** A PR can be checked out into a new worktree only from a checkout of its own repo, and only while open. */
export function canFork(pr: RelatedPr, workspaceRepo: string | null): boolean {
  if (pr.state !== "OPEN" || !workspaceRepo) return false;
  return parsePrRef(pr.url, null)?.repo.toLowerCase() === workspaceRepo.toLowerCase();
}

/** A fork's report to its main chat: written by the fork agent only after the human clicks Done. */
export const ReportStateSchema = z.object({
  /** Reports sent so far; the next one after the first is an update. */
  sent: z.number(),
  state: z.enum(["writing", "sent", "failed"]),
  error: z.string().optional(),
  at: z.string(),
});
export type ReportState = z.infer<typeof ReportStateSchema>;

const ReportInputSchema = z.object({ agentId: z.string(), note: z.string().optional(), archive: z.boolean().optional() });
export type ReportInput = z.infer<typeof ReportInputSchema>;

/** Asks a fork agent to write its final report; the plugin forwards the reply to the main chat. */
export const reportPr = defineRpc({ name: "prs.report", input: ReportInputSchema, output: ReportStateSchema });

/** Report states of the given agents, those that have one. */
export const listReports = defineRpc({
  name: "prs.reports",
  input: z.object({ agentIds: z.array(z.string()) }),
  output: z.object({ reports: z.record(z.string(), ReportStateSchema) }),
});

export const reportPrompt = (pr: Pick<Pr, "number" | "url">, note: string | undefined, update: boolean) =>
  [
    `The human is done with PR #${pr.number} (${pr.url}) here${update ? " again, after an earlier report" : ""}. Push anything that is not pushed yet.`,
    `Then reply with a final ${update ? "update" : "report"} for the main agent you were forked from: what was decided, the commits you pushed (short SHAs), what is left, and what the main agent must do next (for example, rebase the PRs stacked on this one).`,
    `Reply with the report only, a few short lines; it is forwarded to the main agent verbatim. Do not send it yourself.`,
    note?.trim() ? `\nThe human's note: ${note.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");

export const reportMessage = (pr: Pick<Pr, "number" | "title">, summary: string, update: boolean) =>
  `[prs] #${pr.number} (${pr.title})${update ? " update" : ""}: ${summary.trim()}`;

/** The fork's report pill: highlighted when its PR is merged or closed, so the human decides whether to finish. */
export function reportPillFor(pr: Pick<Pr, "state"> | undefined): { label: string; icon: string; title: string } {
  if (pr?.state === "MERGED") return { label: "PR merged — report & finish?", icon: "GitMerge", title: "The PR is merged: report to the main chat" };
  if (pr?.state === "CLOSED") return { label: "PR closed — report & finish?", icon: "GitPullRequestClosed", title: "The PR is closed: report to the main chat" };
  return { label: "Report to main", icon: "Undo2", title: "Report to the main chat" };
}

/** The report button: Done the first time, an update after that; disabled while the fork works or writes. */
export function reportButton(report: ReportState | undefined, running: boolean): { label: string; disabled: boolean } {
  if (report?.state === "writing") return { label: "Writing the report…", disabled: true };
  return { label: report?.sent ? "↩ Send update to main chat" : "↩ Done, report to main chat", disabled: running };
}
