import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installBridge } from "./server/bridge";
import { forkIntoPr } from "./server/fork";
import { BranchCache, PrCache, readPrDetails } from "./server/github";
import { Links, type WorkspaceRef } from "./server/links";
import { listen } from "./server/listener";
import { Reports, ReportStore } from "./server/reports";
import { dataDir, LinkStore } from "./server/store";
import { callTool, INSTRUCTIONS, isPrsPermission, MCP_SERVER, pickCaller, PREAPPROVED, TOOLS } from "./server/tools";
import { forkPr, linkPrs, listPrs, listReports, reportPr, unlinkPrs } from "./shared/prs";

export default function contribute(server: PluginServerContext) {
  const dir = dataDir();
  const mcp = installBridge(dir);
  const branches = new BranchCache();
  const links = new Links(new LinkStore(dir), new PrCache());
  // The daemon session behind `paseo` lives as long as this subprocess; any hook or handler hands it over.
  let paseo: PaseoApi | null = null;
  const capture = (api: PaseoApi) => {
    paseo ??= api;
  };
  const reports = new Reports(() => paseo, new ReportStore(dir), readPrDetails);

  /** The workspace of the agent behind an MCP call: by PASEO_AGENT_ID, else (Codex) the one mid-turn in its cwd. */
  const callerOf = async (agentId: string | null, cwd: string | null): Promise<WorkspaceRef | null> => {
    if (!paseo) return null;
    if (!agentId && cwd) {
      const { entries } = await paseo.agents.list({
        includeBackground: true,
        filter: { statuses: ["running"], includeBackground: true },
        page: { limit: 200 },
      });
      agentId = pickCaller(entries.map((entry) => entry.agent), cwd);
    }
    if (!agentId) return null;
    const handle = paseo.agents.ref(agentId);
    await handle.refresh();
    return handle.workspaceId && handle.cwd ? { workspaceId: handle.workspaceId, cwd: handle.cwd } : null;
  };

  server.before("agent.create", ({ request }, { paseo: api }) => {
    capture(api);
    const { config } = request;
    const preapproved = [...(config.toolPolicy?.preapproved ?? []), ...PREAPPROVED];
    return { ...request, config: { ...config, mcpServers: { ...config.mcpServers, [MCP_SERVER]: mcp }, toolPolicy: { preapproved } } };
  });
  // Plan mode and Codex prompt even for preapproved MCP tools. These only touch the PR list, so allow them here.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo: api }) => {
    capture(api);
    if (!isPrsPermission(request)) return;
    await api.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });

  // Only the turn the Done button started is forwarded; Reports ignores every other turn.
  server.on("agent.turn_ended", ({ agent, outcome, timeline }, { paseo: api }) => {
    capture(api);
    return reports.turnEnded(agent, outcome, timeline);
  });

  server.handle(listPrs, async ({ workspaces, force }, { paseo: api }) => {
    capture(api);
    const cwds = [...new Set(workspaces.map((workspace) => workspace.cwd))];
    const workspaceIds = [...new Set(workspaces.map((workspace) => workspace.workspaceId))];
    const [read, linked] = await Promise.all([Promise.all(cwds.map((cwd) => branches.get(cwd, force))), links.list(workspaceIds, force)]);
    return { branches: read, links: linked };
  });
  server.handle(linkPrs, ({ refs, ...workspace }, { paseo: api }) => {
    capture(api);
    return links.link(workspace, refs);
  });
  server.handle(unlinkPrs, ({ refs, ...workspace }, { paseo: api }) => {
    capture(api);
    return links.unlink(workspace, refs);
  });

  server.handle(forkPr, (input, { paseo: api }) => {
    capture(api);
    return forkIntoPr(api, input);
  });

  server.handle(reportPr, (input, { paseo: api }) => {
    capture(api);
    return reports.start(api, input);
  });
  server.handle(listReports, ({ agentIds }, { paseo: api }) => {
    capture(api);
    return { reports: reports.states(agentIds) };
  });

  const listening = listen(dir, {
    "/instructions": async () => ({ instructions: INSTRUCTIONS }),
    "/tools": async () => ({ tools: TOOLS }),
    "/call": async ({ agentId, cwd, name, arguments: args }) =>
      callTool(links, await callerOf(agentId ?? null, cwd ?? null), name, args),
  });

  return async () => {
    (await listening).close();
  };
}
