import { openExternalUrl, type PluginButton, type PluginButtonRegistration, type PluginClientContext } from "@getpaseo/plugin/client";
import {
  addressReviewPrompt,
  CREATE_PR_PROMPT,
  fixChecksPrompt,
  listBranches,
  pillsFor,
  type Branch,
  type PillSpec,
  type Pr,
} from "../shared/prs";

// Server reads are cached for 30 s; this only bounds how stale a pill gets while nothing happens.
const POLL_MS = 60_000;

interface AgentInfo {
  workspaceId: string;
  cwd: string;
  running: boolean;
}

/** Composer pills per agent: one per PR on its branch, a summary pill for many, or Create PR for none. */
export function contributePills(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const agents = new Map<string, AgentInfo>();
  const branches = new Map<string, Branch>();
  const pills = new Map<string, Map<string, PluginButtonRegistration>>();

  // send() interrupts a running turn, so prompting is disabled until the agent is idle.
  const send = (agentId: string, text: string) => () => client.paseo.agents.ref(agentId).send(text);

  const prMenu = (agentId: string, pr: Pr, running: boolean): PluginButton["behavior"] => ({
    kind: "menu",
    items: [
      { kind: "item", id: "open", title: `Open #${pr.number}: ${pr.title}`, icon: "ExternalLink", behavior: { kind: "action", onPress: () => openExternalUrl(pr.url) } },
      {
        kind: "item",
        id: "fix-checks",
        title: "Ask agent to fix failing checks",
        icon: "Wrench",
        visible: pr.state === "OPEN" && pr.checks === "failing",
        disabled: running,
        behavior: { kind: "action", onPress: send(agentId, fixChecksPrompt(pr)) },
      },
      {
        kind: "item",
        id: "address-review",
        title: "Ask agent to address the review",
        icon: "MessageSquareReply",
        visible: pr.state === "OPEN" && pr.review === "changes_requested",
        disabled: running,
        behavior: { kind: "action", onPress: send(agentId, addressReviewPrompt(pr)) },
      },
    ],
  });

  const button = (agentId: string, spec: PillSpec, running: boolean): PluginButton => {
    switch (spec.kind) {
      case "pr":
        return { title: spec.pr.title, label: spec.label, icon: spec.icon, behavior: prMenu(agentId, spec.pr, running) };
      case "many":
        return {
          title: "Pull requests",
          label: spec.label,
          icon: spec.icon,
          behavior: {
            kind: "menu",
            items: spec.prs.map((pr) => ({
              kind: "item" as const,
              id: `pr-${pr.number}`,
              title: `#${pr.number} · ${pr.title}`,
              behavior: { kind: "action" as const, onPress: () => openExternalUrl(pr.url) },
            })),
          },
        };
      case "create":
        return {
          title: "Ask the agent to open a pull request",
          label: spec.label,
          icon: spec.icon,
          disabled: running,
          behavior: { kind: "action", onPress: send(agentId, CREATE_PR_PROMPT) },
        };
    }
  };

  const render = (agentId: string) => {
    const agent = agents.get(agentId);
    const current = pills.get(agentId) ?? new Map<string, PluginButtonRegistration>();
    pills.set(agentId, current);
    const specs = agent ? pillsFor(branches.get(agent.cwd)) : [];
    const keep = new Set(specs.map((spec) => spec.key));
    for (const [key, pill] of current) {
      if (keep.has(key)) continue;
      pill.remove();
      current.delete(key);
    }
    if (!agent) return;
    for (const spec of specs) {
      const next = button(agentId, spec, agent.running);
      const pill = current.get(spec.key);
      if (pill) pill.update(next);
      else current.set(spec.key, client.addComposerPill({ id: spec.key, workspaceId: agent.workspaceId, agentId, button: next }));
    }
  };

  const refresh = async (cwds: string[], force = false) => {
    if (!cwds.length || lifetime.signal.aborted) return;
    const result = await client.rpc(listBranches, { cwds, force });
    for (const branch of result.branches) branches.set(branch.cwd, branch);
    const changed = new Set(cwds);
    for (const [agentId, agent] of agents) if (changed.has(agent.cwd)) render(agentId);
  };
  const refreshQuietly = (cwds: string[], force = false) =>
    void refresh(cwds, force).catch((error) => console.error("[prs] refresh failed", error));
  const allCwds = () => [...new Set([...agents.values()].map((agent) => agent.cwd))];

  const upsert = (agent: { id: string; workspaceId?: string | null; cwd: string; status: string; archivedAt?: string | null }) => {
    if (agent.archivedAt || !agent.workspaceId) return drop(agent.id);
    const previous = agents.get(agent.id);
    const running = agent.status === "running" || agent.status === "initializing";
    agents.set(agent.id, { workspaceId: agent.workspaceId, cwd: agent.cwd, running });
    // A turn that just ended may have pushed, opened or merged a PR: read again past the cache.
    if (!previous || previous.cwd !== agent.cwd) refreshQuietly([agent.cwd]);
    else if (previous.running && !running) refreshQuietly([agent.cwd], true);
    else if (previous.running !== running) render(agent.id);
  };
  const drop = (agentId: string) => {
    agents.delete(agentId);
    render(agentId);
    pills.delete(agentId);
  };

  const timer = setInterval(() => refreshQuietly(allCwds()), POLL_MS);

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
          refreshQuietly(allCwds());
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
