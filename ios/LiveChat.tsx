import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import { File, Paths } from "expo-file-system";
import {
  ActionSheetIOS,
  Image,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import type { SettingsPreferences } from "./SettingsScreen";
import type { BrowserCommand, BrowserLink } from "./browser-link";
import {
  ChatAttachmentChips,
  useChatAttachments,
  type ChatAttachmentsController,
} from "./ChatAttachments";
import { NativeSlashMenu, useNativeSlashMenu } from "./NativeSlashMenu";
import { useNativeChatActions } from "./useNativeChatActions";
import { copyText, readText } from "./native-network";
import { validateOutgoingPrompt } from "../lib/image-attachments";
import { expandWebSlashCommand } from "../lib/web-slash-commands";
import english from "../lib/i18n/locales/en.json";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";
import { ChatDialog } from "./ChatDialog";
import { ChatTranscript } from "./ChatTranscript";
import type { operations } from "./generated/web-http";
import {
  ensureChatSession,
  KeylimeHttpError,
  requestJson,
} from "./keylime-http";
import { theme } from "./theme";
import { useChatSession } from "./useChatSession";

function ChatKeyboardArea({ children }: { children: ReactNode }) {
  const host = useRef<ComponentRef<typeof View>>(null);
  const [windowTop, setWindowTop] = useState(0);
  const measure = useCallback(() => {
    host.current?.measureInWindow((_x, y) => setWindowTop(y));
  }, []);

  // The keyboard reports a window-space top, while the avoiding view's
  // frame is local to this host below the safe area and workspace header.
  return (
    <View ref={host} collapsable={false} onLayout={measure} style={styles.root}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior="padding"
        keyboardVerticalOffset={windowTop}
      >
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

type ModelCatalog = NonNullable<ChatComposerProps["catalog"]>;
type Roles =
  operations["getChatRoles"]["responses"][200]["content"]["application/json"];

export type ChatTarget = {
  key: string;
  hostId: string;
  path: string;
  workspace: string;
  project: string;
  effort?: boolean;
  sessionId: string | null;
};
export type LiveChatProps = {
  origin: string;
  link: BrowserLink;
  target: ChatTarget | null;
  visible: boolean;
  onUnauthorized: () => void;
  preferences?: SettingsPreferences;
  onCreated: (
    tabKey: string,
    sessionId: string,
    hostId: string,
    cwd: string,
  ) => void;
  onForked: (target: ChatTarget, sessionId: string) => string | undefined;
  onChooseProject: () => void;
  onChooseWorkspace: () => void;
};

type Selection = NonNullable<ChatComposerProps["selectedModel"]> & {
  role?: string;
};
type SlashAction = Extract<
  BrowserCommand,
  { type: "compact" | "reload" | "set_session_name" }
>;

function advisorKey(origin: string, hostId: string, sessionId: string) {
  return JSON.stringify([origin, hostId, sessionId]);
}

function loadAdvisorChoices(): Record<string, boolean> {
  try {
    const file = new File(Paths.document, "native-chat-advisor.json");
    const value: unknown = file.exists ? JSON.parse(file.textSync()) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([, enabled]) => enabled === true),
    );
  } catch {
    return {};
  }
}

export function LiveChat({
  origin,
  link,
  target,
  visible,
  onUnauthorized,
  preferences,
  onCreated,
  onForked,
  onChooseProject,
  onChooseWorkspace,
}: LiveChatProps) {
  const [advisorChoices, setAdvisorChoices] = useState(loadAdvisorChoices);
  const advisorChoicesRef = useRef(advisorChoices);
  advisorChoicesRef.current = advisorChoices;
  const [newAdvisorChoices, setNewAdvisorChoices] = useState<
    Record<string, boolean>
  >({});
  const advisorEnabled = target
    ? target.sessionId
      ? advisorChoices[advisorKey(origin, target.hostId, target.sessionId)] ===
        true
      : newAdvisorChoices[target.key] === true
    : false;
  function persistAdvisor(hostId: string, sessionId: string, enabled: boolean) {
    const next = { ...advisorChoicesRef.current };
    const key = advisorKey(origin, hostId, sessionId);
    if (enabled) next[key] = true;
    else delete next[key];
    advisorChoicesRef.current = next;
    setAdvisorChoices(next);
    try {
      new File(Paths.document, "native-chat-advisor.json").writeSync(
        JSON.stringify(next),
      );
    } catch {
      // Match the web client's in-memory fallback when local storage is unavailable.
    }
  }
  const chat = useChatSession({
    origin,
    link,
    hostId: target?.hostId ?? "local",
    sessionId: target?.sessionId ?? null,
    advisor: advisorEnabled,
    onUnauthorized,
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const attachments = useChatAttachments(
    origin,
    target?.hostId,
    target?.key ?? "",
  );
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [forcedSelection, setForcedSelection] = useState<typeof selection>();
  const latest = useRef(target);
  latest.current = target;
  const slash = useNativeSlashMenu({
    advisorEnabled,
    link,
    hostId: target?.hostId ?? "local",
    sessionId: target?.sessionId ?? null,
    ready: chat.ready,
    running: chat.active,
    draft: target ? (drafts[target.key] ?? "") : "",
    selection,
    onReplaceDraft(text, position) {
      if (target) setDrafts((old) => ({ ...old, [target.key]: text }));
      setForcedSelection(position);
      setSelection(position);
    },
  });
  const actions = useNativeChatActions({
    session: {
      origin,
      hostId: target?.hostId ?? "local",
      sessionId: target?.sessionId ?? "",
    },
    messages: chat.context?.messages ?? [],
    entryIds: chat.context?.entryIds ?? [],
    busy: !target?.sessionId || chat.active || !!chat.dialog,
    issueCommand: chat.issueCommand,
    async reloadEdited(result, expected) {
      if (
        !target ||
        latest.current?.key !== target.key ||
        latest.current.sessionId !== expected.sessionId
      )
        throw new Error("The selected chat changed.");
      const path = `/api/sessions/${encodeURIComponent(result.sessionId)}/context?hostId=${encodeURIComponent(expected.hostId)}&sync=1&limit=1`;
      const context = await requestJson<
        operations["getSessionContext"]["responses"][200]["content"]["application/json"]
      >(origin, path);
      if (!("leafId" in context) || context.leafId !== result.leafId)
        throw new Error("The edited conversation has not caught up.");
      if (
        latest.current?.key !== target.key ||
        latest.current.sessionId !== expected.sessionId
      )
        throw new Error("The selected chat changed.");
      if (result.sessionId !== expected.sessionId) {
        persistAdvisor(target.hostId, result.sessionId, advisorEnabled);
        onCreated(target.key, result.sessionId, target.hostId, target.path);
      } else await chat.refresh();
    },
    setDraft(expected, _id, update) {
      if (
        target?.sessionId === expected.sessionId &&
        latest.current?.key === target.key
      )
        setDrafts((old) => ({
          ...old,
          [target.key]: update(old[target.key] ?? ""),
        }));
    },
    onForked(id, text) {
      if (!target || latest.current?.key !== target.key) return;
      persistAdvisor(target.hostId, id, advisorEnabled);
      const key = onForked(target, id);
      if (key && text)
        setDrafts((old) => (old[key] ? old : { ...old, [key]: text }));
    },
  });
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const locked = useRef(new Set<string>());
  const first = useRef(
    new Map<
      string,
      {
        sessionId: string;
        message: string;
        original: string;
        command?: SlashAction;
        attachments: ChatAttachmentsController;
      }
    >(),
  );
  const [modelRefresh, setModelRefresh] = useState(0);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<{
    host: string;
    data: ModelCatalog | null;
    roles: Roles["roles"];
    error?: string;
  }>();
  const dark = useColorScheme() !== "light";
  const colors = dark
    ? theme
    : {
        text: "#2B2823",
        panel: "#F2F0EA",
        border: "#E2DDD2",
        muted: "#69635A",
        accent: "#B03E22",
      };
  const hostId = target?.hostId;
  const cwd = target?.path;
  useEffect(() => {
    if (!hostId || !cwd) return;
    let valid = true;
    const query = `hostId=${encodeURIComponent(hostId)}`;
    setCatalog(undefined);
    void Promise.allSettled([
      requestJson<ModelCatalog>(origin, `/api/models?${query}`),
      requestJson<Roles>(
        origin,
        `/api/chat-roles?${query}&cwd=${encodeURIComponent(cwd)}`,
      ),
    ]).then(([models, roles]) => {
      if (!valid) return;
      if (
        [models, roles].some(
          (entry) =>
            entry.status === "rejected" &&
            entry.reason instanceof KeylimeHttpError &&
            entry.reason.kind === "unauthorized",
        )
      ) {
        onUnauthorized();
        return;
      }
      setCatalog({
        host: hostId,
        data: models.status === "fulfilled" ? models.value : null,
        roles: roles.status === "fulfilled" ? roles.value.roles : [],
        ...(models.status === "rejected"
          ? {
              error:
                "Model list is temporarily unavailable. Check your configuration and try again.",
            }
          : {}),
      });
    });
    return () => {
      valid = false;
    };
  }, [origin, hostId, cwd, modelRefresh, onUnauthorized]);

  function error(key: string, cause: unknown) {
    setErrors((old) => ({
      ...old,
      [key]: cause instanceof Error ? cause.message : String(cause),
    }));
  }

  useEffect(() => {
    if (!target?.sessionId || !chat.ready) return;
    const pending = first.current.get(target.key);
    if (!pending || pending.sessionId !== target.sessionId) return;
    first.current.delete(target.key);
    const { key } = target;
    const operation = pending.command
      ? runSlashAction(key, pending.command)
      : chat.sendFirst(pending.message, pending.attachments.payload);
    void operation
      .then(
        () => {
          if (!pending.command) pending.attachments.clear(true);
          setDrafts((old) =>
            old[key] === pending.original ? { ...old, [key]: "" } : old,
          );
        },
        (cause) => error(key, cause),
      )
      .finally(() => {
        locked.current.delete(key);
        setBusy((old) => ({ ...old, [key]: false }));
      });
  }, [chat.ready, chat.sendFirst, target]);

  async function runSlashAction(key: string, command: SlashAction) {
    await chat.issueCommand(command);
    if (command.type === "reload") setModelRefresh((old) => old + 1);
    void chat.refresh().catch(() => {});
    setNotices((old) => ({
      ...old,
      [key]:
        command.type === "compact"
          ? "Compacted context"
          : command.type === "reload"
            ? "Reloaded extensions, skills, prompts, and tools"
            : `Session renamed to ${command.name}`,
    }));
  }

  async function send() {
    if (!target || locked.current.has(target.key)) return;
    const { key, sessionId } = target;
    const message = drafts[key] ?? "";
    if (!attachments.canSend || (!message.trim() && !attachments.items.length))
      return;
    if (slash.shouldPreserveDraft) {
      error(key, "This command is not available here.");
      return;
    }
    const text = message.trim();
    if (
      /^\/advisor(?:\s|$)/.test(text) &&
      !advisorEnabled &&
      (chat.active || attachments.items.length === 0)
    ) {
      error(key, "Advisor is disabled — enable it in the composer’s + menu.");
      return;
    }
    const expansion = expandWebSlashCommand(text);
    const shouldExpand = chat.active || attachments.items.length === 0;
    if (shouldExpand && expansion.kind === "usage-error") {
      error(
        key,
        `${expansion.command} requires an argument: ${english[expansion.argumentHintKey as keyof typeof english]}`,
      );
      return;
    }
    const outgoing =
      shouldExpand && expansion.kind === "expand" ? expansion.prompt : message;
    const actionMatch =
      !chat.active && attachments.items.length === 0
        ? /^\/(compact|reload|name)(?:\s+([\s\S]*))?$/.exec(text)
        : null;
    const args = actionMatch?.[2]?.trim() ?? "";
    if (actionMatch?.[1] === "name" && !args) {
      error(key, "Usage: /name <name>");
      return;
    }
    const command: SlashAction | undefined =
      actionMatch?.[1] === "compact"
        ? { type: "compact", ...(args ? { customInstructions: args } : {}) }
        : actionMatch?.[1] === "reload"
          ? { type: "reload" }
          : actionMatch?.[1] === "name"
            ? { type: "set_session_name", name: args }
            : undefined;
    const issue = validateOutgoingPrompt(
      outgoing,
      attachments.payload.images ?? [],
    );
    if (issue) {
      error(key, issue);
      return;
    }
    locked.current.add(key);
    setBusy((old) => ({ ...old, [key]: true }));
    setErrors((old) => ({ ...old, [key]: "" }));
    setNotices((old) => ({ ...old, [key]: "" }));
    let handingOff = false;
    try {
      if (sessionId) {
        if (command) await runSlashAction(key, command);
        else
          await chat.send(
            outgoing,
            chat.active ? "followUp" : "prompt",
            attachments.payload,
          );
        attachments.clear(true);
        setDrafts((old) =>
          old[key] === message ? { ...old, [key]: "" } : old,
        );
      } else {
        const selection = selections[key];
        const created = await ensureChatSession(origin, {
          type: "ensure_session",
          hostId: target.hostId,
          cwd: target.path,
          ...(advisorEnabled ? { advisor: true } : {}),
          ...(selection?.role
            ? { chatRole: selection.role }
            : selection
              ? { provider: selection.provider, modelId: selection.modelId }
              : {}),
        });
        persistAdvisor(target.hostId, created.sessionId, advisorEnabled);
        setNewAdvisorChoices((old) => {
          const next = { ...old };
          delete next[key];
          return next;
        });
        if (created.kind === "initialization-interrupted") {
          onCreated(key, created.sessionId, target.hostId, target.path);
          setSelections((old) => {
            if (old[key] !== selection) return old;
            const next = { ...old };
            delete next[key];
            return next;
          });
          error(
            key,
            "The host disconnected during setup. This chat was created, but your message wasn't sent. Check the model before sending again.",
          );
          return;
        }
        first.current.set(key, {
          sessionId: created.sessionId,
          message: outgoing,
          original: message,
          command,
          attachments,
        });
        handingOff = true;
        onCreated(key, created.sessionId, target.hostId, target.path);
      }
    } catch (cause) {
      if (cause instanceof KeylimeHttpError && cause.kind === "unauthorized")
        onUnauthorized();
      error(
        key,
        !sessionId &&
          cause instanceof KeylimeHttpError &&
          cause.kind === "unreachable"
          ? new Error(
              "Session creation is unconfirmed. Your prompt was not sent. Check Workspace tabs before trying again.",
            )
          : cause,
      );
    } finally {
      if (!handingOff) {
        locked.current.delete(key);
        setBusy((old) => ({ ...old, [key]: false }));
      }
    }
  }

  if (!target || !visible) return null;
  const { key, sessionId } = target;
  const data = catalog?.host === target.hostId ? catalog : undefined;
  const sessionModel = chat.state?.state?.model;
  const fallback = sessionModel
    ? { provider: sessionModel.provider, modelId: sessionModel.id }
    : null;
  const messageError = errors[key] || chat.error;
  const choose = (provider: string, modelId: string, role?: string) => {
    if (sessionId) {
      void chat
        .issueCommand(
          role
            ? { type: "set_chat_role", role }
            : { type: "set_model", provider, modelId },
        )
        .then(
          () =>
            setSelections((old) => ({
              ...old,
              [key]: { provider, modelId, role },
            })),
          (cause) => error(key, cause),
        );
    } else
      setSelections((old) => ({ ...old, [key]: { provider, modelId, role } }));
  };
  const composer = (
    <ChatComposer
      draft={drafts[key] ?? ""}
      canSendAttachment={attachments.items.length > 0 && attachments.canSend}
      onAddAttachment={() =>
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [
              "Choose file",
              "Paste image",
              `Advisor: ${advisorEnabled ? "On" : "Off"}`,
              "Cancel",
            ],
            cancelButtonIndex: 3,
          },
          (index) => {
            if (index === 0) void attachments.pick();
            else if (index === 1) void attachments.paste();
            else if (index === 2) {
              ActionSheetIOS.showActionSheetWithOptions(
                {
                  options: [
                    advisorEnabled
                      ? "Disable advisor for this chat"
                      : "Enable advisor for this chat",
                    "Cancel",
                  ],
                  cancelButtonIndex: 1,
                },
                (choice) => {
                  if (choice !== 0) return;
                  if (sessionId)
                    persistAdvisor(target.hostId, sessionId, !advisorEnabled);
                  else
                    setNewAdvisorChoices((old) => ({
                      ...old,
                      [key]: !advisorEnabled,
                    }));
                },
              );
            }
          },
        )
      }
      selection={forcedSelection}
      onSelectionChange={(position) => {
        setSelection(position);
        setForcedSelection(undefined);
      }}
      onComposerKey={(key) => slash.handleKey(key)}
      onDraftChange={(text) => setDrafts((old) => ({ ...old, [key]: text }))}
      onSend={() => void send()}
      onStop={() => void chat.stop().catch((cause) => error(key, cause))}
      running={chat.active}
      disabled={
        !attachments.canSend ||
        !!busy[key] ||
        (!!sessionId && !chat.state?.outboxScope)
      }
      catalog={data?.data ?? null}
      catalogLoading={!data}
      catalogError={data?.error}
      roles={data?.roles ?? []}
      selectedModel={
        selections[key] ?? fallback ?? data?.data?.defaultModel ?? null
      }
      onSelectModel={choose}
      onSelectRole={(role) => {
        if (role.provider && role.modelId)
          choose(role.provider, role.modelId, role.id);
      }}
      onRefreshModels={() => setModelRefresh((old) => old + 1)}
    >
      <ChatAttachmentChips controller={attachments} />
    </ChatComposer>
  );
  return (
    <ChatKeyboardArea>
      {actions.confirmation}
      {sessionId ? (
        <>
          <View style={styles.root}>
            {chat.context ||
            chat.liveMessage ||
            chat.echoedUserMessages.length > 0 ? (
              <ChatTranscript
                sessionKey={key}
                mediaOrigin={origin}
                mediaHostId={target.hostId}
                onCopy={(text) =>
                  void copyText(text).catch((cause) => error(key, cause))
                }
                onRead={(text) =>
                  void readText(text).catch((cause) => error(key, cause))
                }
                onEdit={
                  chat.active || chat.dialog || actions.uncertain
                    ? undefined
                    : actions.onEdit
                }
                onFork={actions.onFork}
                canFork={actions.canFork}
                preferences={preferences}
                messages={[
                  ...(chat.context?.messages ?? []),
                  ...chat.echoedUserMessages.map(({ message }) => message),
                ]}
                entryIds={[
                  ...(chat.context?.entryIds ?? []),
                  ...chat.echoedUserMessages.map(({ id }) => `live-user:${id}`),
                ]}
                liveMessage={chat.liveMessage}
                historyHasMore={chat.hasOlder}
                loadingHistory={chat.loadingHistory}
                onLoadOlder={() => void chat.loadOlder()}
              />
            ) : chat.loading ? (
              <Text style={[styles.status, { color: colors.muted }]}>
                Loading…
              </Text>
            ) : null}
          </View>
          {chat.pendingInput.map((item) => (
            <View
              key={item.id}
              style={[
                styles.pending,
                { backgroundColor: colors.panel, borderColor: colors.border },
              ]}
            >
              <Text style={{ color: colors.text }}>{item.message}</Text>
              <Text style={{ color: colors.muted }}>
                {item.error ||
                  (item.state === "uncertain"
                    ? "Delivery unconfirmed"
                    : item.state.replace(/_/g, " "))}
              </Text>
            </View>
          ))}
          {[...chat.queue.steering, ...chat.queue.followUp].map(
            (text, index) => (
              <Text
                numberOfLines={1}
                key={index}
                style={[styles.status, { color: colors.muted }]}
              >
                {text}
              </Text>
            ),
          )}
          {messageError && (
            <Text
              accessibilityRole="alert"
              style={[styles.status, { color: colors.accent }]}
            >
              {messageError}
            </Text>
          )}
          {!!notices[key] && (
            <Text
              accessibilityRole="alert"
              style={[styles.status, { color: colors.muted }]}
            >
              {notices[key]}
            </Text>
          )}
          {actions.uncertain && (
            <Text
              accessibilityRole="alert"
              style={[styles.status, { color: colors.accent }]}
            >
              {actions.uncertain}
            </Text>
          )}
          <NativeSlashMenu menu={slash} />
          {chat.dialog ? (
            <ChatDialog
              request={chat.dialog}
              onRespond={chat.respondDialog}
              submitting={chat.dialogSubmitting}
              error={chat.dialogError}
            />
          ) : (
            composer
          )}
        </>
      ) : (
        <View style={styles.fresh}>
          <View style={styles.brand}>
            <Image
              source={require("../public/icon-192.png")}
              style={styles.logo}
            />
            <Text style={[styles.brandText, { color: colors.text }]}>
              key lime
            </Text>
          </View>
          {!target.effort && (
            <View
              style={[
                styles.picker,
                { backgroundColor: colors.panel, borderColor: colors.border },
              ]}
            >
              <View style={styles.options}>
                <Pressable
                  style={styles.option}
                  accessibilityRole="button"
                  onPress={onChooseProject}
                >
                  <Text style={{ color: colors.muted }}>Project</Text>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.optionLabel,
                      { color: colors.text, borderColor: colors.border },
                    ]}
                  >
                    {target.project} ⌄
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.option}
                  accessibilityRole="button"
                  onPress={onChooseWorkspace}
                >
                  <Text style={{ color: colors.muted }}>Workspace</Text>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.optionLabel,
                      { color: colors.text, borderColor: colors.border },
                    ]}
                  >
                    {target.workspace} ⌄
                  </Text>
                </Pressable>
              </View>
              <Text style={[styles.path, { color: colors.muted }]}>
                {target.path}
              </Text>
            </View>
          )}
          {messageError && (
            <Text
              accessibilityRole="alert"
              style={[styles.status, { color: colors.accent }]}
            >
              {messageError}
            </Text>
          )}
          <NativeSlashMenu menu={slash} />
          {composer}
        </View>
      )}
    </ChatKeyboardArea>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fresh: { flex: 1, justifyContent: "center", paddingBottom: 48 },
  brand: {
    marginHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  brandText: { fontFamily: "Menlo", fontSize: 18, fontWeight: "700" },
  logo: { width: 26, height: 26, borderRadius: 8 },
  picker: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    gap: 8,
  },
  options: { flexDirection: "row", gap: 10 },
  option: { flex: 1, gap: 7 },
  optionLabel: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
    padding: 11,
    fontSize: 16,
  },
  path: { fontSize: 12, fontFamily: "Menlo" },
  status: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13 },
  pending: {
    borderWidth: 1,
    borderRadius: 10,
    margin: 8,
    padding: 8,
    alignSelf: "flex-end",
    maxWidth: "90%",
  },
});
