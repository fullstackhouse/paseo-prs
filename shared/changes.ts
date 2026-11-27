import { z } from "zod";

export const PrChangesEventSchema = z.object({ type: z.literal("changed") });
export type PrChangesEvent = z.infer<typeof PrChangesEventSchema>;

/**
 * Pushes an event whenever the host's PR service pushes a change to a PR or branch this plugin shows, so clients re-read
 * `prs.list` at once instead of on their backstop poll. COMPAT(pluginSubscriptions): hosts from Paseo 0.15 serve a
 * contract with `event` as a subscription, but the npm SDK pin has no `defineSubscription`, so the contract is written
 * out as the plain object that function returns. Clients on hosts without `subscribe` keep polling.
 */
export const prChanges = {
  name: "prs.changes",
  input: z.object({}),
  event: PrChangesEventSchema,
} as const;
