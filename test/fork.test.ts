import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it } from "vitest";
import { chatHistoryText, forkIntoPr } from "../server/fork";
import { canFork, prAgentFor, type AgentRef, type Branch, type RelatedPr } from "../shared/prs";

const row = (overrides: Partial<RelatedPr> = {}): RelatedPr => ({
  number: 7,
  title: "feat: x",
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  draft: false,
  checks: "passing",
  failing: 0,
  review: "none",
  onBranch: false,
  stacked: false,
  linked: true,
  ...overrides,
});
const agent = (id: string, workspaceId: string, cwd: string, labels: Record<string, string> = {}): AgentRef => ({ id, workspaceId, cwd, labels });
const branchWith = (cwd: string, url: string, state: RelatedPr["state"] = "OPEN"): Branch => ({
  cwd,
  repo: "o/r",
  branch: "b",
  isDefault: false,
  ahead: 1,
  prs: [{ ...row({ url, state }) }],
  stack: [],
});

describe("prAgentFor", () => {
  const url = "https://github.com/o/r/pull/7";

  it("prefers an agent forked for the PR, outside the asking workspace", () => {
    const agents = [agent("self", "w0", "/0", { "prs.pr": url }), agent("onBranch", "w2", "/2"), agent("forked", "w1", "/1", { "prs.pr": url.toUpperCase() })];
    const branches = new Map([["/2", branchWith("/2", url)]]);
    expect(prAgentFor(url, agents, branches, "w0")?.id).toBe("forked");
  });

  it("falls back to an agent whose branch has the PR open", () => {
    const branches = new Map([
      ["/1", branchWith("/1", url, "MERGED")],
      ["/2", branchWith("/2", url)],
    ]);
    expect(prAgentFor(url, [agent("a", "w1", "/1"), agent("b", "w2", "/2")], branches, "w0")?.id).toBe("b");
    expect(prAgentFor(url, [agent("a", "w1", "/1")], branches, "w0")).toBeNull();
  });
});

describe("canFork", () => {
  it("needs an open PR from the workspace's own repo, not its branch's", () => {
    expect(canFork(row(), "O/R")).toBe(true);
    expect(canFork(row(), "x/y")).toBe(false);
    expect(canFork(row(), null)).toBe(false);
    expect(canFork(row({ state: "MERGED" }), "o/r")).toBe(false);
    expect(canFork(row({ onBranch: true }), "o/r")).toBe(true);
  });
});

describe("chatHistoryText", () => {
  it("keeps messages and tool names, with Paseo's header", () => {
    const text = chatHistoryText(
      [
        { type: "user_message", text: " Fix #7 " },
        { type: "reasoning" },
        { type: "tool_call", name: "Bash" },
        { type: "assistant_message", text: "Done." },
      ],
      { title: "Main", cwd: "/w" },
    );
    expect(text).toBe(
      "<chat-history-summary>\nChat history from a previous Paseo agent.\nSource agent: Main\nSource directory: /w\n\nUser: Fix #7\n[Tool: Bash]\nAssistant: Done.\n</chat-history-summary>",
    );
  });

  it("keeps the newest messages within budget", () => {
    const long = (n: number) => ({ type: "user_message", text: `${n}`.padEnd(30_000, ".") });
    const text = chatHistoryText([long(1), long(2), long(3), long(4)], {});
    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain("[Earlier messages omitted]\nUser: 2");
    expect(text).not.toContain("User: 1");
    expect(chatHistoryText([], {})).toContain("No chat history to display.");
  });
});

describe("forkIntoPr", () => {
  it("creates a non-child agent on the PR like the source, with the PR and chat attached", async () => {
    const created: unknown[] = [];
    const source = {
      provider: "claude",
      model: "opus",
      runtimeInfo: { model: "claude-opus-5-5" },
      currentModeId: "plan",
      thinkingOptionId: "high",
      features: [{ id: "fast", value: true }],
      cwd: "/repo",
      title: "Main stack",
    };
    const paseo = {
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: source }),
          current: () => source,
          timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message", text: "hello" } }] }) },
        }),
        create: async (options: unknown) => {
          created.push(options);
          return { id: "new", workspaceId: "w9", refresh: async () => null };
        },
      },
    } as unknown as PaseoApi;
    const details = async () => ({ number: 7, title: "feat: x", url: "https://github.com/o/r/pull/7", body: "Body", baseRefName: "main", headRefName: "x" });

    expect(await forkIntoPr(paseo, { agentId: "src", prUrl: "https://github.com/o/r/pull/7" }, details)).toEqual({ agentId: "new", workspaceId: "w9" });
    const options = created[0] as Record<string, any>;
    expect(options).toMatchObject({
      cwd: "/repo",
      worktree: { mode: "checkout-pr", prNumber: 7 },
      background: false,
      config: { provider: "claude/claude-opus-5-5", modeId: "plan", thinkingOptionId: "high", featureValues: { fast: true } },
      labels: { "prs.forkedFrom": "src", "prs.pr": "https://github.com/o/r/pull/7" },
    });
    expect(options.parent).toBeUndefined();
    expect(options.prompt).toMatch(/^Focus only on PR #7 \(https:\/\/github\.com\/o\/r\/pull\/7\)\./);
    expect(options.attachments[0]).toMatchObject({ type: "github_pr", number: 7, body: "Body", headRefName: "x" });
    expect(options.attachments[1]).toMatchObject({ type: "text", contextKind: "chat_history" });
    expect(options.attachments[1].text).toContain("User: hello");
  });
});
