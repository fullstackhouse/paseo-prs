/** One pull request as the host reads it. Mirrors `ChangeRequestRead` in fullstackhouse/paseo's protocol. */
export type HostChangeRequestRead =
  | {
      url: string;
      ok: true;
      number: number;
      title: string;
      state: "open" | "merged" | "closed";
      isDraft: boolean;
      mergeable?: "mergeable" | "conflicting" | "unknown";
      reviewDecision: "approved" | "changes_requested" | "review_required" | null;
      checksState: "passing" | "failing" | "pending" | "none";
      checks: { name: string; state: "passing" | "failing" | "pending" | "skipped"; url?: string }[];
      headSha: string;
      author?: string | null;
      reviewRequestCount?: number;
      viewerCanMergeAsAdmin?: boolean;
    }
  | {
      url: string;
      ok: false;
      error: string;
      /** Missing on the first #270 builds; read it as "error". */
      reason?: "paused" | "not_found" | "unsupported" | "error";
      /** For "paused": when the host reads again, epoch ms. */
      retryAt?: number;
    };

/** The PRs whose head is a branch, newest first. Mirrors `ChangeRequestBranchRead` (fullstackhouse/paseo#285). */
export interface HostBranchRead {
  repo: string;
  headRef: string;
  ok: boolean;
  urls: string[];
  error?: string;
  reason?: "paused" | "not_found" | "unsupported" | "error";
  retryAt?: number;
}

/** What a subscription follows. Mirrors `ChangeRequestSubscriptionTarget` (fullstackhouse/paseo#285). */
export interface HostSubscriptionTarget {
  urls?: string[];
  branches?: { repo: string; headRef: string; includeClosed?: boolean }[];
  priority?: "visible" | "background";
  include?: "deployments"[];
}

/** Every result and branch at subscribe time, then only what changed. */
export interface HostSubscriptionUpdate {
  results: HostChangeRequestRead[];
  branches: HostBranchRead[];
}

export interface HostSubscription {
  initial: HostSubscriptionUpdate;
  unsubscribe(): Promise<void>;
}

export interface HostChangeRequests {
  read(urls: string[]): Promise<HostChangeRequestRead[]>;
  /** FSH hosts from fullstackhouse/paseo#285; absent before. */
  subscribe?(target: HostSubscriptionTarget, onUpdate: (update: HostSubscriptionUpdate) => void): Promise<HostSubscription>;
}

// COMPAT(changeRequestsRead): FSH hosts from fullstackhouse/paseo#270 read PR state for plugins, and from #285
// (COMPAT(changeRequestSubscriptions)) follow PRs and branches with pushed updates. The npm client has no type for
// either; the plugin runs on the host's SDK, so a method is there exactly when the daemon serves it.
declare module "@getpaseo/client" {
  interface PaseoApi {
    readonly changeRequests?: HostChangeRequests;
  }
}
