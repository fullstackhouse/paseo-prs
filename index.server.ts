import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BranchCache } from "./server/github";
import { listBranches } from "./shared/prs";

export default function contribute(server: PluginServerContext) {
  const cache = new BranchCache();
  server.handle(listBranches, async ({ cwds, force }) => ({
    branches: await Promise.all([...new Set(cwds)].map((cwd) => cache.get(cwd, force))),
  }));
  return () => {};
}
