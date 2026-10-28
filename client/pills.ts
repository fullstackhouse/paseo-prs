import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { linkPrs, listPrs, pillFor, unlinkPrs, type Branch, type Pr } from "../shared/prs";
import { makePopover, type AgentPrs, type PrsStore } from "./PrsPopover";

// Server reads are cached for 30 s; this only bounds how stale a pill gets while nothing happens.
const POLL_MS = 60_000;

interface AgentInfo {
  workspaceId: string;
  cwd: string;
  running: boolean;
}

/** One composer pill per agent: its workspace's PRs (branch ∪ linked), or Create PR for none. */
export function contributePills(client: PluginClientContext): () => void {
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
    const cwds = new Set(workspaces.map((workspace) => workspace.cwd));
    const ids = new Set(workspaces.map((workspace) => workspace.workspaceId));
    for (const [agentId, agent] of agents) if (cwds.has(agent.cwd) || ids.has(agent.workspaceId)) render(agentId);
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
    views.set(agentId, { prs: spec.kind === "prs" ? spec.prs : [], canCreate: spec.kind === "create", running: agent.running });
    for (const listener of listeners) listener();
    const face = { title: spec.kind === "create" ? "Open or link a pull request" : "Pull requests", label: spec.label, icon: spec.icon };
    // Only the face changes: a new behavior would close an open popover mid-use.
    const pill = pills.get(agentId);
    if (pill) pill.update(face);
    else pills.set(agentId, client.addComposerPill({ id: "prs", workspaceId: agent.workspaceId, agentId, button: { ...face, behavior } }));
  };

  const upsert = (agent: { id: string; workspaceId?: string | null; cwd: string; status: string; archivedAt?: string | null }) => {
    if (agent.archivedAt || !agent.workspaceId) return drop(agent.id);
    const previous = agents.get(agent.id);
    const running = agent.status === "running" || agent.status === "initializing";
    const next = { workspaceId: agent.workspaceId, cwd: agent.cwd, running };
    agents.set(agent.id, next);
    // A turn that just ended may have pushed, opened, merged or linked a PR: read again past the cache.
    if (!previous || previous.cwd !== agent.cwd || previous.workspaceId !== next.workspaceId) refreshQuietly([next]);
    else if (previous.running && !running) refreshQuietly([next], true);
    else if (previous.running !== running) render(agent.id);
  };
  const drop = (agentId: string) => {
    agents.delete(agentId);
    render(agentId);
  };

  const timer = setInterval(() => refreshQuietly(all()), POLL_MS);

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const agentId of [...agents.keys()]) drop(agentId);
          for (const { agent } of entries) {
            if (agent.archivedAt || !agent.workspaceId) continue;
            const running = agent.status === "running" || agent.status === "initializing";
            agents.set(agent.id, { workspaceId: agent.workspaceId, cwd: agent.cwd, running });
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
    for (const agentId of [...agents.keys()]) drop(agentId);
  };
}
