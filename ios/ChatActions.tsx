import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import { resolveForkTargets } from "../lib/chat-fork";
import type { TranscriptMessage } from "./ChatTranscript";
import { theme } from "./theme";

/** Server and host are part of the identity even when session IDs coincide. */
export type ChatIdentity = {
  origin: string;
  hostId: string;
  sessionId: string;
};
export type EditChatRequest = {
  session: ChatIdentity;
  entryId: string;
  text: string;
};
export type ForkChatRequest = {
  session: ChatIdentity;
  entryId: string;
  editPrompt: boolean;
};
type MessageAction = (
  message: TranscriptMessage,
  entryId: string,
  index: number,
) => void;
type Pending = (
  | { kind: "edit"; request: EditChatRequest }
  | { kind: "fork"; request: ForkChatRequest }
) & { sourceEntryId: string };

const identityKey = (session: ChatIdentity) =>
  JSON.stringify([session.origin, session.hostId, session.sessionId]);
function userText(message: TranscriptMessage): string {
  if (message.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

/**
 * The owner performs the native edit/branch commands and owns identity adoption,
 * refresh, and draft merging. A request always carries its original identity.
 * Pass onEdit/onFork to ChatTranscript and render confirmation alongside it.
 * canFork(index) lets the transcript suppress unsupported branch targets.
 */
export function useChatActions({
  session,
  messages,
  entryIds,
  busy,
  onEdit,
  onFork,
}: {
  session: ChatIdentity;
  messages: readonly TranscriptMessage[];
  entryIds: readonly string[];
  busy: boolean;
  onEdit: (request: EditChatRequest) => void | Promise<void>;
  onFork: (request: ForkChatRequest) => void | Promise<void>;
}) {
  const key = identityKey(session);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [pending, setPending] = useState<Pending | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    setPending(null);
    setError("");
  }, [key]);
  const targets = useMemo(
    () => resolveForkTargets(messages, entryIds),
    [messages, entryIds],
  );
  const sourceIndex = pending ? entryIds.indexOf(pending.sourceEntryId) : -1;
  const currentTarget = sourceIndex < 0 ? undefined : targets[sourceIndex];
  const selected =
    pending &&
    identityKey(pending.request.session) === key &&
    sourceIndex >= 0 &&
    (pending.kind === "edit" ||
      (currentTarget?.entryId === pending.request.entryId &&
        currentTarget.editPrompt === pending.request.editPrompt))
      ? pending
      : null;
  const canFork = useCallback(
    (index: number) => !busy && !!entryIds[index] && !!targets[index],
    [busy, entryIds, targets],
  );
  const requestEdit: MessageAction = (message, entryId, index) => {
    if (
      busy ||
      inFlight.current ||
      message.role !== "user" ||
      message.branchSummary ||
      !entryId ||
      entryIds[index] !== entryId
    )
      return;
    setError("");
    setPending({
      kind: "edit",
      sourceEntryId: entryId,
      request: { session: { ...session }, entryId, text: userText(message) },
    });
  };
  const requestFork: MessageAction = (_message, entryId, index) => {
    // Refuse a stale row if paging or a live update changed the index.
    if (busy || inFlight.current || entryIds[index] !== entryId) return;
    const target = targets[index];
    if (!target) return;
    setError("");
    setPending({
      kind: "fork",
      sourceEntryId: entryId,
      request: { session: { ...session }, ...target },
    });
  };
  const dismiss = () => {
    if (!inFlight.current) {
      setPending(null);
      setError("");
    }
  };
  const confirm = async () => {
    if (
      !selected ||
      busy ||
      inFlight.current ||
      identityKey(selected.request.session) !== currentKey.current
    )
      return;
    inFlight.current = true;
    setSubmitting(true);
    setError("");
    try {
      if (selected.kind === "edit") await onEdit(selected.request);
      else await onFork(selected.request);
      setPending((previous) => (previous === selected ? null : previous));
    } catch (cause) {
      if (currentKey.current === identityKey(selected.request.session))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };
  return {
    onEdit: requestEdit,
    onFork: requestFork,
    canFork,
    confirmation: (
      <ChatActionConfirmation
        pending={selected}
        busy={busy || submitting}
        submitting={submitting}
        error={error}
        onCancel={dismiss}
        onConfirm={() => {
          void confirm();
        }}
      />
    ),
  };
}

function ChatActionConfirmation({
  pending,
  busy,
  submitting,
  error,
  onCancel,
  onConfirm,
}: {
  pending: Pending | null;
  busy: boolean;
  submitting: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const colors = useColors();
  const edit = pending?.kind === "edit";
  const description = edit
    ? "This rewinds the current session to just before this message and puts its text in the composer to edit and resend. Attached images are not restored. Everything after it leaves the active conversation; it stays in the session file as an earlier branch."
    : pending?.kind === "fork" && pending.request.editPrompt
      ? "This creates a new session holding the conversation before this turn's prompt, and puts that prompt's text in the composer to edit and resend. Attached images are not restored. The current session stays unchanged."
      : "This creates a new session holding the conversation up to this point. The current session stays unchanged.";
  return (
    <Modal
      transparent
      visible={!!pending}
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <View
          accessibilityViewIsModal
          style={[
            styles.dialog,
            { backgroundColor: colors.background, borderColor: colors.border },
          ]}
        >
          <Text
            accessibilityRole="header"
            style={[styles.title, { color: colors.text }]}
          >
            {edit ? "Edit this message?" : "Fork a new session?"}
          </Text>
          <Text style={[styles.description, { color: colors.muted }]}>
            {description}
          </Text>
          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <View style={styles.dialogButtons}>
            <Button label="Cancel" onPress={onCancel} disabled={submitting} />
            <Button
              label={edit ? "Edit" : "Fork"}
              onPress={onConfirm}
              disabled={busy}
              primary
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** The mobile header's overflow: omit actions the owner cannot implement. */
export function ChatActions({
  onTheme,
  onCommandPalette,
  onBranches,
}: {
  onTheme?: () => void;
  onCommandPalette?: () => void;
  onBranches?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const colors = useColors();
  if (!onTheme && !onCommandPalette && !onBranches) return null;
  const action = (callback: () => void) => {
    setOpen(false);
    callback();
  };
  return (
    <View style={styles.toolbarAnchor}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="More controls"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={[styles.trigger, open && { backgroundColor: colors.panel }]}
      >
        <Text style={[styles.triggerText, { color: colors.text }]}>⋯</Text>
      </Pressable>
      {open && (
        <View
          style={[
            styles.toolbar,
            { backgroundColor: colors.background, borderColor: colors.border },
          ]}
        >
          {onTheme && (
            <ToolbarButton
              label="Theme"
              symbol="✧⌄"
              onPress={() => action(onTheme)}
            />
          )}
          {onCommandPalette && (
            <ToolbarButton
              label="Command palette"
              symbol="⌘"
              onPress={() => action(onCommandPalette)}
            />
          )}
          {onBranches && (
            <>
              <View
                style={[styles.divider, { backgroundColor: colors.border }]}
              />
              <ToolbarButton
                label="Branches"
                symbol="⑂"
                onPress={() => action(onBranches)}
              />
            </>
          )}
        </View>
      )}
    </View>
  );
}

function ToolbarButton({
  label,
  symbol,
  onPress,
}: {
  label: string;
  symbol: string;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.toolbarButton}
    >
      <Text style={[styles.toolbarIcon, { color: colors.text }]}>{symbol}</Text>
    </Pressable>
  );
}

/** Sidebar chat-row actions; archive is direct and is unavailable for parents. */
export function SessionActions({
  session,
  name,
  hasChildren,
  onRename,
  onArchive,
}: {
  session: ChatIdentity;
  name: string;
  hasChildren: boolean;
  onRename: (session: ChatIdentity, name: string) => void | Promise<void>;
  onArchive: (session: ChatIdentity) => void | Promise<void>;
}) {
  const colors = useColors();
  const key = identityKey(session);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    setMenuKey(null);
    setRenameKey(null);
    setError("");
  }, [key]);
  const menu = menuKey === key;
  const rename = renameKey === key;
  const run = async (kind: "rename" | "archive") => {
    if (inFlight.current || (kind === "archive" && hasChildren)) return;
    if (kind === "rename" && value.trim() === name) {
      setRenameKey(null);
      return;
    }
    const target = { ...session };
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (kind === "rename") await onRename(target, value.trim());
      else await onArchive(target);
      if (currentKey.current === key) {
        setMenuKey(null);
        setRenameKey(null);
      }
    } catch (cause) {
      if (currentKey.current === key)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Chat actions"
        accessibilityState={{ expanded: menu }}
        onPress={() => {
          setError("");
          setMenuKey(menu ? null : key);
        }}
        style={styles.trigger}
      >
        <Text style={[styles.triggerText, { color: colors.text }]}>⋯</Text>
      </Pressable>
      <Modal
        transparent
        visible={menu || rename}
        animationType="fade"
        onRequestClose={() => {
          if (!busy) {
            setMenuKey(null);
            setRenameKey(null);
          }
        }}
      >
        <KeyboardAvoidingView behavior="padding" style={styles.backdrop}>
          <View
            accessibilityViewIsModal
            style={[
              styles.sessionDialog,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
          >
            {rename ? (
              <>
                <Text
                  accessibilityRole="header"
                  style={[styles.title, { color: colors.text }]}
                >
                  Rename chat
                </Text>
                <TextInput
                  accessibilityLabel="Chat name"
                  autoFocus
                  selectTextOnFocus
                  editable={!busy}
                  value={value}
                  onChangeText={setValue}
                  onSubmitEditing={() => {
                    void run("rename");
                  }}
                  style={[
                    styles.input,
                    { color: colors.text, borderColor: colors.border },
                  ]}
                />
                {!!error && (
                  <Text accessibilityRole="alert" style={styles.error}>
                    {error}
                  </Text>
                )}
                <View style={styles.dialogButtons}>
                  <Button
                    label="Cancel"
                    disabled={busy}
                    onPress={() => setRenameKey(null)}
                  />
                  <Button
                    label="Save"
                    primary
                    disabled={busy}
                    onPress={() => {
                      void run("rename");
                    }}
                  />
                </View>
              </>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: hasChildren || busy }}
                  disabled={hasChildren || busy}
                  onPress={() => {
                    void run("archive");
                  }}
                  style={styles.menuRow}
                >
                  <Text
                    style={[
                      styles.menuText,
                      { color: colors.text },
                      (hasChildren || busy) && styles.disabled,
                    ]}
                  >
                    Archive
                  </Text>
                </Pressable>
                {hasChildren && (
                  <Text style={[styles.hint, { color: colors.muted }]}>
                    Only chats without child chats can be archived.
                  </Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => {
                    setMenuKey(null);
                    setValue(name);
                    setError("");
                    setRenameKey(key);
                  }}
                  style={styles.menuRow}
                >
                  <Text style={[styles.menuText, { color: colors.text }]}>
                    Rename
                  </Text>
                </Pressable>
                {!!error && (
                  <Text accessibilityRole="alert" style={styles.error}>
                    {error}
                  </Text>
                )}
                <Button
                  label="Cancel"
                  disabled={busy}
                  onPress={() => setMenuKey(null)}
                />
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function useColors() {
  return useColorScheme() === "light"
    ? {
        background: "#FAF9F6",
        panel: "#F2F0EA",
        border: "#D6CFC1",
        text: "#221A14",
        muted: "#625C57",
      }
    : {
        background: theme.background,
        panel: theme.panel,
        border: theme.border,
        text: theme.text,
        muted: theme.muted,
      };
}
function Button({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        { borderColor: colors.border },
        primary && styles.primary,
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[styles.buttonText, { color: primary ? "white" : colors.muted }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 16,
    backgroundColor: "rgba(0,0,0,0.76)",
  },
  dialog: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 22,
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
  },
  sessionDialog: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
  },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 22 },
  description: { fontSize: 13, lineHeight: 20 },
  dialogButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 18,
  },
  button: {
    minHeight: 36,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  primary: { backgroundColor: "#A62673", borderColor: "#A62673" },
  buttonText: { fontSize: 14, fontWeight: "500" },
  disabled: { opacity: 0.45 },
  error: { color: "#E67070", fontSize: 13, marginTop: 10 },
  toolbarAnchor: { position: "relative", zIndex: 20 },
  trigger: {
    width: 40,
    minHeight: 40,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  triggerText: { fontSize: 22, fontWeight: "600", lineHeight: 28 },
  toolbar: {
    position: "absolute",
    top: 44,
    left: 0,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 4,
    paddingVertical: 3,
    zIndex: 20,
  },
  toolbarButton: {
    minWidth: 48,
    minHeight: 40,
    justifyContent: "center",
    alignItems: "center",
  },
  toolbarIcon: { fontSize: 20 },
  divider: { height: 18, width: 1 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    minHeight: 44,
    fontSize: 16,
  },
  menuRow: { minHeight: 44, justifyContent: "center" },
  menuText: { fontSize: 15 },
  hint: { fontSize: 12, marginBottom: 4 },
});
