import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePills } from "./client/pills";
import { linkPrs } from "./shared/prs";

export default function contribute(client: PluginClientContext) {
  // Links from any agent, including one on the default branch, which has no pill until something is linked.
  client.addSlashCommand({
    name: "link-pr",
    description: "Link pull requests to this workspace's PRs pill",
    argumentHint: "<PR URL or #123> …",
    context: "agent",
    async onSubmit({ args, agent, workspace, rpc }) {
      const refs = args.split(/[\s,]+/).filter(Boolean);
      if (!refs.length) throw new Error("Give a PR URL or #123");
      const result = await rpc(linkPrs, { workspaceId: agent.workspaceId, cwd: workspace.directory, refs });
      if (result.errors.length) throw new Error(result.errors.join("\n"));
    },
  });
  return contributePills(client);
}
