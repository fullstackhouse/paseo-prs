import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentPermissionRequest, McpToolRef } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import type { LinkResult } from "../shared/prs";
import type { Links, WorkspaceRef } from "./links";

export const MCP_SERVER = "prs";

export const INSTRUCTIONS = `Link the pull requests you work on to this workspace with prs_link, so they show in the composer's PRs pill with their checks and review state. PRs on the workspace's own branch show without linking. Link each PR you open, push to, or are asked to look after; unlink with prs_unlink when it no longer belongs here.`;

const UrlsSchema = z.object({ urls: z.array(z.string()).min(1) });
const urlsInput = {
  type: "object",
  properties: { urls: { type: "array", items: { type: "string" }, description: "PR URLs, owner/repo#123, or #123 in this workspace's repo" } },
  required: ["urls"],
};

export const TOOLS = [
  { name: "prs_link", description: "Link pull requests to this workspace so they show in its PRs pill.", inputSchema: urlsInput },
  { name: "prs_unlink", description: "Unlink pull requests from this workspace.", inputSchema: urlsInput },
  { name: "prs_list", description: "List the pull requests linked to this workspace, with checks and review state.", inputSchema: { type: "object", properties: {} } },
];

export const PREAPPROVED: McpToolRef[] = TOOLS.map((tool) => ({ kind: "mcp", server: MCP_SERVER, tool: tool.name }));

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export async function callTool(links: Links, caller: WorkspaceRef | null, name: string, args: unknown): Promise<ToolResult> {
  try {
    if (!caller) throw new Error("Cannot tell which agent called; PASEO_AGENT_ID is not set and the working directory is ambiguous");
    switch (name) {
      case "prs_link":
        return report("Linked", await links.link(caller, UrlsSchema.parse(args).urls), await links.describe(caller.workspaceId));
      case "prs_unlink":
        return report("Unlinked", await links.unlink(caller, UrlsSchema.parse(args).urls), await links.describe(caller.workspaceId));
      case "prs_list":
        return { text: await links.describe(caller.workspaceId) };
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

function report(verb: string, result: LinkResult, current: string): ToolResult {
  const lines = [
    result.linked.length ? `${verb}: ${result.linked.join(", ")}` : `${verb} nothing.`,
    ...result.errors.map((error) => `Error: ${error}`),
    "",
    "Linked to this workspace now:",
    current,
  ];
  return { text: lines.join("\n"), isError: result.linked.length === 0 && result.errors.length > 0 };
}

/** A prompt to run one of these tools: Claude names the tool, Codex asks to approve the MCP server's call. */
export function isPrsPermission(request: Pick<AgentPermissionRequest, "kind" | "name" | "metadata">): boolean {
  if (request.kind !== "tool") return false;
  if (request.name.startsWith(`mcp__${MCP_SERVER}__`)) return true;
  return request.name === "CodexMcpElicitation" && request.metadata?.serverName === MCP_SERVER;
}

export interface CallerCandidate {
  id: string;
  cwd: string;
  status: string;
  archivedAt?: string | null;
}

/**
 * Codex starts MCP servers without the agent's environment, so its bridge has no PASEO_AGENT_ID, only
 * its working directory. The caller is the live agent there that is mid-turn; null when that is ambiguous.
 */
export function pickCaller(agents: readonly CallerCandidate[], cwd: string): string | null {
  const dir = absolute(cwd);
  const here = agents.filter((agent) => !agent.archivedAt && absolute(agent.cwd) === dir);
  const running = here.filter((agent) => agent.status === "running");
  if (running.length === 1) return running[0]!.id;
  return here.length === 1 ? here[0]!.id : null;
}

const absolute = (path: string) => resolve(path.replace(/^~(?=\/|$)/, homedir()));
