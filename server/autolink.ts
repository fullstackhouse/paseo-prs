import type { PaseoApi } from "@getpaseo/client";
import type { Links, WorkspaceRef } from "./links";

const TIMELINE_LIMIT = 200;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const GH_PR_CREATE = /\bgh\s+pr\s+create\b/;
// GitHub's MCP server and its forks name the tool create_pull_request.
const MCP_PR_CREATE = /create_pull_request/i;

type ToolCall = { type: string; status?: string; name?: string; detail?: { type: string; command?: string; output?: unknown } };

/** PR URLs an agent opened in these timeline items: `gh pr create` in a shell, or an MCP create_pull_request call. */
export function openedPrs(items: readonly unknown[]): string[] {
  const urls = new Set<string>();
  for (const item of items as ToolCall[]) {
    if (item.type !== "tool_call" || item.status !== "completed" || !item.detail) continue;
    const { detail } = item;
    const opened = detail.type === "shell" ? GH_PR_CREATE.test(detail.command ?? "") : MCP_PR_CREATE.test(item.name ?? "");
    if (!opened || detail.output == null) continue;
    const text = typeof detail.output === "string" ? detail.output : JSON.stringify(detail.output);
    for (const [url] of text.matchAll(PR_URL)) urls.add(url);
  }
  return [...urls];
}

/**
 * Links the PRs an agent opens to its workspace when its turn ends, so they show even when the
 * agent forgets prs_link. Reads only the turn's own items, so a PR the human unlinked stays unlinked.
 */
export class AutoLinker {
  private readonly started = new Map<string, string>();
  // A turn already running when the plugin loaded is read from here on.
  private readonly loadedAt: string;

  constructor(
    private readonly paseo: () => PaseoApi | null,
    private readonly links: Pick<Links, "link">,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.loadedAt = now().toISOString();
  }

  turnStarted(agentId: string): void {
    this.started.set(agentId, this.now().toISOString());
  }

  async turnEnded(agent: { id: string; workspaceId: string | null; cwd: string }): Promise<string[]> {
    const since = this.started.get(agent.id) ?? this.loadedAt;
    this.started.delete(agent.id);
    const api = this.paseo();
    if (!agent.workspaceId || !api) return [];
    // The hook's own timeline can arrive empty; read it.
    const timeline = await api.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: TIMELINE_LIMIT, projection: "projected" });
    const urls = openedPrs(timeline.entries.filter((entry) => entry.timestamp >= since).map((entry) => entry.item));
    if (!urls.length) return [];
    const workspace: WorkspaceRef = { workspaceId: agent.workspaceId, cwd: agent.cwd };
    const { linked, errors } = await this.links.link(workspace, urls);
    if (errors.length) console.error("[prs] auto-link:", errors.join("; "));
    return linked;
  }
}
