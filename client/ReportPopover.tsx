import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { reportButton, type ReportState } from "../shared/prs";
import { Button, makeStyles } from "./PrsPopover";

/** What one fork's report popover shows. */
export interface ForkReport {
  mainAgentId: string;
  prNumber: number | null;
  /** The PR is merged or closed: the popover says so, the human still decides. */
  prDone: "merged" | "closed" | null;
  report: ReportState | undefined;
  running: boolean;
}

export interface ReportStore {
  get(agentId: string): ForkReport | undefined;
  subscribe(listener: () => void): () => void;
  report(agentId: string, note: string, archive: boolean): Promise<void>;
  open(agentId: string): Promise<void>;
}

export function makeReportPopover(store: ReportStore): ComponentType<PluginButtonContentProps> {
  return function ReportPopover(props: PluginButtonContentProps) {
    const agentId = props.context === "agent" ? props.agentId : null;
    const view = useSyncExternalStore(store.subscribe, () => (agentId ? store.get(agentId) : undefined));
    const styles = useMemo(() => makeStyles(props.theme, props.layout.compact), [props.theme, props.layout.compact]);
    const { colors } = props.theme;
    const [note, setNote] = useState("");
    const [archive, setArchive] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    if (!agentId || !view) return <Text style={styles.muted}>This agent is not a fork of a main chat.</Text>;

    const button = reportButton(view.report, view.running);
    const submit = async () => {
      setError(null);
      setBusy(true);
      try {
        await store.report(agentId, note, archive);
        setNote("");
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(false);
      }
    };
    const status = statusLine(view);

    return (
      <View style={styles.popover}>
        {view.prDone && (
          <Text style={{ color: colors.foreground, fontSize: 13 }}>
            PR {view.prNumber ? `#${view.prNumber} ` : ""}is {view.prDone}. Report and finish here?
          </Text>
        )}
        <Text style={styles.muted}>
          The agent writes a final report: what was decided, commits pushed, what is left, and what the main chat must do. It goes to the main chat
          only when you press the button.
        </Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Note for the report (optional)"
          placeholderTextColor={styles.placeholder.color}
          multiline
          style={[styles.input, { minHeight: 56, textAlignVertical: "top" as const }]}
        />
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: archive }}
          accessibilityLabel="Archive this workspace after reporting"
          onPress={() => setArchive((value) => !value)}
          style={styles.row}
          hitSlop={4}
        >
          <Icon name={archive ? "SquareCheck" : "Square"} size={14} color={colors.foregroundMuted} />
          <Text style={styles.title}>Archive this workspace after reporting</Text>
        </Pressable>
        <Button styles={styles} primary label={busy ? "Sending…" : button.label} disabled={busy || button.disabled} onPress={() => void submit()} />
        {view.running && view.report?.state !== "writing" && <Text style={styles.muted}>The agent is working; report when its turn ends.</Text>}
        {(error ?? status) && <Text style={error || view.report?.state === "failed" ? styles.danger : styles.muted}>{error ?? status}</Text>}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Go to main chat"
          onPress={() => {
            props.close();
            void store.open(view.mainAgentId);
          }}
          style={styles.row}
          hitSlop={4}
        >
          <Icon name="CornerUpLeft" size={14} color={colors.accent} />
          <Text style={{ color: colors.accent, fontSize: 13 }}>Go to main chat</Text>
        </Pressable>
      </View>
    );
  };
}

function statusLine({ report }: ForkReport): string | null {
  if (!report) return null;
  const at = new Date(report.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (report.state === "failed") return report.error ?? "Report not sent";
  if (report.state === "sent") return `Sent to the main chat at ${at}${report.sent > 1 ? ` (${report.sent} reports)` : ""}.`;
  return null;
}
