import { describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createWorkspaceSummaries, overviewPr, summaryState } from "../client/summary";
import type { Branch, Pr } from "../shared/prs";

const pr = (overrides: Partial<Pr> = {}): Pr => ({
  number: 1,
  title: "feat: thing",
  url: `https://github.com/o/r/pull/${overrides.number ?? 1}`,
  state: "OPEN",
  draft: false,
  checks: "passing",
  failing: 0,
  review: "none",
  ...overrides,
});

const branch = (overrides: Partial<Branch> = {}): Branch => ({
  cwd: "/w",
  repo: "o/r",
  branch: "feat/x",
  isDefault: false,
  ahead: 1,
  prs: [],
  stack: [],
  ...overrides,
});

describe("overviewPr", () => {
  it("carries the pill's most urgent fact, with a tone", () => {
    const cases = [
      [pr({ checks: "failing", failing: 2, review: "changes_requested" }), "2 failing", "danger"],
      [pr({ review: "changes_requested" }), "changes requested", "danger"],
      [pr({ checks: "pending" }), "checks running", "warning"],
      [pr({ review: "approved", checks: "pending" }), "checks running", "warning"],
      [pr({ review: "approved" }), "approved", "success"],
      [pr({ checks: "passing" }), "checks pass", "success"],
      [pr({ draft: true, checks: "passing" }), "draft", "muted"],
      [pr({ state: "MERGED" }), "merged", "muted"],
    ] as const;
    for (const [input, facts, tone] of cases) expect(overviewPr(input, "o/r")).toMatchObject({ facts, tone });
  });

  it("leaves the facts out when the state says it all", () => {
    const row = overviewPr(pr({ checks: "none" }), "o/r");
    expect(row).toEqual({ id: row.url, number: 1, title: "feat: thing", url: "https://github.com/o/r/pull/1", state: "open", tone: "muted" });
  });

  it("maps states, a draft's included", () => {
    expect(overviewPr(pr(), "o/r").state).toBe("open");
    expect(overviewPr(pr({ draft: true, checks: "failing", failing: 1 }), "o/r")).toMatchObject({ state: "draft", facts: "1 failing", tone: "danger" });
    expect(overviewPr(pr({ state: "MERGED", draft: true }), "o/r").state).toBe("merged");
    expect(overviewPr(pr({ state: "CLOSED" }), "o/r")).toMatchObject({ state: "closed", facts: "closed", tone: "muted" });
    expect(overviewPr(pr({ state: "UNKNOWN" }), "o/r")).toMatchObject({ state: "open", facts: "unavailable", tone: "muted" });
  });

  it("names the repo only for a PR outside the workspace's repository", () => {
    expect(overviewPr(pr(), "O/R")).not.toHaveProperty("repo");
    expect(overviewPr(pr({ url: "https://github.com/o/other/pull/58", number: 58 }), "o/r").repo).toBe("other");
    expect(overviewPr(pr({ url: "https://github.com/x/r/pull/3", number: 3 }), "o/r").repo).toBe("r");
    expect(overviewPr(pr(), null).repo).toBe("r");
  });
});

describe("summaryState", () => {
  it("lists every related PR: the branch's, its stack and linked ones, open first", () => {
    const state = summaryState(
      branch({ prs: [pr({ number: 5 })], stack: [pr({ number: 4 })] }),
      [pr({ number: 1, state: "MERGED" }), pr({ number: 9, url: "https://github.com/o/lib/pull/9" })],
      false,
    );
    expect(state.pullRequests?.map((row) => [row.number, row.repo ?? null])).toEqual([[4, null], [5, null], [9, "lib"], [1, null]]);
    expect(state.pullRequestsStale).toBe(false);
  });

  it("is an empty list for a workspace without PRs, and carries the stale flag", () => {
    expect(summaryState(branch(), [], true)).toEqual({ entries: [], pullRequests: [], pullRequestsStale: true });
  });

  it("sends only positive integer numbers, at most the host's 50, open ones kept first", () => {
    const merged = Array.from({ length: 60 }, (_, i) => pr({ number: i + 100, state: "MERGED" }));
    const state = summaryState(branch({ prs: [pr({ number: 0 }), pr({ number: 7 })] }), [...merged, pr({ number: 2.5 })], false);
    expect(state.pullRequests).toHaveLength(50);
    expect(state.pullRequests?.[0]?.number).toBe(7);
    expect(state.pullRequests?.every((row) => Number.isInteger(row.number) && row.number > 0)).toBe(true);
  });
});

describe("createWorkspaceSummaries", () => {
  it("adds one informational item per workspace, updates it on change only, and is a no-op on older hosts", () => {
    const update = vi.fn();
    const remove = vi.fn();
    const addWorkspaceSummaryItem = vi.fn((_contribution: Record<string, unknown>) => ({ update, remove }));
    const summaries = createWorkspaceSummaries({ addWorkspaceSummaryItem } as unknown as PluginClientContext);
    const state = summaryState(branch({ prs: [pr()] }), [], false);

    summaries.set("w1", state);
    summaries.set("w1", summaryState(branch({ prs: [pr()] }), [], false));
    expect(addWorkspaceSummaryItem).toHaveBeenCalledWith({ id: "prs", workspaceId: "w1", title: "Pull requests", ...state });
    const item = addWorkspaceSummaryItem.mock.calls[0]![0];
    expect(item.entries).toEqual([]);
    expect(item).not.toHaveProperty("needsYou");
    expect(item).not.toHaveProperty("status");
    expect(update).not.toHaveBeenCalled();

    summaries.set("w1", { ...state, pullRequestsStale: true });
    expect(update).toHaveBeenCalledWith({ ...state, pullRequestsStale: true });
    summaries.remove("w1");
    expect(remove).toHaveBeenCalled();
    expect(summaries.workspaceIds()).toEqual([]);

    const old = createWorkspaceSummaries({} as PluginClientContext);
    old.set("w1", state);
    expect(old.workspaceIds()).toEqual([]);
  });
});
