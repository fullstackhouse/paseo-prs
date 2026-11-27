import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PrFollows, prOf } from "../server/follows";
import { hostPrFetcher, PrReadsPaused, PrReadsUnavailable, type PrFetcher } from "../server/github";
import { fakeHost, read as hostRead } from "./fake-host";
import type { HostChangeRequestRead } from "../server/host-sdk";
import type { PaseoApi } from "@getpaseo/client";
import { Links } from "../server/links";
import { LinkStore } from "../server/store";
import { callTool, isPrsPermission, pickCaller, withPrsTools } from "../server/tools";
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
  return { fetch, calls, failNext: () => (fail = true), recover: () => (fail = false) };
}

describe("hostPrFetcher", () => {
  const read = (url: string, overrides: Partial<Extract<HostChangeRequestRead, { ok: true }>> = {}): HostChangeRequestRead => ({
    url,
    ok: true,
    number: 1,
    title: "T1",
    state: "open",
    isDraft: false,
    reviewDecision: "approved",
    checksState: "failing",
    checks: [
      { name: "test", state: "failing" },
      { name: "lint", state: "passing" },
      { name: "e2e", state: "failing" },
    ],
    headSha: "abc",
    ...overrides,
  });

  it("maps the host's read to the plugin's PR shape", () => {
    expect(prOf(read("https://github.com/O/R/pull/1") as Extract<HostChangeRequestRead, { ok: true }>)).toEqual({
      number: 1,
      title: "T1",
      url: "https://github.com/O/R/pull/1",
      state: "OPEN",
      draft: false,
      checks: "failing",
      failing: 2,
      review: "approved",
    });
    const merged = read("u", { state: "merged", reviewDecision: null, checksState: "none", checks: [] });
    expect(prOf(merged as Extract<HostChangeRequestRead, { ok: true }>)).toMatchObject({ state: "MERGED", review: "none", checks: "none", failing: 0 });
  });

  it("reads every ref in one call and leaves out the ones the host couldn't read", async () => {
    const calls: string[][] = [];
    const api = {
      changeRequests: {
        read: async (urls: string[]) => {
          calls.push(urls);
          return [read(urls[0]!), { url: urls[1]!, ok: false as const, error: "Could not resolve" }];
        },
      },
    } as unknown as PaseoApi;
    const prs = await hostPrFetcher(() => api)([
      { repo: "o/r", number: 1 },
      { repo: "x/y", number: 2 },
    ]);
    expect(calls).toEqual([["https://github.com/o/r/pull/1", "https://github.com/x/y/pull/2"]]);
    expect([...prs.keys()]).toEqual(["https://github.com/o/r/pull/1"]);
  });

  it("fails the read while the host is paused, logging once per pause", async () => {
    let retryAt = 5_000;
    const api = {
      changeRequests: {
        read: async (urls: string[]) => urls.map((url) => ({ url, ok: false as const, error: "Paused", reason: "paused" as const, retryAt })),
      },
    } as unknown as PaseoApi;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetch = hostPrFetcher(() => api);
      const refs = [{ repo: "o/r", number: 1 }];
      await expect(fetch(refs)).rejects.toThrow(PrReadsPaused);
      await expect(fetch(refs)).rejects.toThrow(PrReadsPaused);
      expect(log).toHaveBeenCalledTimes(1);
      retryAt = 9_000;
      await expect(fetch(refs)).rejects.toMatchObject({ retryAt: 9_000 });
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });

  it("can't read without the host API", async () => {
    const fetch = hostPrFetcher(() => ({}) as PaseoApi);
    await expect(fetch([{ repo: "o/r", number: 1 }])).rejects.toThrow(PrReadsUnavailable);
    await expect(hostPrFetcher(() => null)([{ repo: "o/r", number: 1 }])).rejects.toThrow(PrReadsUnavailable);
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
  const URLS = ["https://github.com/Org/Repo/pull/5", "https://github.com/Org/Repo/pull/6", "https://github.com/x/y/pull/1"];
  const setup = () => {
    const host = fakeHost({ reads: [hostRead(URLS[0]!), hostRead(URLS[1]!, { state: "merged" }), hostRead(URLS[2]!)] });
    const store = new LinkStore(mkdtempSync(join(tmpdir(), "prs-")));
    const links = new Links(store, new PrFollows(() => host.api), hostPrFetcher(() => host.api), async () => "org/repo");
    return { links, store, host };
  };
  const workspace = { workspaceId: "w", cwd: "/w" };

  it("links existing PRs under GitHub's spelling and reports the rest", async () => {
    const { links, store } = setup();
    const result = await links.link(workspace, ["#5 x/y#1", "#404", "nonsense"]);
    expect(result.linked).toEqual(["https://github.com/Org/Repo/pull/5", "https://github.com/x/y/pull/1"]);
    expect(result.errors).toEqual(["nonsense: not a PR URL or #number", "org/repo#404: not found on GitHub (or Paseo cannot read it)"]);
    expect(store.list("w")).toEqual([
      { repo: "Org/Repo", number: 5 },
      { repo: "x/y", number: 1 },
    ]);
  });

  it("lists linked PRs per workspace from subscriptions, without reading them", async () => {
    const { links, host } = setup();
    await links.link(workspace, [URLS[0]!, URLS[1]!]);
    await links.link({ workspaceId: "v", cwd: "/v" }, ["x/y#1"]);
    const reads = host.readCalls.length;
    const listed = await links.list(["w", "v", "empty"]);
    expect(listed.map((entry) => [entry.workspaceId, entry.prs.map((p) => [p.number, p.state])])).toEqual([
      ["w", [[5, "OPEN"], [6, "MERGED"]]],
      ["v", [[1, "OPEN"]]],
      ["empty", []],
    ]);
    expect(host.readCalls.length).toBe(reads);
    expect(host.subscriptions.every((subscription) => subscription.target.priority === "visible")).toBe(true);
  });

  it("follows an active workspace's links as visible and an idle one's in the background", async () => {
    const { links, host } = setup();
    await links.link(workspace, [URLS[0]!]);
    await links.link({ workspaceId: "v", cwd: "/v" }, [URLS[0]!, URLS[2]!]);
    await links.list([
      { workspaceId: "w", active: true },
      { workspaceId: "v", active: false },
    ]);
    const priorities = new Map(host.live().map((subscription) => [subscription.target.urls?.[0], subscription.target.priority]));
    // Linked to both: shown on the active workspace's pill, so visible.
    expect(priorities.get(URLS[0]!)).toBe("visible");
    expect(priorities.get(URLS[2]!)).toBe("background");
  });

  it("marks a workspace's links stale while the host pauses reads, keeping the last state", async () => {
    const { links, host } = setup();
    await links.link(workspace, ["#5"]);
    await links.list(["w"]);
    host.push([{ url: URLS[0]!, ok: false, error: "Paused", reason: "paused", retryAt: 10_000 }]);
    expect(await links.list(["w", "empty"])).toEqual([
      { workspaceId: "w", prs: [expect.objectContaining({ number: 5, state: "OPEN" })], stale: true },
      { workspaceId: "empty", prs: [] },
    ]);
    host.push([hostRead(URLS[0]!)]);
    expect((await links.list(["w"]))[0]).not.toHaveProperty("stale");
  });

  it("links a PR it can't read while reads are paused, and rejects a missing one once they resume", async () => {
    const host = fakeHost({ reads: [hostRead(URLS[0]!)] });
    let paused = true;
    const fetch: PrFetcher = async (refs) => {
      if (paused) throw new PrReadsPaused(10_000);
      return hostPrFetcher(() => host.api)(refs);
    };
    const store = new LinkStore(mkdtempSync(join(tmpdir(), "prs-")));
    const links = new Links(store, new PrFollows(() => host.api), fetch, async () => "org/repo");

    const result = await links.link(workspace, [URLS[0]!, "#404"]);
    expect(result).toEqual({ linked: [URLS[0], "https://github.com/org/repo/pull/404"], errors: [] });
    paused = false;
    expect((await links.link(workspace, ["#405"])).errors).toEqual(["org/repo#405: not found on GitHub (or Paseo cannot read it)"]);
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

  it("matches the host's provider-neutral tool on any provider", () => {
    expect(isPrsPermission({ kind: "tool", name: "prs.prs_link" }, { server: "prs" })).toBe(true);
    expect(isPrsPermission({ kind: "tool", name: "mcp__prs__prs_link" }, { server: "asks" })).toBe(false);
    expect(isPrsPermission({ kind: "question", name: "prs.prs_link" }, { server: "prs" })).toBe(false);
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

describe("withPrsTools", () => {
  const mcp = { type: "stdio" as const, command: "node", args: ["bridge.js"] };
  const base = { cwd: "/repo", mcpServers: { other: mcp } };

  it("attaches the prs MCP server and preapproves its tools where the provider holds exact grants", () => {
    const config = withPrsTools({ ...base, provider: "claude" }, mcp, true);
    expect(config.mcpServers).toMatchObject({ other: mcp, prs: mcp });
    expect(config.toolPolicy?.preapproved.map((grant) => grant.server)).toContain("prs");
  });

  it("keeps a preapproval another plugin already added", () => {
    const existing = { kind: "mcp" as const, server: "other", tool: "x" };
    const config = withPrsTools({ ...base, provider: "claude", toolPolicy: { preapproved: [existing] } }, mcp, true);
    expect(config.toolPolicy?.preapproved[0]).toEqual(existing);
  });

  it("attaches the server but adds no tool policy where the provider can't preapprove", () => {
    const config = withPrsTools({ ...base, provider: "copilot" }, mcp, false);
    expect(config.mcpServers).toMatchObject({ prs: mcp });
    expect(config.toolPolicy).toBeUndefined();
  });
});
