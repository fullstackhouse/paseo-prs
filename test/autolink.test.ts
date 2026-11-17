import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it } from "vitest";
import { AutoLinker, openedPrs } from "../server/autolink";

const shell = (command: string, output: string, status = "completed") => ({
  type: "tool_call",
  status,
  name: "Bash",
  detail: { type: "shell", command, output },
});
const mcp = (name: string, output: unknown) => ({ type: "tool_call", status: "completed", name, detail: { type: "unknown", input: {}, output } });

describe("openedPrs", () => {
  it("reads the URL gh pr create prints", () => {
    const items = [shell(`gh pr create --base main --title "x" --body "$(cat <<'EOF'\nbody\nEOF\n)" 2>&1 | tail -1`, "https://github.com/o/r/pull/12\n")];
    expect(openedPrs(items)).toEqual(["https://github.com/o/r/pull/12"]);
  });

  it("reads a create_pull_request MCP result", () => {
    const items = [mcp("mcp__github__create_pull_request", { number: 7, html_url: "https://github.com/o/r/pull/7", url: "https://api.github.com/repos/o/r/pulls/7" })];
    expect(openedPrs(items)).toEqual(["https://github.com/o/r/pull/7"]);
  });

  it("ignores PRs an agent only read, and calls still running", () => {
    const items = [
      shell("gh pr view 3 --json url", "https://github.com/o/r/pull/3"),
      shell("gh pr list", "https://github.com/o/r/pull/4"),
      shell("gh pr create --fill", "https://github.com/o/r/pull/5", "running"),
      { type: "assistant_message", text: "Opened https://github.com/o/r/pull/6" },
      mcp("mcp__github__get_pull_request", { html_url: "https://github.com/o/r/pull/8" }),
    ];
    expect(openedPrs(items)).toEqual([]);
  });

  it("links the existing PR gh pr create reports for the branch", () => {
    const items = [shell("gh pr create --fill", 'a pull request for branch "feat/x" into branch "main" already exists:\nhttps://github.com/o/r/pull/9')];
    expect(openedPrs(items)).toEqual(["https://github.com/o/r/pull/9"]);
  });
});

describe("AutoLinker", () => {
  const at = (iso: string) => () => new Date(iso);
  const setup = (entries: Array<{ timestamp: string; item: unknown }>, now = at("2026-11-17T10:00:00.000Z")) => {
    const linked: Array<{ workspaceId: string; urls: readonly string[] }> = [];
    const api = { agents: { ref: () => ({ timeline: { refetch: async () => ({ entries }) } }) } } as unknown as PaseoApi;
    const links = {
      link: async (workspace: { workspaceId: string }, urls: readonly string[]) => {
        linked.push({ workspaceId: workspace.workspaceId, urls });
        return { linked: [...urls], errors: [] };
      },
    };
    let clock = now;
    const linker = new AutoLinker(() => api, links, () => clock());
    return { linked, linker, setClock: (next: () => Date) => (clock = next) };
  };
  const agent = { id: "a1", workspaceId: "w1", cwd: "/w" };

  it("links only the PRs opened in the turn that just ended", async () => {
    const { linked, linker, setClock } = setup([
      { timestamp: "2026-11-17T10:05:00.000Z", item: shell("gh pr create --fill", "https://github.com/o/r/pull/1") },
      { timestamp: "2026-11-17T10:20:00.000Z", item: shell("gh pr create --fill", "https://github.com/o/r/pull/2") },
    ]);
    setClock(at("2026-11-17T10:10:00.000Z"));
    linker.turnStarted("a1");
    expect(await linker.turnEnded(agent)).toEqual(["https://github.com/o/r/pull/2"]);
    expect(linked).toEqual([{ workspaceId: "w1", urls: ["https://github.com/o/r/pull/2"] }]);
  });

  it("reads a turn that began before the plugin loaded from when it loaded", async () => {
    const { linker } = setup(
      [
        { timestamp: "2026-11-17T09:00:00.000Z", item: shell("gh pr create --fill", "https://github.com/o/r/pull/1") },
        { timestamp: "2026-11-17T10:01:00.000Z", item: shell("gh pr create --fill", "https://github.com/o/r/pull/2") },
      ],
      at("2026-11-17T10:00:00.000Z"),
    );
    expect(await linker.turnEnded(agent)).toEqual(["https://github.com/o/r/pull/2"]);
  });

  it("does nothing for an agent outside a workspace or a turn without PRs", async () => {
    const { linked, linker } = setup([{ timestamp: "2026-11-17T10:05:00.000Z", item: shell("ls", "") }]);
    expect(await linker.turnEnded({ ...agent, workspaceId: null })).toEqual([]);
    expect(await linker.turnEnded(agent)).toEqual([]);
    expect(linked).toEqual([]);
  });
});
