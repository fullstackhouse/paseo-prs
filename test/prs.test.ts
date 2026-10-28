import { describe, expect, it } from "vitest";
import {
  parsePrRef,
  parsePrs,
  parseRemote,
  pillFor,
  relatedPrs,
  rowDetail,
  summarizeChecks,
  type Branch,
  type Pr,
} from "../shared/prs";

export const pr = (overrides: Partial<Pr> = {}): Pr => ({
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
  ahead: 2,
  prs: [],
  ...overrides,
});
const label = (b: Branch | undefined, linked: Pr[] = []) => pillFor(b, linked)?.label ?? null;

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

  it("accepts GraphQL nulls and empty objects", () => {
    expect(summarizeChecks([{ status: "IN_PROGRESS", conclusion: null }, {}])).toEqual({ checks: "pending", failing: 0 });
    expect(summarizeChecks(null)).toEqual({ checks: "none", failing: 0 });
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

describe("parsePrRef", () => {
  it("reads URLs, owner/repo#n and #n", () => {
    expect(parsePrRef("https://github.com/fullstackhouse/casteo/pull/169", null)).toEqual({ repo: "fullstackhouse/casteo", number: 169 });
    expect(parsePrRef(" github.com/o/r.js/pull/7/files?w=1 ", null)).toEqual({ repo: "o/r.js", number: 7 });
    expect(parsePrRef("http://www.github.com/o/r/pull/7#discussion_r1", null)).toEqual({ repo: "o/r", number: 7 });
    expect(parsePrRef("o/r#12", "x/y")).toEqual({ repo: "o/r", number: 12 });
    expect(parsePrRef("#12", "x/y")).toEqual({ repo: "x/y", number: 12 });
    expect(parsePrRef("12", "x/y")).toEqual({ repo: "x/y", number: 12 });
  });

  it("rejects what it cannot place", () => {
    expect(parsePrRef("#12", null)).toBeNull();
    expect(parsePrRef("#0", "x/y")).toBeNull();
    expect(parsePrRef("https://github.com/o/r/issues/12", null)).toBeNull();
    expect(parsePrRef("https://gitlab.com/o/r/pull/12", null)).toBeNull();
    expect(parsePrRef("feat: thing", "x/y")).toBeNull();
  });
});

describe("parseRemote", () => {
  it("reads GitHub remotes only", () => {
    expect(parseRemote("git@github.com:fullstackhouse/paseo-prs.git")).toBe("fullstackhouse/paseo-prs");
    expect(parseRemote("https://github.com/o/r.js.git\n")).toBe("o/r.js");
    expect(parseRemote("ssh://git@github.com/o/r")).toBe("o/r");
    expect(parseRemote("git@gitlab.com:o/r.git")).toBeNull();
    expect(parseRemote("")).toBeNull();
  });
});

describe("relatedPrs", () => {
  it("merges branch and linked PRs by URL, open first", () => {
    const rows = relatedPrs(branch({ prs: [pr({ number: 5 })] }), [pr({ number: 5 }), pr({ number: 9, state: "MERGED" }), pr({ number: 7 })]);
    expect(rows.map((row) => [row.number, row.onBranch, row.linked])).toEqual([
      [5, true, true],
      [7, false, true],
      [9, false, true],
    ]);
  });

  it("keeps only the latest closed branch PR when none is open, but every linked one", () => {
    const rows = relatedPrs(branch({ prs: [pr({ number: 1, state: "CLOSED" }), pr({ number: 4, state: "MERGED" })] }), [pr({ number: 2, state: "MERGED" })]);
    expect(rows.map((row) => row.number)).toEqual([2, 4]);
  });

  it("works without a branch", () => {
    expect(relatedPrs(undefined, [pr({ number: 3 })]).map((row) => row.number)).toEqual([3]);
  });
});

describe("pillFor", () => {
  it("shows nothing outside a branch or on the default branch without PRs", () => {
    expect(label(undefined)).toBeNull();
    expect(label(branch({ branch: null }))).toBeNull();
    expect(label(branch({ branch: "main", isDefault: true }))).toBeNull();
  });

  it("offers Create PR only with commits to propose", () => {
    expect(label(branch())).toBe("Create PR");
    expect(label(branch({ ahead: 0 }))).toBeNull();
  });

  it("puts what needs attention first for one PR", () => {
    expect(label(branch({ prs: [pr({ checks: "failing", failing: 2, review: "changes_requested" })] }))).toBe("#1 · 2 failing");
    expect(label(branch({ prs: [pr({ review: "changes_requested", draft: true })] }))).toBe("#1 · changes requested");
    expect(label(branch({ prs: [pr({ draft: true, checks: "pending" })] }))).toBe("#1 · draft");
    expect(label(branch({ prs: [pr({ checks: "pending", review: "approved" })] }))).toBe("#1 · checks running");
    expect(label(branch({ prs: [pr({ review: "approved" })] }))).toBe("#1 · approved");
    expect(label(branch({ prs: [pr({ checks: "none" })] }))).toBe("#1 · open");
    expect(label(branch({ prs: [pr({ state: "MERGED" })] }))).toBe("#1 · merged");
    expect(label(undefined, [pr({ state: "UNKNOWN" })])).toBe("#1 · unavailable");
  });

  it("summarizes several PRs in one pill, counting open failing ones", () => {
    const linked = [1, 2, 3, 4].map((number) => pr({ number, checks: number % 2 ? "failing" : "passing", failing: 1, state: number === 3 ? "MERGED" : "OPEN" }));
    const pill = pillFor(branch({ branch: "main", isDefault: true }), linked);
    expect(pill?.label).toBe("PRs · 4 · 1 failing");
    expect(pill?.icon).toBe("CircleX");
    expect(pill?.kind === "prs" && pill.prs.map((row) => row.number)).toEqual([1, 2, 4, 3]);
    expect(label(undefined, [pr({ number: 1 }), pr({ number: 2 })])).toBe("PRs · 2");
  });
});

describe("rowDetail", () => {
  it("lists state, checks and review", () => {
    expect(rowDetail(pr({ draft: true, checks: "failing", failing: 3, review: "changes_requested" }))).toBe("draft · 3 failing · changes requested");
    expect(rowDetail(pr({ review: "approved" }))).toBe("checks pass · approved");
    expect(rowDetail(pr({ checks: "none" }))).toBe("open");
    expect(rowDetail(pr({ state: "MERGED" }))).toBe("merged");
    expect(rowDetail(pr({ state: "UNKNOWN" }))).toBe("not found on GitHub");
  });
});
