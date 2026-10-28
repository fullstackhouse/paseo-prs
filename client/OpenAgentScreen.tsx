import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect } from "react";
import { Text, View } from "react-native";

export const OPEN_AGENT_SCREEN = "open-agent";

/**
 * Pill popovers get no `navigation`, screens do: the popover opens this screen, which hands the agent
 * to the host's navigation at once.
 */
export function OpenAgentScreen({ theme, navigation, params }: PluginScreenProps) {
  const agentId = params.agentId;
  useEffect(() => {
    if (agentId && navigation) navigation.openAgent({ agentId });
  }, [agentId, navigation]);
  const text = !agentId ? "No agent to open." : navigation ? "Opening the agent…" : "This Paseo version cannot open agents from plugins.";
  return (
    <View style={{ flex: 1, padding: 24, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{text}</Text>
    </View>
  );
}
