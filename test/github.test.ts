import { describe, expect, it } from "vitest";
import { BranchCache, EdgeCache, Gh, isRateLimit, RateLimited } from "../server/github";
import type { Branch, Pr, PrEdge } from "../shared/prs";

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

/** An exec failure the way `execFile` reports it. */
const ghError = (stderr: string, stdout = "") => Object.assign(new Error(`Command failed: gh\n${stderr}`), { stderr, stdout });

describe("isRateLimit", () => {
  it("reads gh's stderr, never its stdout", () => {
    expect(isRateLimit(ghError("GraphQL: API rate limit already exceeded for user ID 1."))).toBe(true);
    expect(isRateLimit(ghError("HTTP 403: You have exceeded a secondary rate limit."))).toBe(true);
    expect(isRateLimit(ghError("HTTP 429: Too Many Requests"))).toBe(true);
    expect(isRateLimit(ghError("HTTP 403: Resource not accessible by integration"))).toBe(false);
    expect(isRateLimit(ghError("GraphQL: Could not resolve to a PullRequest", '{"title":"fix: rate limit"}'))).toBe(false);
  });
});

describe("Gh", () => {
  const setup = (rateLimit: string | Error) => {
    let now = 0;
    const calls: string[][] = [];
    let limited = true;
    const gh = new Gh(async (_cwd, args) => {
      calls.push(args);
      if (args[1] === "rate_limit") {
        if (rateLimit instanceof Error) throw rateLimit;
        return rateLimit;
      }
      if (limited) throw ghError("GraphQL: API rate limit already exceeded for user ID 1.");
      return "ok";
    }, () => now);
    return { gh, calls, at: (ms: number) => (now = ms), lift: () => (limited = false) };
  };

  it("stops calling gh until the GraphQL quota resets, asking once when that is", async () => {
    const { gh, calls, at, lift } = setup("0 600");
    await expect(Promise.all([gh.run("/w", ["pr", "list"]), gh.run("/v", ["pr", "list"])])).rejects.toBeInstanceOf(RateLimited);
    await Promise.resolve();
    expect(calls.filter((args) => args[1] === "rate_limit")).toHaveLength(1);
    lift();
    at(599_000);
    await expect(gh.run("/w", ["pr", "list"])).rejects.toMatchObject({ until: 600_000 });
    expect(calls.filter((args) => args[0] === "pr")).toHaveLength(2);
    at(600_000);
    expect(await gh.run("/w", ["pr", "list"])).toBe("ok");
  });

  it("backs off for five minutes when there is no reset to wait for", async () => {
    for (const answer of ["4000 600", new Error("offline")]) {
      const { gh, at, lift } = setup(answer);
      await expect(gh.run("/w", ["pr", "list"])).rejects.toBeInstanceOf(RateLimited);
      await Promise.resolve();
      lift();
      at(299_000);
      await expect(gh.run("/w", ["pr", "list"])).rejects.toMatchObject({ until: 300_000 });
      at(300_000);
      expect(await gh.run("/w", ["pr", "list"])).toBe("ok");
    }
  });

  it("passes other errors through without pausing", async () => {
    const gh = new Gh(async () => {
      throw ghError("HTTP 404: Not Found");
    });
    await expect(gh.run("/w", ["pr", "view"])).rejects.toThrow("HTTP 404");
    await expect(gh.run("/w", ["pr", "view"])).rejects.toThrow("HTTP 404");
  });
});

describe("EdgeCache", () => {
  it("lists a repo's open PRs once per TTL for all its worktrees, sharing a call in flight", async () => {
    let now = 0;
    const calls: string[] = [];
    const edges: PrEdge[] = [{ number: 1, head: "feat/x", base: "main" }];
    const cache = new EdgeCache(async (repo) => {
      calls.push(repo);
      return edges;
    }, () => now);

    await Promise.all([cache.get("o/r"), cache.get("O/R"), cache.get("x/y")]);
    expect(calls).toEqual(["o/r", "x/y"]);
    now = 119_000;
    expect(await cache.get("o/r")).toEqual(edges);
    expect(calls).toHaveLength(2);
    await cache.get("o/r", true);
    now = 300_000;
    await cache.get("x/y");
    expect(calls).toEqual(["o/r", "x/y", "o/r", "x/y"]);
  });

  it("shares a call in flight with forced reads, and forces a new one once it settled", async () => {
    const calls: string[] = [];
    let answer = (_: PrEdge[]) => {};
    const cache = new EdgeCache((repo) => {
      calls.push(repo);
      return new Promise((resolve) => (answer = resolve));
    }, () => 0);

    const reads = [cache.get("o/r"), cache.get("o/r", true), cache.get("o/r", true)];
    expect(calls).toHaveLength(1);
    answer([]);
    await Promise.all(reads);
    void cache.get("o/r", true);
    expect(calls).toHaveLength(2);
  });
});

describe("BranchCache", () => {
  const branch = (cwd: string, overrides: Partial<Branch> = {}): Branch => ({
    cwd,
    repo: "o/r",
    branch: "feat/x",
    isDefault: false,
    ahead: 1,
    prs: [],
    stack: [],
    ...overrides,
  });

  it("keeps a branch whose PRs are all merged or closed for an hour, unless forced", async () => {
    let now = 0;
    const reads: string[] = [];
    const answers: Record<string, Branch> = {
      "/merged": branch("/merged", { prs: [pr({ state: "MERGED" }), pr({ number: 2, state: "CLOSED" })] }),
      "/open": branch("/open", { prs: [pr({ state: "MERGED" }), pr({ number: 2 })] }),
    };
    const cache = new BranchCache(
      async (cwd) => {
        reads.push(cwd);
        return answers[cwd]!;
      },
      () => now,
      async () => "feat/x origin/feat/x",
    );

    await Promise.all([cache.get("/merged"), cache.get("/open")]);
    now = 120_000;
    await Promise.all([cache.get("/merged"), cache.get("/open")]);
    expect(reads).toEqual(["/merged", "/open", "/open"]);
    // Reopened: a forced read sees it, and the branch is back on the short TTL.
    answers["/merged"] = branch("/merged", { prs: [pr({ state: "OPEN" })] });
    expect((await cache.get("/merged", true)).prs[0]?.state).toBe("OPEN");
    now = 240_000;
    await cache.get("/merged");
    expect(reads.filter((cwd) => cwd === "/merged")).toHaveLength(3);
  });

  it("rereads a merged branch's checkout once git is on another branch", async () => {
    let now = 0;
    let checkout = "feat/x origin/feat/x";
    const reads: string[] = [];
    const cache = new BranchCache(
      async (cwd) => {
        reads.push(checkout);
        return checkout.startsWith("feat/x") ? branch(cwd, { prs: [pr({ state: "MERGED" })] }) : branch(cwd, { branch: "feat/y" });
      },
      () => now,
      async () => checkout,
    );

    await cache.get("/w");
    now = 120_000;
    expect((await cache.get("/w")).prs[0]?.state).toBe("MERGED");
    checkout = "feat/y origin/feat/y";
    expect((await cache.get("/w")).branch).toBe("feat/y");
    expect(reads).toEqual(["feat/x origin/feat/x", "feat/y origin/feat/y"]);
  });

  it("serves the previous read while GitHub is rate limited", async () => {
    let now = 0;
    let limited = false;
    const cache = new BranchCache(async (cwd) => {
      if (limited) throw new RateLimited(1_000_000);
      return branch(cwd, { prs: [pr()] });
    }, () => now);

    await cache.get("/w");
    limited = true;
    now = 120_000;
    expect((await cache.get("/w")).prs).toHaveLength(1);
    expect((await cache.get("/w", true)).prs).toHaveLength(1);
    expect((await cache.get("/never")).branch).toBeNull();
  });
});
