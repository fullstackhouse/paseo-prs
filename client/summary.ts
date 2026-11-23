import type { PluginClientContext } from "@getpaseo/plugin/client";
import { parsePrRef, prStatus, relatedPrs, type Branch, type Pr } from "../shared/prs";

// COMPAT(workspaceSummaryItem): FSH hosts from fullstackhouse/paseo#83 have addWorkspaceSummaryItem, and FSH hosts with
// the Overview's Pull requests section read `pullRequests`, but the npm SDK pin types neither yet. Older hosts lack the
// item (the pill still shows the PRs) or drop `pullRequests`; `entries: []` makes those that read `entries` count the
// item as a source of moves with nothing waiting, which shows nothing, instead of a blank fact line. Never set `status`.
/** One pull request on the host's Overview, as `PluginWorkspacePullRequest`. */
export interface OverviewPr {
  /** The PR's URL. */
  id: string;
  number: number;
  title: string;
  url: string;
  /** The repository's name, only for a PR outside the workspace's repository. */
  repo?: string;
  state: "open" | "draft" | "merged" | "closed";
  /** The most urgent fact, as the pill shows it; the host shows the state when omitted. */
  facts?: string;
  tone?: "success" | "warning" | "danger" | "muted";
}
export interface WorkspaceSummaryState {
  /** Always empty: PRs are listed for information, never as a move. */
  entries: [];
  pullRequests?: OverviewPr[];
  /** True while GitHub couldn't be refreshed; `pullRequests` is the last list. */
  pullRequestsStale?: boolean;
}
export interface WorkspaceSummaryRegistration {
  update(patch: WorkspaceSummaryState): void;
  remove(): void;
}
type SummaryHost = {
  addWorkspaceSummaryItem?: (
    contribution: WorkspaceSummaryState & { id: string; workspaceId: string; title: string },
  ) => WorkspaceSummaryRegistration;
};

const TONES: Record<string, OverviewPr["tone"]> = {
  "changes requested": "danger",
  "checks running": "warning",
  approved: "success",
  "checks pass": "success",
};

/** A related PR as an Overview row: the pill's most urgent fact, and the repo's name only when it isn't the workspace's. */
export function overviewPr(pr: Pr, workspaceRepo: string | null): OverviewPr {
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.draft ? "draft" : "open";
  const facts = prStatus(pr);
  const repo = parsePrRef(pr.url, null)?.repo;
  const foreign = repo && repo.toLowerCase() !== workspaceRepo?.toLowerCase();
  return {
    id: pr.url,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    ...(foreign ? { repo: repo.split("/")[1] } : {}),
    state,
    // "open" says nothing the state doesn't.
    ...(facts === "open" ? {} : { facts }),
    tone: pr.state === "OPEN" && pr.checks === "failing" ? "danger" : (TONES[facts] ?? "muted"),
  };
}

/** The host keeps at most this many PRs per workspace. */
export const MAX_OVERVIEW_PRS = 50;

/**
 * The summary item's state: every PR related to the workspace (branch, stack, linked), in the pill's order (open first),
 * up to the host's cap.
 */
export function summaryState(branch: Branch | undefined, linked: readonly Pr[], stale: boolean): WorkspaceSummaryState {
  return {
    entries: [],
    pullRequests: relatedPrs(branch, linked)
      .filter((pr) => Number.isInteger(pr.number) && pr.number > 0)
      .slice(0, MAX_OVERVIEW_PRS)
      .map((pr) => overviewPr(pr, branch?.repo ?? null)),
    pullRequestsStale: stale,
  };
}

/** Tells the host which PRs each workspace's work lives in, for the Overview's Pull requests section. */
export function createWorkspaceSummaries(client: PluginClientContext) {
  const host = client as PluginClientContext & SummaryHost;
  const items = new Map<string, { registration: WorkspaceSummaryRegistration; json: string }>();
  return {
    set(workspaceId: string, state: WorkspaceSummaryState) {
      if (!host.addWorkspaceSummaryItem) return;
      const json = JSON.stringify(state);
      const item = items.get(workspaceId);
      if (item?.json === json) return;
      if (item) {
        item.registration.update(state);
        item.json = json;
      } else {
        // No `needsYou`, `status` or entries: PRs are listed for information, never as a move.
        const registration = host.addWorkspaceSummaryItem({ id: "prs", workspaceId, title: "Pull requests", ...state });
        items.set(workspaceId, { registration, json });
      }
    },
    remove(workspaceId: string) {
      items.get(workspaceId)?.registration.remove();
      items.delete(workspaceId);
    },
    workspaceIds(): string[] {
      return [...items.keys()];
    },
    clear() {
      for (const item of items.values()) item.registration.remove();
      items.clear();
    },
  };
}
