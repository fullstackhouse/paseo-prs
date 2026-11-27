import type { PaseoApi } from "@getpaseo/client";
import type { HostBranchRead, HostChangeRequestRead, HostSubscriptionTarget, HostSubscriptionUpdate } from "../server/host-sdk";

export const read = (url: string, overrides: Partial<Extract<HostChangeRequestRead, { ok: true }>> = {}): HostChangeRequestRead => {
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
  return {
    url,
    ok: true,
    number,
    title: `PR ${number}`,
    state: "open",
    isDraft: false,
    reviewDecision: null,
    checksState: "passing",
    checks: [],
    headSha: "abc",
    ...overrides,
  };
};

/**
 * A host PR service over fixed reads: `subscribe` answers each followed URL and branch from `reads` / `branches`,
 * `push` delivers an update to every live subscription that follows it.
 */
export function fakeHost(options: { reads?: HostChangeRequestRead[]; branches?: HostBranchRead[] } = {}) {
  let reads = options.reads ?? [];
  const branches = options.branches ?? [];
  const subscriptions: { target: HostSubscriptionTarget; onUpdate: (update: HostSubscriptionUpdate) => void; live: boolean }[] = [];
  const readCalls: string[][] = [];
  const answer = (url: string): HostChangeRequestRead =>
    reads.find((entry) => entry.url.toLowerCase() === url.toLowerCase()) ?? { url, ok: false, error: "Not found", reason: "not_found" };
  const api = {
    changeRequests: {
      read: async (urls: string[]) => {
        readCalls.push(urls);
        return urls.map(answer);
      },
      subscribe: async (target: HostSubscriptionTarget, onUpdate: (update: HostSubscriptionUpdate) => void) => {
        const subscription = { target, onUpdate, live: true };
        subscriptions.push(subscription);
        const followedBranches = (target.branches ?? []).map(
          (branch) =>
            branches.find((entry) => entry.headRef === branch.headRef && branch.repo.toLowerCase().endsWith(entry.repo.toLowerCase())) ?? {
              repo: branch.repo,
              headRef: branch.headRef,
              ok: true,
              urls: [],
            },
        );
        const urls = [...(target.urls ?? []), ...followedBranches.flatMap((branch) => branch.urls)];
        return {
          initial: { results: urls.map(answer), branches: followedBranches },
          unsubscribe: async () => {
            subscription.live = false;
          },
        };
      },
    },
  } as unknown as PaseoApi;
  return {
    api,
    subscriptions,
    readCalls,
    live: () => subscriptions.filter((subscription) => subscription.live),
    /** Replaces the host's reads and pushes each to the live subscriptions that follow it. */
    push(results: HostChangeRequestRead[]) {
      reads = [...reads.filter((entry) => !results.some((result) => result.url === entry.url)), ...results];
      for (const subscription of subscriptions) {
        if (!subscription.live) continue;
        const followed = results.filter(
          (result) =>
            (subscription.target.urls ?? []).includes(result.url) ||
            (subscription.target.branches ?? []).some((branch) =>
              branches.some((entry) => entry.headRef === branch.headRef && entry.urls.includes(result.url)),
            ),
        );
        if (followed.length) subscription.onUpdate({ results: followed, branches: [] });
      }
    },
  };
}
