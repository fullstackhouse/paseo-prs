import type { PaseoApi } from "@getpaseo/client";
import { prUrl, type Pr, type PrRef } from "../shared/prs";
import type { HostBranchRead, HostChangeRequestRead, HostSubscription, HostSubscriptionTarget, HostSubscriptionUpdate } from "./host-sdk";

/** A target nobody asked about for this long is unsubscribed. */
export const UNUSED_MS = 10 * 60_000;

type Subscribe = (target: HostSubscriptionTarget, onUpdate: (update: HostSubscriptionUpdate) => void) => Promise<HostSubscription>;

interface Entry {
  subscription: Promise<HostSubscription | null>;
  results: Map<string, HostChangeRequestRead>;
  branch: HostBranchRead | null;
  usedAt: number;
}

const REVIEWS: Record<string, Pr["review"]> = {
  approved: "approved",
  changes_requested: "changes_requested",
  review_required: "review_required",
};

/** The host's read in the plugin's `Pr` shape. */
export function prOf(read: Extract<HostChangeRequestRead, { ok: true }>): Pr {
  return {
    number: read.number,
    title: read.title,
    url: read.url,
    state: read.state === "merged" ? "MERGED" : read.state === "closed" ? "CLOSED" : "OPEN",
    draft: read.isDraft,
    checks: read.checksState,
    failing: read.checks.filter((check) => check.state === "failing").length,
    review: REVIEWS[read.reviewDecision ?? ""] ?? "none",
  };
}

export const unavailable = (ref: PrRef): Pr => ({
  number: ref.number,
  title: `${ref.repo}#${ref.number}`,
  url: prUrl(ref),
  state: "UNKNOWN",
  draft: false,
  checks: "none",
  failing: 0,
  review: "none",
});

/** `owner/name` and number from a GitHub PR URL. */
function refOf(url: string): PrRef | null {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

/**
 * PR state from the host's PR service (`paseo.changeRequests.subscribe`, fullstackhouse/paseo#285): one subscription per
 * branch or PR this plugin shows. The host reads each PR once for every subscriber in the daemon, at the pace the PR
 * needs, and pushes changes; this keeps the last state of each and calls `onChange` so clients re-read at once. Nothing
 * here polls GitHub. A target no client asked about for `UNUSED_MS` is unsubscribed on the next `prune`.
 *
 * Hosts without `subscribe` can't show PR state: the rows read unavailable and stale, and the log says to update Paseo.
 */
export class PrFollows {
  private readonly entries = new Map<string, Entry>();
  private warned = false;

  constructor(
    private readonly paseo: () => PaseoApi | null,
    private readonly onChange: () => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** The PRs whose head is `headRef` in `repo` (`owner/name`), newest first. */
  async branch(repo: string, headRef: string): Promise<{ prs: Pr[]; stale: boolean }> {
    const entry = await this.follow(`branch:${repo.toLowerCase()}\0${headRef}`, {
      branches: [{ repo: `https://github.com/${repo}`, headRef }],
      // The workspace's own PRs: shown on its pill whenever the agent is.
      priority: "visible",
    });
    const branch = entry?.branch;
    if (!entry || !branch) return { prs: [], stale: true };
    const prs = branch.urls.map((url) => this.prAt(entry, url));
    const stale = !branch.ok || branch.urls.some((url) => !entry.results.get(key(url))?.ok);
    return { prs, stale };
  }

  /** Each PR's state by URL; `stale` lists the ones the host couldn't read the last time it tried. */
  async prs(refs: readonly PrRef[], priority: "visible" | "background"): Promise<{ prs: Map<string, Pr>; stale: Set<string> }> {
    const prs = new Map<string, Pr>();
    const stale = new Set<string>();
    await Promise.all(
      refs.map(async (ref) => {
        const url = prUrl(ref);
        const entry = await this.follow(`pr:${key(url)}`, { urls: [url], priority });
        prs.set(url, entry ? this.prAt(entry, url) : unavailable(ref));
        if (!entry?.results.get(key(url))?.ok) stale.add(url);
      }),
    );
    return { prs, stale };
  }

  /** Unsubscribes targets no client asked about lately. */
  async prune(): Promise<void> {
    const cutoff = this.now() - UNUSED_MS;
    const done: Promise<unknown>[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.usedAt >= cutoff) continue;
      this.entries.delete(id);
      done.push(entry.subscription.then((subscription) => subscription?.unsubscribe()).catch(() => undefined));
    }
    await Promise.all(done);
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.subscription.then((subscription) => subscription?.unsubscribe()).catch(() => undefined)));
  }

  /** The last state of `url` in `entry`: a failed or paused read keeps what came before it. */
  private prAt(entry: Entry, url: string): Pr {
    const read = entry.results.get(key(url));
    if (read?.ok) return prOf(read);
    const last = this.lastGood.get(key(url));
    if (last) return last;
    const ref = refOf(url);
    return ref ? unavailable(ref) : { ...unavailable({ repo: url, number: 0 }), url };
  }

  /** The newest successful read of each PR across every entry, kept through failures and pauses. */
  private readonly lastGood = new Map<string, Pr>();

  private async follow(id: string, target: HostSubscriptionTarget): Promise<Entry | null> {
    const existing = this.entries.get(id);
    if (existing) {
      existing.usedAt = this.now();
      await existing.subscription;
      return existing;
    }
    const subscribe = this.subscriber();
    if (!subscribe) return null;
    const entry: Entry = { subscription: Promise.resolve(null), results: new Map(), branch: null, usedAt: this.now() };
    entry.subscription = subscribe(target, (update) => {
      this.apply(entry, update);
      this.onChange();
    }).then(
      (subscription) => {
        this.apply(entry, subscription.initial);
        return subscription;
      },
      (error: unknown) => {
        // Not kept: the next read subscribes again.
        if (this.entries.get(id) === entry) this.entries.delete(id);
        console.error(`[prs] following ${id.replace("\0", " ")}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      },
    );
    this.entries.set(id, entry);
    await entry.subscription;
    return entry;
  }

  private apply(entry: Entry, update: HostSubscriptionUpdate): void {
    for (const read of update.results) {
      entry.results.set(key(read.url), read);
      if (read.ok) this.lastGood.set(key(read.url), prOf(read));
    }
    // A subscription follows one branch at most.
    if (update.branches[0]) entry.branch = update.branches[0];
  }

  private subscriber(): Subscribe | null {
    const api = this.paseo();
    const changeRequests = api?.changeRequests;
    // COMPAT(changeRequestSubscriptions): hosts before fullstackhouse/paseo#285 have no subscribe.
    if (changeRequests?.subscribe) return changeRequests.subscribe.bind(changeRequests);
    if (api && !this.warned) {
      this.warned = true;
      console.error("[prs] this Paseo can't follow pull requests for plugins; update it to see PR state");
    }
    return null;
  }
}

const key = (url: string) => url.toLowerCase();
