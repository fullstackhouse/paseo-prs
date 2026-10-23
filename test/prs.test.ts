import { describe, expect, it } from "vitest";
import { parsePrs, pillsFor, summarizeChecks, type Branch, type Pr } from "../shared/prs";

const pr = (overrides: Partial<Pr> = {}): Pr => ({
  number: 1,
  title: "feat: thing",
  url: "https://github.com/o/r/pull/1",
  state: "OPEN",
  draft: false,
  checks: "passing",
  failing: 0,
  review: "none",
  ...overrides,
});
const branch = (overrides: Partial<Branch> = {}): Branch => ({
  cwd: "/w",
  branch: "feat/x",
  isDefault: false,
  ahead: 2,
  prs: [],
  ...overrides,
});
const labels = (b: Branch | undefined) => pillsFor(b).map((pill) => pill.label);

describe("summarizeChecks", () => {
  it("reads CheckRuns and StatusContexts", () => {
    expect(summarizeChecks([])).toEqual({ checks: "none", failing: 0 });
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toEqual({ checks: "passing", failing: 0 });
    expect(summarizeChecks([{ status: "IN_PROGRESS", conclusion: "" }, { state: "SUCCESS" }])).toEqual({ checks: "pending", failing: 0 });
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "FAILURE" }, { state: "ERROR" }, { status: "QUEUED" }])).toEqual({
      checks: "failing",
      failing: 2,
    });
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "SKIPPED" }, { status: "COMPLETED", conclusion: "NEUTRAL" }]).checks).toBe("passing");
  });
});

describe("parsePrs", () => {
  it("maps gh JSON", () => {
    const json = JSON.stringify([
      {
        number: 545,
        title: "fix: x",
        url: "https://github.com/o/r/pull/545",
        state: "OPEN",
        isDraft: true,
        reviewDecision: "CHANGES_REQUESTED",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
      },
    ]);
    expect(parsePrs(json)).toEqual([
      { number: 545, title: "fix: x", url: "https://github.com/o/r/pull/545", state: "OPEN", draft: true, review: "changes_requested", checks: "failing", failing: 1 },
    ]);
  });
});

describe("pillsFor", () => {
  it("shows nothing outside a branch or on the default branch without PRs", () => {
    expect(labels(undefined)).toEqual([]);
    expect(labels(branch({ branch: null }))).toEqual([]);
    expect(labels(branch({ branch: "main", isDefault: true }))).toEqual([]);
  });

  it("offers Create PR only with commits to propose", () => {
    expect(labels(branch())).toEqual(["Create PR"]);
    expect(labels(branch({ ahead: 0 }))).toEqual([]);
  });

  it("puts what needs attention first", () => {
    expect(labels(branch({ prs: [pr({ checks: "failing", failing: 2, review: "changes_requested" })] }))).toEqual(["#1 · 2 failing"]);
    expect(labels(branch({ prs: [pr({ review: "changes_requested", draft: true })] }))).toEqual(["#1 · changes requested"]);
    expect(labels(branch({ prs: [pr({ draft: true, checks: "pending" })] }))).toEqual(["#1 · draft"]);
    expect(labels(branch({ prs: [pr({ checks: "pending", review: "approved" })] }))).toEqual(["#1 · checks running"]);
    expect(labels(branch({ prs: [pr({ review: "approved" })] }))).toEqual(["#1 · approved"]);
    expect(labels(branch({ prs: [pr({ checks: "none" })] }))).toEqual(["#1 · open"]);
  });

  it("shows every open PR, ignoring old closed ones", () => {
    const prs = [pr({ number: 3 }), pr({ number: 1, state: "MERGED" }), pr({ number: 2, checks: "failing", failing: 1 })];
    expect(labels(branch({ prs }))).toEqual(["#2 · 1 failing", "#3 · checks pass"]);
  });

  it("falls back to the latest merged or closed PR", () => {
    const prs = [pr({ number: 1, state: "CLOSED" }), pr({ number: 4, state: "MERGED" })];
    expect(labels(branch({ prs }))).toEqual(["#4 · merged"]);
  });

  it("collapses many PRs into one pill", () => {
    const prs = [1, 2, 3, 4].map((number) => pr({ number, checks: number === 2 ? "failing" : "passing", failing: number === 2 ? 1 : 0 }));
    const pills = pillsFor(branch({ prs }));
    expect(pills.map((pill) => pill.label)).toEqual(["4 PRs · 1 failing"]);
    expect(pills[0]?.kind === "many" && pills[0].prs.map((p) => p.number)).toEqual([1, 2, 3, 4]);
  });
});
