import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrCache, type PrFetcher } from "../server/github";
import { linkedPrsQuery, parseLinkedPrs } from "../server/graphql";
import { Links } from "../server/links";
import { LinkStore } from "../server/store";
import { callTool, isPrsPermission, pickCaller } from "../server/tools";
import { prUrl, type Pr, type PrRef } from "../shared/prs";

const pr = (repo: string, number: number, overrides: Partial<Pr> = {}): Pr => ({
  number,
  title: `PR ${number}`,
  url: prUrl({ repo, number }),
  state: "OPEN",
  draft: false,
  checks: "passing",
  failing: 0,
  review: "none",
  ...overrides,
});

/** A fetcher over a fixed set of PRs, counting calls; `fail` makes the next call throw. */
function fakeGitHub(prs: Pr[]) {
  const calls: PrRef[][] = [];
  let fail = false;
  const fetch: PrFetcher = async (refs) => {
    calls.push([...refs]);
    if (fail) throw new Error("offline");
    const found = new Map<string, Pr>();
    for (const ref of refs) {
      const hit = prs.find((candidate) => candidate.url.toLowerCase() === prUrl(ref).toLowerCase());
      if (hit) found.set(prUrl(ref), hit);
    }
    return found;
  };
  return { fetch, calls, failNext: () => (fail = true) };
}

describe("linkedPrsQuery / parseLinkedPrs", () => {
  it("batches every ref into one query and maps the answer back by ref", () => {
    const refs = [
      { repo: "o/r", number: 1 },
      { repo: "o/r", number: 2 },
      { repo: "x/y", number: 1 },
    ];
    const { query, aliases } = linkedPrsQuery(refs);
    expect(query).toContain('r0: repository(owner: "o", name: "r") { p1: pullRequest(number: 1)');
    expect(query).toContain("p2: pullRequest(number: 2)");
    expect(query).toContain('r1: repository(owner: "x", name: "y")');
    const node = (number: number, contexts: unknown[]) => ({
      number,
      title: `T${number}`,
      url: `https://github.com/O/R/pull/${number}`,
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] },
    });
    const json = JSON.stringify({
      data: { r0: { p1: node(1, [{ status: "COMPLETED", conclusion: "FAILURE" }, { state: "SUCCESS" }]), p2: null }, r1: null },
      errors: [{ message: "Could not resolve to a Repository" }],
    });
    const prs = parseLinkedPrs(json, aliases);
    expect([...prs.keys()]).toEqual(["https://github.com/o/r/pull/1"]);
    expect(prs.get("https://github.com/o/r/pull/1")).toMatchObject({ url: "https://github.com/O/R/pull/1", review: "approved", checks: "failing", failing: 1 });
  });
});

describe("PrCache", () => {
  it("fetches only stale refs, in one batch, and keeps the last answer when GitHub fails", async () => {
    let now = 0;
    const github = fakeGitHub([pr("o/r", 1), pr("o/r", 2)]);
    const cache = new PrCache(github.fetch, () => now);
    const one = { repo: "o/r", number: 1 };
    const two = { repo: "o/r", number: 2 };
    const gone = { repo: "o/r", number: 3 };

    await cache.get([one]);
    const second = await cache.get([one, two, gone]);
    expect(github.calls).toEqual([[one], [two, gone]]);
    expect(second.get(prUrl(gone))?.state).toBe("UNKNOWN");

    now = 31_000;
    github.failNext();
    const third = await cache.get([one]);
    expect(third.get(prUrl(one))?.state).toBe("OPEN");
    await cache.get([two], true);
    expect(github.calls).toHaveLength(4);
  });
});

describe("LinkStore", () => {
  it("links once per PR (case-insensitively), unlinks, and persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "prs-"));
    const store = new LinkStore(dir);
    expect(store.link("w1", [{ repo: "o/r", number: 1 }, { repo: "o/r", number: 2 }])).toHaveLength(2);
    expect(store.link("w1", [{ repo: "O/R", number: 1 }])).toEqual([]);
    expect(store.unlink("w1", [{ repo: "o/R", number: 2 }, { repo: "o/r", number: 9 }])).toEqual([{ repo: "o/r", number: 2 }]);
    expect(new LinkStore(dir).list("w1")).toEqual([{ repo: "o/r", number: 1 }]);
    store.unlink("w1", [{ repo: "o/r", number: 1 }]);
    expect(JSON.parse(readFileSync(join(dir, "links.json"), "utf8"))).toEqual({ workspaces: {} });
  });
});

describe("Links", () => {
  const setup = () => {
    const github = fakeGitHub([pr("Org/Repo", 5), pr("Org/Repo", 6, { state: "MERGED" }), pr("x/y", 1)]);
    const store = new LinkStore(mkdtempSync(join(tmpdir(), "prs-")));
    const links = new Links(store, new PrCache(github.fetch), async () => "org/repo");
    return { links, store, github };
  };
  const workspace = { workspaceId: "w", cwd: "/w" };

  it("links existing PRs under GitHub's spelling and reports the rest", async () => {
    const { links, store } = setup();
    const result = await links.link(workspace, ["#5 x/y#1", "#404", "nonsense"]);
    expect(result.linked).toEqual(["https://github.com/Org/Repo/pull/5", "https://github.com/x/y/pull/1"]);
    expect(result.errors).toEqual(["nonsense: not a PR URL or #number", "org/repo#404: not found on GitHub (or gh cannot read it)"]);
    expect(store.list("w")).toEqual([
      { repo: "Org/Repo", number: 5 },
      { repo: "x/y", number: 1 },
    ]);
  });

  it("lists linked PRs per workspace with one fetch", async () => {
    const { links, github } = setup();
    await links.link(workspace, ["https://github.com/Org/Repo/pull/5", "https://github.com/Org/Repo/pull/6"]);
    await links.link({ workspaceId: "v", cwd: "/v" }, ["x/y#1"]);
    const calls = github.calls.length;
    const listed = await links.list(["w", "v", "empty"]);
    expect(listed.map((entry) => [entry.workspaceId, entry.prs.map((p) => p.number)])).toEqual([
      ["w", [5, 6]],
      ["v", [1]],
      ["empty", []],
    ]);
    expect(github.calls.length).toBe(calls);
  });

  it("unlinks and says what was not linked", async () => {
    const { links, store } = setup();
    await links.link(workspace, ["#5"]);
    expect(await links.unlink(workspace, ["https://github.com/org/repo/pull/5", "#6"])).toEqual({
      linked: ["https://github.com/Org/Repo/pull/5"],
      errors: ["org/repo#6 was not linked"],
    });
    expect(store.list("w")).toEqual([]);
  });

  it("serves the MCP tools", async () => {
    const { links } = setup();
    const linked = await callTool(links, workspace, "prs_link", { urls: ["#5", "#6"] });
    expect(linked.isError).toBe(false);
    expect(linked.text).toContain("#5 checks pass: PR 5 (https://github.com/Org/Repo/pull/5)");
    expect(linked.text).toContain("#6 merged: PR 6");
    expect((await callTool(links, workspace, "prs_unlink", { urls: ["#404"] })).isError).toBe(true);
    expect((await callTool(links, null, "prs_list", {})).isError).toBe(true);
    expect((await callTool(links, workspace, "prs_link", { urls: [] })).isError).toBe(true);
    expect((await callTool(links, workspace, "prs_list", {})).text).toContain("#5");
  });
});

describe("tool plumbing", () => {
  it("recognizes its own permission prompts", () => {
    expect(isPrsPermission({ kind: "tool", name: "mcp__prs__prs_link" })).toBe(true);
    expect(isPrsPermission({ kind: "tool", name: "CodexMcpElicitation", metadata: { serverName: "prs" } })).toBe(true);
    expect(isPrsPermission({ kind: "tool", name: "mcp__asks__ask_create" })).toBe(false);
  });

  it("picks the Codex caller by working directory", () => {
    const agents = [
      { id: "a", cwd: "/w", status: "running" },
      { id: "b", cwd: "/w", status: "idle" },
      { id: "c", cwd: "/v", status: "running" },
    ];
    expect(pickCaller(agents, "/w")).toBe("a");
    expect(pickCaller(agents, "/v/")).toBe("c");
    expect(pickCaller([...agents, { id: "d", cwd: "/w", status: "running" }], "/w")).toBeNull();
  });
});
