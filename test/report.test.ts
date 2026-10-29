import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it } from "vitest";
import { latestReply, Reports, ReportStore } from "../server/reports";
import { reportButton, reportMessage, reportPillFor, reportPrompt } from "../shared/prs";

const PR_URL = "https://github.com/o/r/pull/170";

describe("report text", () => {
  it("formats the main chat message, first and update", () => {
    expect(reportMessage({ number: 170, title: "Fix auth" }, " Rebase #171. \n", false)).toBe("[prs] #170 (Fix auth): Rebase #171.");
    expect(reportMessage({ number: 170, title: "Fix auth" }, "Done.", true)).toBe("[prs] #170 (Fix auth) update: Done.");
  });

  it("asks for a report, with the human's note", () => {
    const prompt = reportPrompt({ number: 170, url: PR_URL }, " keep the old API ", false);
    expect(prompt).toContain(`PR #170 (${PR_URL})`);
    expect(prompt).toContain("what the main agent must do next");
    expect(prompt).toContain("The human's note: keep the old API");
    expect(reportPrompt({ number: 170, url: PR_URL }, "  ", true)).not.toContain("note");
    expect(reportPrompt({ number: 170, url: PR_URL }, undefined, true)).toContain("final update");
  });
});

describe("report pill and button", () => {
  it("highlights a merged or closed PR", () => {
    expect(reportPillFor({ state: "OPEN" }).label).toBe("↩ Report");
    expect(reportPillFor(undefined).label).toBe("↩ Report");
    expect(reportPillFor({ state: "UNKNOWN" }).label).toBe("↩ Report");
    expect(reportPillFor({ state: "MERGED" })).toMatchObject({ label: "PR merged — report & finish?", icon: "GitMerge" });
    expect(reportPillFor({ state: "CLOSED" }).label).toBe("PR closed — report & finish?");
  });

  it("offers Done, then an update; disabled while the agent works or writes", () => {
    expect(reportButton(undefined, false)).toEqual({ label: "↩ Done, report to main chat", disabled: false });
    expect(reportButton(undefined, true).disabled).toBe(true);
    expect(reportButton({ sent: 1, state: "sent", at: "" }, false).label).toBe("↩ Send update to main chat");
    expect(reportButton({ sent: 0, state: "writing", at: "" }, false)).toEqual({ label: "Writing the report…", disabled: true });
  });
});

describe("latestReply", () => {
  it("joins the assistant text after the last user message", () => {
    expect(
      latestReply([
        { type: "assistant_message", text: "old" },
        { type: "user_message", text: "report" },
        { type: "assistant_message", text: "Decided X. " },
        { type: "tool_call" },
        { type: "assistant_message", text: "Pushed a1b2c3." },
      ]),
    ).toBe("Decided X. Pushed a1b2c3.");
    expect(latestReply([{ type: "user_message", text: "hi" }])).toBe("");
  });
});

interface Agent {
  id: string;
  status: string;
  archivedAt: string | null;
  cwd: string;
  labels: Record<string, string>;
}

function fakePaseo(agents: Record<string, Agent>) {
  const sent: { to: string; text: string; options?: Record<string, unknown> }[] = [];
  const archived: string[] = [];
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => (agents[id] ? { agent: agents[id] } : null),
        current: () => agents[id] ?? null,
        get archivedAt() {
          return agents[id]?.archivedAt ?? null;
        },
        send: async (text: string, options?: Record<string, unknown>) => void sent.push({ to: id, text, options }),
      }),
    },
    workspaces: { ref: (id: string) => ({ archive: async () => void archived.push(id) }) },
  } as unknown as PaseoApi;
  return { paseo, sent, archived };
}

function setup(main: Partial<Agent> = {}, fork: Partial<Agent> = {}) {
  const agents: Record<string, Agent> = {
    main: { id: "main", status: "idle", archivedAt: null, cwd: "/repo", labels: {}, ...main },
    fork: { id: "fork", status: "idle", archivedAt: null, cwd: "/wt", labels: { "prs.forkedFrom": "main", "prs.pr": PR_URL }, ...fork },
  };
  const fake = fakePaseo(agents);
  const details = async () => ({ number: 170, title: "Fix auth", url: PR_URL, body: null, baseRefName: null, headRefName: null });
  const reports = new Reports(() => fake.paseo, new ReportStore(null), details);
  return { ...fake, reports, agents };
}

const done = { kind: "completed" } as const;
const reply = (text: string) => [{ type: "user_message", text: "report" }, { type: "assistant_message", text }];
const forkAgent = { id: "fork", workspaceId: "wf" };

describe("Reports", () => {
  it("never sends to the main chat without the Done button", async () => {
    const { paseo, reports, sent } = setup();
    await reports.turnEnded(forkAgent, done, reply("I am done, telling main."));
    expect(sent).toEqual([]);
  });

  it("prompts the fork, then forwards that one turn's reply as an agent message", async () => {
    const { paseo, reports, sent } = setup();
    expect(await reports.start(paseo, { agentId: "fork", note: "ship it" })).toMatchObject({ state: "writing", sent: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "fork" });
    expect(sent[0]!.text).toContain("The human's note: ship it");

    await reports.turnEnded(forkAgent, done, reply("Merged the fix. Rebase #171."));
    expect(sent[1]).toEqual({
      to: "main",
      text: "[prs] #170 (Fix auth): Merged the fix. Rebase #171.",
      options: { sourceAgentId: "fork", messageId: "prs-report-fork-1", activeTurnBehavior: "steer" },
    });
    expect(reports.states(["fork"]).fork).toMatchObject({ state: "sent", sent: 1 });

    // The next turn is not a report.
    await reports.turnEnded(forkAgent, done, reply("More work."));
    expect(sent).toHaveLength(2);
  });

  it("labels a second report as an update", async () => {
    const { paseo, reports, sent } = setup();
    await reports.start(paseo, { agentId: "fork" });
    await reports.turnEnded(forkAgent, done, reply("First."));
    await reports.start(paseo, { agentId: "fork" });
    expect(sent[2]!.text).toContain("final update");
    await reports.turnEnded(forkAgent, done, reply("Second."));
    expect(sent[3]).toMatchObject({ text: "[prs] #170 (Fix auth) update: Second.", options: { messageId: "prs-report-fork-2" } });
  });

  it("sends nothing when the report turn is canceled or empty", async () => {
    const { paseo, reports, sent } = setup();
    await reports.start(paseo, { agentId: "fork" });
    await reports.turnEnded(forkAgent, { kind: "canceled", reason: "user" }, reply("half"));
    expect(sent).toHaveLength(1);
    expect(reports.states(["fork"]).fork).toMatchObject({ state: "failed", error: "Report not sent: the turn was canceled" });

    await reports.start(paseo, { agentId: "fork" });
    await reports.turnEnded(forkAgent, done, [{ type: "user_message", text: "report" }]);
    expect(sent).toHaveLength(2);
    expect(reports.states(["fork"]).fork?.state).toBe("failed");
  });

  it("refuses before prompting when the main chat is archived or gone, or the fork is busy", async () => {
    const archived = setup({ archivedAt: "2026-10-01" });
    await expect(archived.reports.start(archived.paseo, { agentId: "fork" })).rejects.toThrow("The main chat is archived");
    expect(archived.sent).toEqual([]);

    const gone = setup({}, { labels: { "prs.forkedFrom": "nobody", "prs.pr": PR_URL } });
    await expect(gone.reports.start(gone.paseo, { agentId: "fork" })).rejects.toThrow("The main chat is gone");

    const busy = setup({}, { status: "running" });
    await expect(busy.reports.start(busy.paseo, { agentId: "fork" })).rejects.toThrow("working");

    const notFork = setup({}, { labels: {} });
    await expect(notFork.reports.start(notFork.paseo, { agentId: "fork" })).rejects.toThrow("Only an agent forked");

    const twice = setup();
    await twice.reports.start(twice.paseo, { agentId: "fork" });
    await expect(twice.reports.start(twice.paseo, { agentId: "fork" })).rejects.toThrow("already being written");
  });

  it("fails the report when the main chat was archived meanwhile", async () => {
    const { paseo, reports, sent, agents } = setup();
    await reports.start(paseo, { agentId: "fork" });
    agents.main!.archivedAt = "2026-10-29";
    await reports.turnEnded(forkAgent, done, reply("Report."));
    expect(sent).toHaveLength(1);
    expect(reports.states(["fork"]).fork).toMatchObject({ state: "failed", error: "The main chat is archived", sent: 0 });
  });

  it("archives the fork's workspace after sending when asked", async () => {
    const { paseo, reports, archived, sent } = setup();
    await reports.start(paseo, { agentId: "fork", archive: true });
    expect(archived).toEqual([]);
    await reports.turnEnded(forkAgent, done, reply("Report."));
    expect(sent).toHaveLength(2);
    expect(archived).toEqual(["wf"]);
  });
});
