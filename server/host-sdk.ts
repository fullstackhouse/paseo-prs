/** One pull request as the host reads it. Mirrors `ChangeRequestRead` in fullstackhouse/paseo#270's protocol. */
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

// COMPAT(changeRequestsRead): FSH hosts from fullstackhouse/paseo#270 read PR state for plugins (one batched,
// rate-limited, cached reader for every plugin and the daemon). Older hosts lack it; the npm client has no type for it.
declare module "@getpaseo/client" {
  interface PaseoApi {
    readonly changeRequests?: { read(urls: string[]): Promise<HostChangeRequestRead[]> };
  }
}
