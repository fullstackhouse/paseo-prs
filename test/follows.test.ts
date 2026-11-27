import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { ChangeFeed, PUSH_DELAY_MS } from "../server/changes";
import { PrFollows, UNUSED_MS } from "../server/follows";
import { fakeHost, read } from "./fake-host";

const A = "https://github.com/o/r/pull/1";
const B = "https://github.com/o/r/pull/2";

describe("PrFollows", () => {
  afterEach(() => vi.restoreAllMocks());

  it("subscribes once per PR, and reads from what the host pushed after that", async () => {
    const host = fakeHost({ reads: [read(A), read(B, { state: "merged" })] });
    const follows = new PrFollows(() => host.api);
    const first = await follows.prs([{ repo: "o/r", number: 1 }, { repo: "o/r", number: 2 }], "visible");
    expect([...first.prs.values()].map((pr) => [pr.number, pr.state])).toEqual([
      [1, "OPEN"],
      [2, "MERGED"],
    ]);
    expect(first.stale.size).toBe(0);
    await follows.prs([{ repo: "o/r", number: 1 }], "visible");
    expect(host.subscriptions.map((subscription) => subscription.target)).toEqual([
      { urls: [A], priority: "visible" },
      { urls: [B], priority: "visible" },
    ]);
    // Nothing read the PRs: the plugin only subscribed.
    expect(host.readCalls).toEqual([]);
  });

  it("takes pushed changes and tells its clients", async () => {
    const host = fakeHost({ reads: [read(A)] });
    const onChange = vi.fn();
    const follows = new PrFollows(() => host.api, onChange);
    await follows.prs([{ repo: "o/r", number: 1 }], "background");
    host.push([read(A, { checksState: "failing", checks: [{ name: "test", state: "failing" }] })]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const { prs } = await follows.prs([{ repo: "o/r", number: 1 }], "background");
    expect(prs.get(A)).toMatchObject({ checks: "failing", failing: 1 });
  });

  it("keeps a PR's last state, marked stale, while the host pauses reads", async () => {
    const host = fakeHost({ reads: [read(A, { title: "Before" })] });
    const follows = new PrFollows(() => host.api);
    await follows.prs([{ repo: "o/r", number: 1 }], "visible");
    host.push([{ url: A, ok: false, error: "Paused", reason: "paused", retryAt: 10_000 }]);
    const { prs, stale } = await follows.prs([{ repo: "o/r", number: 1 }], "visible");
    expect(prs.get(A)).toMatchObject({ title: "Before", state: "OPEN" });
    expect([...stale]).toEqual([A]);
  });

  it("lists a branch's PRs from a branch subscription, newest first", async () => {
    const host = fakeHost({
      reads: [read(A, { state: "closed" }), read(B)],
      branches: [{ repo: "o/r", headRef: "feat/x", ok: true, urls: [B, A] }],
    });
    const follows = new PrFollows(() => host.api);
    const branch = await follows.branch("o/r", "feat/x");
    expect(branch.prs.map((pr) => [pr.number, pr.state])).toEqual([
      [2, "OPEN"],
      [1, "CLOSED"],
    ]);
    expect(branch.stale).toBe(false);
    expect(host.subscriptions[0]?.target).toEqual({ branches: [{ repo: "https://github.com/o/r", headRef: "feat/x", includeClosed: true }], priority: "visible" });
  });

  it("unsubscribes what no client asked about for a while", async () => {
    let now = 0;
    const host = fakeHost({ reads: [read(A), read(B)] });
    const follows = new PrFollows(() => host.api, () => undefined, () => now);
    await follows.prs([{ repo: "o/r", number: 1 }, { repo: "o/r", number: 2 }], "visible");
    now = UNUSED_MS - 1;
    await follows.prs([{ repo: "o/r", number: 2 }], "visible");
    now = UNUSED_MS + 1;
    await follows.prune();
    expect(host.live().map((subscription) => subscription.target.urls)).toEqual([[B]]);
  });

  it("says to update Paseo once when the host can't follow PRs, and shows them unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const follows = new PrFollows(() => ({ changeRequests: { read: async () => [] } }) as unknown as PaseoApi);
    const first = await follows.prs([{ repo: "o/r", number: 1 }], "visible");
    await follows.branch("o/r", "feat/x");
    expect(first.prs.get(A)).toMatchObject({ state: "UNKNOWN" });
    expect([...first.stale]).toEqual([A]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("update it");
  });
});

describe("ChangeFeed", () => {
  it("pushes one event per burst to each live client, and stops when it aborts", async () => {
    vi.useFakeTimers();
    try {
      const feed = new ChangeFeed();
      const push = vi.fn(async () => undefined);
      const controller = new AbortController();
      feed.serve(push, controller.signal);
      feed.notify();
      feed.notify();
      await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
      expect(push).toHaveBeenCalledTimes(1);
      controller.abort();
      feed.notify();
      await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
