import type { PrChangesEvent } from "../shared/changes";

/** Updates coalesce for this long, so a batch of PRs the host read together is one event. */
export const PUSH_DELAY_MS = 50;

/** Fans `notify()` out to every client subscription, one event per burst. */
export class ChangeFeed {
  private readonly listeners = new Set<() => void>();

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Serves one client's `prChanges` subscription until `signal` aborts. */
  serve(push: (event: PrChangesEvent) => Promise<unknown>, signal: AbortSignal): void {
    if (signal.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (!signal.aborted) void push({ type: "changed" }).catch(() => undefined);
    };
    const listener = () => {
      timer ??= setTimeout(flush, PUSH_DELAY_MS);
    };
    this.listeners.add(listener);
    signal.addEventListener(
      "abort",
      () => {
        this.listeners.delete(listener);
        if (timer) clearTimeout(timer);
      },
      { once: true },
    );
  }
}
