import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import {
  canFork,
  createPrPrompt,
  FORKED_FROM_LABEL,
  forkPr,
  linkPrs,
  listPrs,
  listReports,
  pillFor,
  PR_LABEL,
  prAgentFor,
  relatedPrs,
  reportPillFor,
  reportPr,
  unlinkPrs,
  type Branch,
  type Pr,
  type PullRequestPromptSource,
  type ReportState,
  type RowTarget,
} from "../shared/prs";
import { makePopover, type AgentPrs, type PrsStore } from "./PrsPopover";
import { makeReportPopover, type ForkReport, type ReportStore } from "./ReportPopover";
import { createWorkspaceSummaries, summaryState } from "./summary";
import { prChanges, type PrChangesEvent } from "../shared/changes";

/** COMPAT(pluginSubscriptions): the npm SDK pin doesn't type `subscribe` on the plugin client. */
interface SubscribingClient {
  subscribe?: (contract: typeof prChanges, input: Record<string, never>, onEvent: (event: PrChangesEvent) => void) => () => void;
}

// PR changes are pushed (`prChanges`); this backstop catches what no push reports: a checkout switching branches outside a
// turn, a host without plugin subscriptions. It reads git and the server's pushed state, never GitHub's PR state.
const POLL_MS = 5 * 60_000;
// While a fork writes its report, how often to look for the outcome.
const REPORT_POLL_MS = 2_000;

type WorkspaceRef = ReturnType<PluginClientContext["paseo"]["workspaces"]["ref"]>;

interface AgentInfo {
  id: string;
  workspaceId: string;
  cwd: string;
  running: boolean;
  labels: Readonly<Record<string, string>>;
}

type AgentPayload = { id: string; workspaceId?: string | null; cwd: string; status: string; archivedAt?: string | null; labels?: Record<string, string> };

const infoOf = (agent: AgentPayload & { workspaceId: string }): AgentInfo => ({
  id: agent.id,
  workspaceId: agent.workspaceId,
  cwd: agent.cwd,
  running: agent.status === "running" || agent.status === "initializing",
  labels: agent.labels ?? {},
});

// The new agent shows up in the agent list a moment after create returns; navigating before that finds nothing.
const OPEN_WAIT_MS = 5_000;

/**
 * One composer pill per agent: its workspace's PRs (branch ∪ linked), or Create PR for none.
 * `openAgent` navigates to an agent; popovers have no navigation of their own.
 */
export function contributePills(client: PluginClientContext, openAgent: (agentId: string) => void): () => void {
  const lifetime = new AbortController();
  const agents = new Map<string, AgentInfo>();
  const branches = new Map<string, Branch>();
  const linked = new Map<string, Pr[]>();
  // Workspaces whose PRs couldn't be refreshed: GitHub (per the server) or the server itself.
  const staleLinks = new Set<string>();
  const unreachable = new Set<string>();
  const summaries = createWorkspaceSummaries(client);
  const pills = new Map<string, PluginButtonRegistration>();
  // Forks (agents with prs.forkedFrom) get a second pill to report back to their main chat.
  const reports = new Map<string, ReportState>();
  const reportPills = new Map<string, PluginButtonRegistration>();
  const reportViews = new Map<string, ForkReport>();
  // What the popovers read; they re-render when an agent's entry changes.
  const views = new Map<string, AgentPrs>();
  const listeners = new Set<() => void>();

  const refresh = async (workspaces: { workspaceId: string; cwd: string }[], force = false) => {
    if (!workspaces.length || lifetime.signal.aborted) return;
    const forks = forkIds();
    const [result, states] = await Promise.all([
      client.rpc(listPrs, { workspaces, force }).catch((error: unknown) => {
        for (const { workspaceId } of workspaces) unreachable.add(workspaceId);
        renderSummaries();
        throw error;
      }),
      forks.length ? client.rpc(listReports, { agentIds: forks }) : Promise.resolve({ reports: {} }),
    ]);
    for (const branch of result.branches) branches.set(branch.cwd, branch);
    for (const entry of result.links) {
      linked.set(entry.workspaceId, entry.prs);
      if (entry.stale) staleLinks.add(entry.workspaceId);
      else staleLinks.delete(entry.workspaceId);
    }
    for (const { workspaceId } of workspaces) unreachable.delete(workspaceId);
    applyReports(states.reports);
    // Any agent's rows can change: they point at other workspaces that are on the same PRs.
    renderAll();
  };
  const refreshQuietly = (workspaces: { workspaceId: string; cwd: string }[], force = false) =>
    void refresh(workspaces, force).catch((error) => console.error("[prs] refresh failed", error));
  const forkIds = () => [...agents.values()].filter((agent) => agent.labels[FORKED_FROM_LABEL]).map((agent) => agent.id);
  const applyReports = (states: Record<string, ReportState>) => {
    reports.clear();
    for (const [agentId, state] of Object.entries(states)) reports.set(agentId, state);
  };
  const refreshReports = async () => {
    const forks = forkIds();
    if (!forks.length || lifetime.signal.aborted) return;
    applyReports((await client.rpc(listReports, { agentIds: forks })).reports);
    renderAll();
  };
  const all = () => [...new Map([...agents.values()].map((agent) => [`${agent.workspaceId}\0${agent.cwd}`, agent])).values()];

  const store: PrsStore = {
    get: (agentId) => views.get(agentId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (agentId, text) => client.paseo.agents.ref(agentId).send(text),
    async createPr(agentId) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error("This agent is gone");
      const workspace: WorkspaceRef & Partial<PullRequestPromptSource> = client.paseo.workspaces.ref(agent.workspaceId);
      await store.send(agentId, await createPrPrompt(workspace));
    },
    async link(agentId, refs) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error("This agent is gone");
      const result = await client.rpc(linkPrs, { workspaceId: agent.workspaceId, cwd: agent.cwd, refs });
      await refresh([agent]);
      return result;
    },
    async unlink(agentId, url) {
      const agent = agents.get(agentId);
      if (!agent) throw new Error("This agent is gone");
      await client.rpc(unlinkPrs, { workspaceId: agent.workspaceId, cwd: agent.cwd, refs: [url] });
      await refresh([agent]);
    },
    async fork(agentId, prUrl) {
      const { agentId: forked } = await client.rpc(forkPr, { agentId, prUrl });
      await store.open(forked);
    },
    async open(agentId) {
      const started = Date.now();
      while (!agents.has(agentId) && Date.now() - started < OPEN_WAIT_MS) await new Promise<void>((resolve) => setTimeout(resolve, 200));
      openAgent(agentId);
    },
  };
  const behavior: PluginButton["behavior"] = { kind: "popover", Content: makePopover(store) };
  const reportStore: ReportStore = {
    get: (agentId) => reportViews.get(agentId),
    subscribe: store.subscribe,
    async report(agentId, note, archive) {
      reports.set(agentId, await client.rpc(reportPr, { agentId, note: note.trim() || undefined, archive }));
      render(agentId);
    },
    open: store.open,
  };
  const reportBehavior: PluginButton["behavior"] = { kind: "popover", Content: makeReportPopover(reportStore) };

  const render = (agentId: string) => {
    renderReport(agentId);
    const agent = agents.get(agentId);
    const spec = agent ? pillFor(branches.get(agent.cwd), linked.get(agent.workspaceId) ?? []) : null;
    if (!agent || !spec) {
      pills.get(agentId)?.remove();
      pills.delete(agentId);
      if (views.delete(agentId)) for (const listener of listeners) listener();
      return;
    }
    const prs = spec.kind === "prs" ? spec.prs : [];
    const repo = branches.get(agent.cwd)?.repo ?? null;
    const others = [...agents.values()];
    const targets: Record<string, RowTarget> = {};
    for (const pr of prs) {
      const existing = prAgentFor(pr.url, others, branches, agent.workspaceId);
      if (existing) targets[pr.url] = { kind: "open", agentId: existing.id };
      else if (canFork(pr, repo)) targets[pr.url] = { kind: "fork" };
    }
    views.set(agentId, { prs, targets, canCreate: spec.kind === "create", running: agent.running });
    for (const listener of listeners) listener();
    const face = { title: spec.kind === "create" ? "Open or link a pull request" : "Pull requests", label: spec.label, icon: spec.icon };
    // Only the face changes: a new behavior would close an open popover mid-use.
    const pill = pills.get(agentId);
    if (pill) pill.update(face);
    else pills.set(agentId, client.addComposerPill({ id: "prs", workspaceId: agent.workspaceId, agentId, button: { ...face, behavior } }));
  };

  /** The fork's report pill: its PR's state on the face, the report state in the popover. */
  const renderReport = (agentId: string) => {
    const agent = agents.get(agentId);
    const mainAgentId = agent?.labels[FORKED_FROM_LABEL];
    if (!agent || !mainAgentId) {
      reportPills.get(agentId)?.remove();
      reportPills.delete(agentId);
      reportViews.delete(agentId);
      return;
    }
    const url = agent.labels[PR_LABEL]?.toLowerCase();
    const pr = relatedPrs(branches.get(agent.cwd), linked.get(agent.workspaceId) ?? []).find((row) => row.url.toLowerCase() === url);
    const prDone = pr?.state === "MERGED" ? "merged" : pr?.state === "CLOSED" ? "closed" : null;
    reportViews.set(agentId, { mainAgentId, prNumber: pr?.number ?? null, prDone, report: reports.get(agentId), running: agent.running });
    const face = reportPillFor(pr);
    const pill = reportPills.get(agentId);
    if (pill) pill.update(face);
    else reportPills.set(agentId, client.addComposerPill({ id: "prs-report", workspaceId: agent.workspaceId, agentId, button: { ...face, behavior: reportBehavior } }));
  };

  /** One Overview summary item per workspace with a live agent, once its PRs have been read. */
  const renderSummaries = () => {
    const cwds = new Map<string, string>();
    for (const agent of agents.values()) if (!cwds.has(agent.workspaceId)) cwds.set(agent.workspaceId, agent.cwd);
    for (const workspaceId of summaries.workspaceIds()) if (!cwds.has(workspaceId)) summaries.remove(workspaceId);
    for (const [workspaceId, cwd] of cwds) {
      const branch = branches.get(cwd);
      // Before the first read there is nothing to say; an empty list would claim there are no PRs.
      if (!branch || !linked.has(workspaceId)) continue;
      const stale = Boolean(branch.stale) || staleLinks.has(workspaceId) || unreachable.has(workspaceId);
      summaries.set(workspaceId, summaryState(branch, linked.get(workspaceId) ?? [], stale));
    }
  };

  const clear = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    for (const pill of reportPills.values()) pill.remove();
    reportPills.clear();
    reportViews.clear();
    agents.clear();
    views.clear();
    for (const listener of listeners) listener();
  };
  const renderAll = () => {
    for (const agentId of agents.keys()) render(agentId);
    renderSummaries();
  };

  const upsert = (agent: AgentPayload) => {
    if (agent.archivedAt || !agent.workspaceId) return drop(agent.id);
    const previous = agents.get(agent.id);
    const next = infoOf({ ...agent, workspaceId: agent.workspaceId });
    const running = next.running;
    agents.set(agent.id, next);
    // A turn that just ended may have pushed, opened, merged or linked a PR: read again past the cache.
    if (!previous || previous.cwd !== agent.cwd || previous.workspaceId !== next.workspaceId) refreshQuietly([next]);
    else if (previous.running && !running) refreshQuietly([next], true);
    else if (previous.running !== running) render(agent.id);
  };
  const drop = (agentId: string) => {
    const known = agents.delete(agentId);
    render(agentId);
    // Rows elsewhere may have offered Open for this agent, and its workspace may have no agent left.
    if (known) renderAll();
  };

  const timer = setInterval(() => refreshQuietly(all()), POLL_MS);
  // The host pushed a change to a PR some pill shows: re-read now. Hosts without subscriptions rely on the poll.
  const subscribing = client as PluginClientContext & SubscribingClient;
  const stopChanges = typeof subscribing.subscribe === "function" ? subscribing.subscribe(prChanges, {}, () => refreshQuietly(all())) : () => undefined;
  // The server forwards a report as the fork's turn ends, a moment after the agent goes idle here.
  const reportTimer = setInterval(() => {
    if ([...reports.values()].some((report) => report.state === "writing")) {
      void refreshReports().catch((error) => console.error("[prs] report refresh failed", error));
    }
  }, REPORT_POLL_MS);

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          clear();
          for (const { agent } of entries) {
            if (agent.archivedAt || !agent.workspaceId) continue;
            agents.set(agent.id, infoOf({ ...agent, workspaceId: agent.workspaceId }));
          }
          refreshQuietly(all());
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsert(update.agent);
          else drop(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[prs] agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    clearInterval(timer);
    stopChanges();
    clearInterval(reportTimer);
    clear();
    // Kept across a new agent snapshot, which prunes them on the next render; gone only with the plugin.
    summaries.clear();
  };
}
