import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { addressReviewPrompt, CREATE_PR_PROMPT, fixChecksPrompt, prIcon, rowDetail, type LinkResult, type RelatedPr, type RowTarget } from "../shared/prs";

/** What one agent's popover shows. */
export interface AgentPrs {
  prs: RelatedPr[];
  /** By PR URL; absent when the row can neither fork nor open (this branch's PR, another repo, closed). */
  targets: Record<string, RowTarget>;
  canCreate: boolean;
  running: boolean;
}

/** The pills module's state and actions, as the popover sees them. */
export interface PrsStore {
  get(agentId: string): AgentPrs | undefined;
  subscribe(listener: () => void): () => void;
  /** Interrupts a running turn; callers disable prompting while the agent runs. */
  send(agentId: string, text: string): Promise<void>;
  link(agentId: string, refs: string[]): Promise<LinkResult>;
  unlink(agentId: string, url: string): Promise<void>;
  /** Forks the agent's chat into a new workspace on the PR, then opens it. */
  fork(agentId: string, prUrl: string): Promise<void>;
  open(agentId: string): Promise<void>;
}

export type Styles = ReturnType<typeof makeStyles>;

export function makePopover(store: PrsStore): ComponentType<PluginButtonContentProps> {
  return function PrsPopover(props: PluginButtonContentProps) {
    const agentId = props.context === "agent" ? props.agentId : null;
    const view = useSyncExternalStore(store.subscribe, () => (agentId ? store.get(agentId) : undefined));
    const styles = useMemo(() => makeStyles(props.theme, props.layout.compact), [props.theme, props.layout.compact]);
    const [note, setNote] = useState<{ text: string; danger: boolean } | null>(null);
    const [forking, setForking] = useState<string | null>(null);
    if (!agentId || !view) return <Text style={styles.muted}>No pull requests here.</Text>;

    const act = (task: () => Promise<unknown>) => {
      setNote(null);
      void task().catch((error) => setNote({ text: error instanceof Error ? error.message : String(error), danger: true }));
    };
    const prompt = (text: string) =>
      act(async () => {
        await store.send(agentId, text);
        props.close();
      });

    return (
      <View style={styles.popover}>
        <LinkField styles={styles} link={(refs) => store.link(agentId, refs)} onResult={setNote} />
        {note && <Text style={note.danger ? styles.danger : styles.muted}>{note.text}</Text>}
        {view.prs.map((pr) => (
          <PrRow
            key={pr.url}
            pr={pr}
            styles={styles}
            theme={props.theme}
            running={view.running}
            prompt={prompt}
            unlink={() => act(() => store.unlink(agentId, pr.url))}
            target={view.targets[pr.url]}
            forking={forking}
            fork={() =>
              act(async () => {
                setForking(pr.url);
                try {
                  await store.fork(agentId, pr.url);
                  props.close();
                } finally {
                  setForking(null);
                }
              })
            }
            open={(target) =>
              act(async () => {
                props.close();
                await store.open(target);
              })
            }
          />
        ))}
        {view.canCreate && (
          <Button styles={styles} primary label="Ask agent to open a PR" disabled={view.running} onPress={() => prompt(CREATE_PR_PROMPT)} />
        )}
      </View>
    );
  };
}

function PrRow(props: {
  pr: RelatedPr;
  styles: Styles;
  theme: PluginTheme;
  running: boolean;
  prompt(text: string): void;
  unlink(): void;
  target: RowTarget | undefined;
  /** URL of the PR being forked, if any; one fork at a time. */
  forking: string | null;
  fork(): void;
  open(agentId: string): void;
}) {
  const { pr, styles, theme, target } = props;
  const { colors } = theme;
  const tone =
    pr.state === "UNKNOWN" || pr.state === "CLOSED" || pr.checks === "failing" || pr.review === "changes_requested"
      ? colors.statusDanger
      : pr.state === "MERGED" || pr.review === "approved"
        ? colors.statusSuccess
        : colors.foregroundMuted;
  const open = pr.state === "OPEN";
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open PR ${pr.number} on GitHub: ${pr.title}`}
        onPress={() => void openExternalUrl(pr.url)}
        style={styles.main}
      >
        <Icon name={prIcon(pr)} size={14} color={tone} />
        <Text style={styles.number}>#{pr.number}</Text>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {pr.title}
          </Text>
          <Text style={[styles.detail, { color: tone }]} numberOfLines={1}>
            {rowDetail(pr)}
            {pr.onBranch ? " · this branch" : pr.stacked ? " · stack" : ""}
          </Text>
        </View>
      </Pressable>
      {open && pr.checks === "failing" && (
        <Button styles={styles} label="Fix" disabled={props.running} onPress={() => props.prompt(fixChecksPrompt(pr))} />
      )}
      {open && pr.review === "changes_requested" && (
        <Button styles={styles} label="Address" disabled={props.running} onPress={() => props.prompt(addressReviewPrompt(pr))} />
      )}
      {target?.kind === "open" && <Button styles={styles} label="Open" onPress={() => props.open(target.agentId)} />}
      {target?.kind === "fork" && (
        <Button
          styles={styles}
          label={props.forking === pr.url ? "Forking…" : "Fork chat"}
          disabled={props.forking !== null}
          onPress={props.fork}
        />
      )}
      {pr.linked && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Unlink PR ${pr.number}`} onPress={props.unlink} style={styles.icon} hitSlop={6}>
          <Icon name="X" size={14} color={colors.foregroundMuted} />
        </Pressable>
      )}
    </View>
  );
}

function LinkField(props: { styles: Styles; link(refs: string[]): Promise<LinkResult>; onResult(note: { text: string; danger: boolean } | null): void }) {
  const { styles } = props;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const refs = value.split(/[\s,]+/).filter(Boolean);
    if (!refs.length || busy) return;
    setBusy(true);
    props.onResult(null);
    try {
      const result = await props.link(refs);
      if (result.linked.length) setValue("");
      const text = [result.linked.length ? `Linked ${result.linked.length}.` : "", ...result.errors].filter(Boolean).join("\n");
      props.onResult(text ? { text, danger: result.errors.length > 0 } : null);
    } catch (error) {
      props.onResult({ text: error instanceof Error ? error.message : String(error), danger: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.linkRow}>
      <TextInput
        value={value}
        onChangeText={setValue}
        onSubmitEditing={() => void submit()}
        placeholder="Link a PR: URL or #123"
        placeholderTextColor={styles.placeholder.color}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        style={styles.input}
      />
      <Button styles={styles} label={busy ? "Linking…" : "Link"} disabled={busy || !value.trim()} onPress={() => void submit()} />
    </View>
  );
}

export function Button(props: { styles: Styles; label: string; onPress(): void; primary?: boolean; disabled?: boolean }) {
  const { styles } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.button, props.primary && styles.buttonPrimary, props.disabled && styles.buttonDisabled]}
    >
      <Text style={props.primary ? styles.buttonPrimaryText : styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

export function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    // The host popover pads, scrolls and caps its size; sizing it here again clips it.
    popover: { gap: 6, minWidth: compact ? undefined : 340 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    main: { flex: 1, flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: compact ? 8 : 4 },
    number: { color: colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums" as const] },
    text: { flex: 1, minWidth: 0 },
    title: { color: colors.foreground, fontSize: 13 },
    detail: { fontSize: 11 },
    icon: { padding: 4 },
    linkRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, marginBottom: 4 },
    input: {
      flex: 1,
      color: colors.foreground,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: compact ? 8 : 5,
      fontSize: 13,
    },
    placeholder: { color: colors.foregroundMuted },
    button: {
      paddingVertical: compact ? 8 : 4,
      paddingHorizontal: 10,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface2,
    },
    buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent, alignItems: "center" as const },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: colors.foreground, fontSize: 12 },
    buttonPrimaryText: { color: colors.accentForeground, fontSize: 13 },
    muted: { color: colors.foregroundMuted, fontSize: 12 },
    danger: { color: colors.statusDanger, fontSize: 12 },
  };
}
