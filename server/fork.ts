import type { PaseoApi } from "@getpaseo/client";
import { forkPrompt, FORKED_FROM_LABEL, PR_LABEL, type ForkInput, type ForkResult } from "../shared/prs";
import { readPrDetails, type PrDetails } from "./github";

// Matches the budget of Paseo's own "Fork in a new workspace" chat history.
const MAX_HISTORY_CHARS = 100_000;
const OMITTED = "[Earlier messages omitted]\n";
const TIMELINE_LIMIT = 1_000;

type HistoryItem =
  | { type: "user_message"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_call"; name: string }
  | { type: string };

/**
 * The text of a `chat_history` attachment, shaped like Paseo core's: user and assistant messages and
 * tool names, newest kept when over budget. Core's own builder (`buildAgentForkContext`) is a
 * DaemonClient method that the plugin SDK's PaseoApi does not expose.
 */
export function chatHistoryText(items: readonly HistoryItem[], source: { title?: string | null; cwd?: string | null }): string {
  const lines = items.flatMap((item) => {
    if (item.type === "user_message" && "text" in item) return [`User: ${item.text.trim()}`];
    if (item.type === "assistant_message" && "text" in item) return [`Assistant: ${item.text.trim()}`];
    if (item.type === "tool_call" && "name" in item) return [`[Tool: ${item.name}]`];
    return [];
  });
  const header = ["Chat history from a previous Paseo agent."];
  if (source.title?.trim()) header.push(`Source agent: ${source.title.trim()}`);
  if (source.cwd?.trim()) header.push(`Source directory: ${source.cwd.trim()}`);
  const wrap = (body: string) => `<chat-history-summary>\n${header.join("\n")}\n\n${body}\n</chat-history-summary>`;
  const budget = MAX_HISTORY_CHARS - wrap("").length;
  if (!lines.length) return wrap("No chat history to display.");
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    const room = budget - OMITTED.length - used;
    if (line.length + 1 > room) {
      if (!kept.length) kept.push(`${line.slice(0, Math.max(0, room - 20))}\n[Message truncated]`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  const body = kept.reverse().join("\n");
  return wrap(kept.length < lines.length ? OMITTED + body : body);
}

/**
 * A new workspace with the PR checked out, and an agent there like the source one (provider, model,
 * mode, thinking, features), seeded with the PR and the source chat. Not a child: no `parent`.
 */
export async function forkIntoPr(paseo: PaseoApi, { agentId, prUrl }: ForkInput, prDetails: (cwd: string, url: string) => Promise<PrDetails> = readPrDetails): Promise<ForkResult> {
  const source = paseo.agents.ref(agentId);
  const found = await source.refresh();
  const agent = found?.agent ?? source.current();
  if (!agent) throw new Error("The source agent is gone");
  const [pr, timeline] = await Promise.all([
    prDetails(agent.cwd, prUrl),
    source.timeline.refetch({ direction: "tail", limit: TIMELINE_LIMIT, projection: "projected" }),
  ]);
  const featureValues = Object.fromEntries((agent.features ?? []).map((feature) => [feature.id, feature.value]));
  // The resolved model (`claude-haiku-5-5`), not the alias the agent was created with (`haiku`), which loses its thinking options.
  const model = agent.runtimeInfo?.model ?? agent.model;
  const modeId = agent.currentModeId ?? agent.runtimeInfo?.modeId ?? undefined;
  const thinkingOptionId = agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? undefined;
  const created = await paseo.agents.create({
    cwd: agent.cwd,
    worktree: { mode: "checkout-pr", prNumber: pr.number },
    background: false,
    title: `PR #${pr.number}: ${pr.title}`,
    config: {
      provider: model ? `${agent.provider}/${model}` : agent.provider,
      modeId,
      thinkingOptionId,
      featureValues,
    },
    labels: { [FORKED_FROM_LABEL]: agentId, [PR_LABEL]: pr.url },
    attachments: [
      {
        type: "github_pr",
        mimeType: "application/github-pr",
        number: pr.number,
        title: pr.title,
        url: pr.url,
        body: pr.body,
        baseRefName: pr.baseRefName,
        headRefName: pr.headRefName,
      },
      {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        title: "Chat history",
        text: chatHistoryText(
          timeline.entries.map((entry) => entry.item as HistoryItem),
          { title: agent.title, cwd: agent.cwd },
        ),
      },
    ],
    prompt: forkPrompt(pr, agent.title),
  });
  await created.refresh().catch(() => null);
  return { agentId: created.id, workspaceId: created.workspaceId };
}
