/**
 * paseo-inbox's review screen, opened by PR link: it shows that PR's newest review draft, or offers to start one.
 * Needs a host whose popovers get `navigation.openPluginScreen` (the FSH build). @getpaseo/plugin 0.12 has no
 * type for it yet, hence the local one; drop it once the SDK ships `openPluginScreen`.
 */
interface ScreenNavigation {
  openPluginScreen?(input: { pluginId: string; screenId: string; params?: Record<string, string>; workspaceId?: string }): void;
  hasPluginScreen?(input: { pluginId: string; screenId: string }): boolean;
}

const REVIEW = { pluginId: "paseo-inbox", screenId: "review" } as const;

/** Opens a PR's review in the Inbox, or null when the host or the Inbox can't. */
export function inboxReview(props: object): ((prUrl: string) => void) | null {
  const { navigation, workspaceId } = props as { navigation?: ScreenNavigation; workspaceId?: unknown };
  const open = navigation?.openPluginScreen;
  if (!open || !navigation.hasPluginScreen?.(REVIEW)) return null;
  // From a workspace (a panel or a pill popover), the review opens as a tab there; hosts without tab support ignore it.
  const tab = typeof workspaceId === "string" ? { workspaceId } : {};
  return (prUrl) => open({ ...REVIEW, params: { pr: prUrl }, ...tab });
}
