import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { FORKED_FROM_LABEL, PR_LABEL, reportMessage, reportPrompt, type ReportInput, type ReportState } from "../shared/prs";
import type { PrDetails } from "./github";

const MAX_REPORT_CHARS = 8000;
const TIMELINE_LIMIT = 200;

/** A report the human asked for and the fork is writing: where it goes and what happens after. */
interface Pending {
  mainAgentId: string;
  pr: { number: number; title: string; url: string };
  archive: boolean;
  /** The prompt the Done button sent, and when: the report is the reply after it, not after an earlier identical one. */
  prompt: string;
  sentAt: string;
}

interface Entry extends ReportState {
  pending?: Pending;
}

/** Each fork's report state, in one JSON file so a report in progress survives a plugin reload. */
export class ReportStore {
  private readonly path: string | null;
  private entries: Record<string, Entry>;

  constructor(dir: string | null, private readonly now: () => Date = () => new Date()) {
    this.path = dir ? join(dir, "reports.json") : null;
    this.entries = this.path && existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }

  get(agentId: string): Entry | undefined {
    return this.entries[agentId];
  }

  set(agentId: string, entry: Omit<Entry, "at">): ReportState {
    const next = { ...entry, at: this.now().toISOString() };
    if (!next.error) delete next.error;
    if (!next.pending) delete next.pending;
    this.entries = { ...this.entries, [agentId]: next };
    if (this.path) {
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.entries, null, 2));
      renameSync(`${this.path}.tmp`, this.path);
    }
    return publicState(next);
  }

  states(agentIds: readonly string[]): Record<string, ReportState> {
    return Object.fromEntries(agentIds.flatMap((id) => (this.entries[id] ? [[id, publicState(this.entries[id]!)]] : [])));
  }
}

const publicState = ({ pending: _pending, ...state }: Entry): ReportState => state;

type TimelineItem = { type: string; text?: string };

/**
 * The assistant text after the last `prompt` user message, up to the next user message; streamed replies
 * arrive as several items. Null when the prompt is not in the timeline (the turn was about something else).
 */
export function replyTo(timeline: readonly TimelineItem[], prompt: string): string | null {
  let start = -1;
  for (let index = timeline.length - 1; index >= 0 && start < 0; index--) {
    const item = timeline[index]!;
    if (item.type === "user_message" && item.text?.trim() === prompt.trim()) start = index;
  }
  if (start < 0) return null;
  const parts: string[] = [];
  for (const item of timeline.slice(start + 1)) {
    if (item.type === "user_message") break;
    if (item.type === "assistant_message" && item.text) parts.push(item.text);
  }
  return parts.join("").trim().slice(0, MAX_REPORT_CHARS);
}

type TurnOutcome = { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };

/**
 * A fork reports to its main chat only when the human asks: `start` (the Done button) records a pending
 * report and prompts the fork; `turnEnded` forwards the reply of that one turn. Nothing else sends.
 */
export class Reports {
  constructor(
    private readonly paseo: () => PaseoApi | null,
    private readonly store: ReportStore,
    private readonly prDetails: (cwd: string, url: string) => Promise<PrDetails>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  states(agentIds: readonly string[]): Record<string, ReportState> {
    return this.store.states(agentIds);
  }

  async start(api: PaseoApi, { agentId, note, archive }: ReportInput): Promise<ReportState> {
    const current = this.store.get(agentId);
    if (current?.state === "writing") throw new Error("The report is already being written");
    const fork = api.agents.ref(agentId);
    const snapshot = (await fork.refresh())?.agent ?? fork.current();
    if (!snapshot || snapshot.archivedAt) throw new Error("This agent is gone");
    const mainAgentId = snapshot.labels?.[FORKED_FROM_LABEL];
    const prUrl = snapshot.labels?.[PR_LABEL];
    if (!mainAgentId || !prUrl) throw new Error("Only an agent forked onto a PR reports to a main chat");
    if (snapshot.status === "running" || snapshot.status === "initializing") throw new Error("The agent is working; wait for its turn to end");
    await mainChat(api, mainAgentId);
    const details = await this.prDetails(snapshot.cwd, prUrl);
    const prompt = reportPrompt(details, note, (current?.sent ?? 0) > 0);
    const state = this.store.set(agentId, {
      sent: current?.sent ?? 0,
      state: "writing",
      pending: { mainAgentId, pr: { number: details.number, title: details.title, url: details.url }, archive: archive ?? false, prompt, sentAt: this.now().toISOString() },
    });
    try {
      await fork.send(prompt);
    } catch (error) {
      this.fail(agentId, error);
      throw error;
    }
    return state;
  }

  /**
   * Forwards the reply to the Done button's prompt; any other turn of any agent is ignored. Reads the
   * timeline itself: the hook's `timeline` can arrive empty.
   */
  async turnEnded(agent: { id: string; workspaceId: string | null }, outcome: TurnOutcome): Promise<void> {
    const entry = this.store.get(agent.id);
    const pending = entry?.pending;
    if (!entry || !pending || entry.state !== "writing") return;
    if (outcome.kind !== "completed") return void this.fail(agent.id, `Report not sent: the turn ${outcome.kind === "failed" ? `failed (${outcome.error.message})` : "was canceled"}`);
    try {
      const api = this.paseo();
      if (!api) throw new Error("Paseo is not connected yet");
      const timeline = await api.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: TIMELINE_LIMIT, projection: "projected" });
      const since = timeline.entries.filter((entry) => entry.timestamp >= pending.sentAt);
      const summary = replyTo(since.map((entry) => entry.item as TimelineItem), pending.prompt);
      // Not the report turn yet; the next turn_ended looks again.
      if (summary === null) return;
      if (!summary) throw new Error("Report not sent: the agent wrote nothing");
      const main = await mainChat(api, pending.mainAgentId);
      const update = entry.sent > 0;
      // The same envelope as send_agent_prompt; steer joins a running turn instead of interrupting it.
      await main.send(reportMessage(pending.pr, summary, update), {
        sourceAgentId: agent.id,
        messageId: `prs-report-${agent.id}-${entry.sent + 1}`,
        activeTurnBehavior: "steer",
      });
      this.store.set(agent.id, { sent: entry.sent + 1, state: "sent" });
      if (pending.archive && agent.workspaceId) await api.workspaces.ref(agent.workspaceId).archive();
    } catch (error) {
      this.fail(agent.id, error);
    }
  }

  private fail(agentId: string, error: unknown): void {
    const sent = this.store.get(agentId)?.sent ?? 0;
    this.store.set(agentId, { sent, state: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}

/** The main agent, live: archived or gone ones get an error the popover shows next to Go to main chat. */
async function mainChat(api: PaseoApi, agentId: string) {
  const main = api.agents.ref(agentId);
  const found = await main.refresh().catch(() => null);
  if (!found || !main.current()) throw new Error("The main chat is gone");
  if (main.archivedAt) throw new Error("The main chat is archived");
  return main;
}
