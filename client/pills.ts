import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { canFork, forkPr, linkPrs, listPrs, pillFor, prAgentFor, unlinkPrs, type Branch, type Pr, type RowTarget } from "../shared/prs";
import { makePopover, type AgentPrs, type PrsStore } from "./PrsPopover";

// Server reads are cached for 30 s; this only bounds how stale a pill gets while nothing happens.
const POLL_MS = 60_000;

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
  const pills = new Map<string, PluginButtonRegistration>();
  // What the popovers read; they re-render when an agent's entry changes.
  const views = new Map<string, AgentPrs>();
  const listeners = new Set<() => void>();

  const refresh = async (workspaces: { workspaceId: string; cwd: string }[], force = false) => {
    if (!workspaces.length || lifetime.signal.aborted) return;
    const result = await client.rpc(listPrs, { workspaces, force });
    for (const branch of result.branches) branches.set(branch.cwd, branch);
    for (const entry of result.links) linked.set(entry.workspaceId, entry.prs);
    // Any agent's rows can change: they point at other workspaces that are on the same PRs.
    renderAll();
  };
  const refreshQuietly = (workspaces: { workspaceId: string; cwd: string }[], force = false) =>
    void refresh(workspaces, force).catch((error) => console.error("[prs] refresh failed", error));
  const all = () => [...new Map([...agents.values()].map((agent) => [`${agent.workspaceId}\0${agent.cwd}`, agent])).values()];

  const store: PrsStore = {
    get: (agentId) => views.get(agentId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (agentId, text) => client.paseo.agents.ref(agentId).send(text),
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

  const render = (agentId: string) => {
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
      const existing = pr.onBranch ? null : prAgentFor(pr.url, others, branches, agent.workspaceId);
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

  const clear = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    agents.clear();
    views.clear();
    for (const listener of listeners) listener();
  };
  const renderAll = () => {
    for (const agentId of agents.keys()) render(agentId);
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
    // Rows elsewhere may have offered Open for this agent.
    if (known) renderAll();
  };

  const timer = setInterval(() => refreshQuietly(all()), POLL_MS);

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
    clear();
  };
}
