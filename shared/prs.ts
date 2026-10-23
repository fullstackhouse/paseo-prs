import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PrSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  draft: z.boolean(),
  checks: z.enum(["passing", "failing", "pending", "none"]),
  failing: z.number(),
  review: z.enum(["approved", "changes_requested", "review_required", "none"]),
});
export type Pr = z.infer<typeof PrSchema>;

/** What a working directory's branch has on GitHub. `branch` is null outside a git checkout or on a detached HEAD. */
export const BranchSchema = z.object({
  cwd: z.string(),
  branch: z.string().nullable(),
  isDefault: z.boolean(),
  ahead: z.number(),
  prs: z.array(PrSchema),
});
export type Branch = z.infer<typeof BranchSchema>;

export const listBranches = defineRpc({
  name: "prs.list",
  input: z.object({ cwds: z.array(z.string()), force: z.boolean().optional() }),
  output: z.object({ branches: z.array(BranchSchema) }),
});

/** Above this many PRs the agent gets one "N PRs" pill instead of one pill each. */
export const MAX_PILLS = 3;

export const CREATE_PR_PROMPT = "Open a pull request for this branch.";
export const fixChecksPrompt = (pr: Pr) => `PR #${pr.number} (${pr.url}) has failing checks. Fix them and push.`;
export const addressReviewPrompt = (pr: Pr) =>
  `PR #${pr.number} (${pr.url}) has changes requested. Address the review comments and push.`;

// gh's statusCheckRollup mixes CheckRun (status + conclusion) and StatusContext (state) entries.
const RollupSchema = z.array(
  z.object({ status: z.string().optional(), conclusion: z.string().optional(), state: z.string().optional() }).passthrough(),
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

const REVIEWS: Record<string, Pr["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

/** Parses `gh pr list --json number,title,url,state,isDraft,reviewDecision,statusCheckRollup`. */
export function parsePrs(json: string): Pr[] {
  return z
    .array(GhPrSchema)
    .parse(JSON.parse(json))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      draft: pr.isDraft,
      review: REVIEWS[pr.reviewDecision ?? ""] ?? "none",
      ...summarizeChecks(pr.statusCheckRollup),
    }));
}

/** The PRs worth showing: every open one; with none open, the latest merged or closed one. */
export function visiblePrs(prs: readonly Pr[]): Pr[] {
  const open = prs.filter((pr) => pr.state === "OPEN").sort((a, b) => a.number - b.number);
  if (open.length) return open;
  const latest = [...prs].sort((a, b) => b.number - a.number)[0];
  return latest ? [latest] : [];
}

/** A short status after the PR number: the thing that needs attention first. */
export function prStatus(pr: Pr): string {
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
  if (pr.state === "MERGED") return "GitMerge";
  if (pr.state === "CLOSED") return "GitPullRequestClosed";
  if (pr.checks === "failing") return "CircleX";
  if (pr.draft) return "GitPullRequestDraft";
  if (pr.checks === "pending") return "LoaderCircle";
  return "GitPullRequest";
}

/** The pills an agent gets for its branch, as data; the client turns them into buttons. */
export type PillSpec =
  | { key: string; kind: "pr"; pr: Pr; label: string; icon: string }
  | { key: "many"; kind: "many"; prs: Pr[]; label: string; icon: string }
  | { key: "create"; kind: "create"; label: string; icon: string };

export function pillsFor(branch: Branch | undefined): PillSpec[] {
  if (!branch?.branch) return [];
  const prs = visiblePrs(branch.prs);
  if (prs.length > MAX_PILLS) {
    const failing = prs.filter((pr) => pr.checks === "failing").length;
    return [
      {
        key: "many",
        kind: "many",
        prs,
        label: `${prs.length} PRs${failing ? ` · ${failing} failing` : ""}`,
        icon: failing ? "CircleX" : "GitPullRequest",
      },
    ];
  }
  if (prs.length) {
    return prs.map((pr) => ({ key: `pr-${pr.number}`, kind: "pr", pr, label: `#${pr.number} · ${prStatus(pr)}`, icon: prIcon(pr) }));
  }
  // No PR yet: offer one only for a feature branch with commits to propose.
  if (branch.isDefault || branch.ahead === 0) return [];
  return [{ key: "create", kind: "create", label: "Create PR", icon: "GitPullRequestCreate" }];
}
