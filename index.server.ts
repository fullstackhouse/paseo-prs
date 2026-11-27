import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AutoLinker } from "./server/autolink";
import { installBridge } from "./server/bridge";
import { forkIntoPr } from "./server/fork";
import { ChangeFeed } from "./server/changes";
import { PrFollows } from "./server/follows";
import { hostPrFetcher, readBranch, readPrDetails } from "./server/github";
import { Links, type WorkspaceRef } from "./server/links";
import { listen } from "./server/listener";
import { Reports, ReportStore } from "./server/reports";
import { dataDir, LinkStore } from "./server/store";
import { callTool, INSTRUCTIONS, isPrsPermission, pickCaller, TOOLS, withPrsTools } from "./server/tools";
import { toolGrantSupport } from "./server/tool-grants";
import { prChanges, type PrChangesEvent } from "./shared/changes";
import { forkPr, linkPrs, listPrs, listReports, reportPr, unlinkPrs } from "./shared/prs";

/** COMPAT(pluginSubscriptions): the npm SDK pin types only RPC handlers. */
type SubscriptionHandle = (
  contract: typeof prChanges,
  handler: (input: Record<string, never>, context: { push: (event: PrChangesEvent) => Promise<unknown>; signal: AbortSignal }) => void,
) => void;

// Subscriptions no client asked about lately are dropped this often.
const PRUNE_MS = 5 * 60_000;

export default function contribute(server: PluginServerContext) {
  const dir = dataDir();
  const mcp = installBridge(dir);
  // The daemon session behind `paseo` lives as long as this subprocess; any hook or handler hands it over.
  let paseo: PaseoApi | null = null;
  // PR state comes from the host's PR service, pushed; gh only lists a repo's open PRs for stacks.
  const changes = new ChangeFeed();
  const follows = new PrFollows(() => paseo, () => changes.notify());
  const links = new Links(new LinkStore(dir), follows, hostPrFetcher(() => paseo));
  const pruning = setInterval(() => void follows.prune(), PRUNE_MS);
  const capture = (api: PaseoApi) => {
    paseo ??= api;
  };
  const reports = new Reports(() => paseo, new ReportStore(dir), readPrDetails);
  const autoLinker = new AutoLinker(() => paseo, links);

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

  const exactGrants = toolGrantSupport(async () => {
    if (!paseo) throw new Error("no daemon session yet");
    return paseo.providers.snapshot();
  });
  server.before("agent.create", async ({ request }, { paseo: api }) => {
    capture(api);
    return { ...request, config: withPrsTools(request.config, mcp, await exactGrants(request.config.provider)) };
  });
  // Plan mode and Codex prompt even for preapproved MCP tools. These only touch the PR list, so allow them here.
  server.on("agent.permission_requested", async (event, { paseo: api }) => {
    const { agent, request } = event;
    capture(api);
    if (!isPrsPermission(request, (event as { tool?: { server: string } }).tool)) return;
    await api.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });

  server.on("agent.turn_started", ({ agent }, { paseo: api }) => {
    capture(api);
    autoLinker.turnStarted(agent.id);
  });
  server.on("agent.turn_ended", async ({ agent, outcome }, { paseo: api }) => {
    capture(api);
    // Only the turn the Done button started is forwarded; Reports ignores every other turn.
    await Promise.all([
      reports.turnEnded(agent, outcome),
      autoLinker.turnEnded(agent).catch((error) => console.error("[prs] auto-link failed", error)),
    ]);
  });

  server.handle(listPrs, async ({ workspaces, force }, { paseo: api }) => {
    capture(api);
    // Older clients send no `active`: treat their workspaces as looked at, as before.
    const activeCwds = new Map<string, boolean>();
    const activeIds = new Map<string, boolean>();
    for (const { workspaceId, cwd, active = true } of workspaces) {
      activeCwds.set(cwd, (activeCwds.get(cwd) ?? false) || active);
      activeIds.set(workspaceId, (activeIds.get(workspaceId) ?? false) || active);
    }
    const [read, linked] = await Promise.all([
      Promise.all([...activeCwds].map(([cwd, active]) => readBranch(cwd, force === true, follows, active))),
      links.list([...activeIds].map(([workspaceId, active]) => ({ workspaceId, active }))),
    ]);
    return { branches: read, links: linked };
  });
  // COMPAT(pluginSubscriptions): hosts from Paseo 0.15 serve this contract (it has `event`) as a subscription.
  (server.handle as unknown as SubscriptionHandle).call(server, prChanges, (_input, { push, signal }) => changes.serve(push, signal));
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
    clearInterval(pruning);
    await follows.close();
    (await listening).close();
  };
}
