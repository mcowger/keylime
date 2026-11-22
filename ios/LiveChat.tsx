import { useEffect, useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import type { SettingsPreferences } from "./SettingsScreen";
import type { BrowserLink } from "./browser-link";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";
import { ChatDialog } from "./ChatDialog";
import { ChatTranscript } from "./ChatTranscript";
import type { operations } from "./generated/web-http";
import { KeylimeHttpError, requestJson } from "./keylime-http";
import { theme } from "./theme";
import { useChatSession } from "./useChatSession";

type CreateRoute = operations["createAgentSession"];
type Creation = CreateRoute["responses"][200]["content"]["application/json"];
type ModelCatalog = NonNullable<ChatComposerProps["catalog"]>;
type Roles =
  operations["getChatRoles"]["responses"][200]["content"]["application/json"];

export type ChatTarget = {
  key: string;
  hostId: string;
  path: string;
  workspace: string;
  project: string;
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
  onChooseProject: () => void;
  onChooseWorkspace: () => void;
};

type Selection = NonNullable<ChatComposerProps["selectedModel"]> & {
  role?: string;
};

export function LiveChat({
  origin,
  link,
  target,
  visible,
  onUnauthorized,
  preferences,
  onCreated,
  onChooseProject,
  onChooseWorkspace,
}: LiveChatProps) {
  const chat = useChatSession({
    origin,
    link,
    hostId: target?.hostId ?? "local",
    sessionId: target?.sessionId ?? null,
    onUnauthorized,
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const locked = useRef(new Set<string>());
  const first = useRef(
    new Map<string, { sessionId: string; message: string }>(),
  );
  const [modelRefresh, setModelRefresh] = useState(0);
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
    void chat
      .sendFirst(pending.message)
      .then(
        () => {
          setDrafts((old) =>
            old[key] === pending.message ? { ...old, [key]: "" } : old,
          );
        },
        (cause) => error(key, cause),
      )
      .finally(() => {
        locked.current.delete(key);
        setBusy((old) => ({ ...old, [key]: false }));
      });
  }, [chat.ready, chat.sendFirst, target]);

  async function send() {
    if (!target || locked.current.has(target.key)) return;
    const { key, sessionId } = target;
    const message = drafts[key];
    if (!message?.trim()) return;
    locked.current.add(key);
    setBusy((old) => ({ ...old, [key]: true }));
    setErrors((old) => ({ ...old, [key]: "" }));
    let handingOff = false;
    try {
      if (sessionId) {
        await chat.send(message, chat.active ? "followUp" : "prompt");
        setDrafts((old) =>
          old[key] === message ? { ...old, [key]: "" } : old,
        );
      } else {
        const selection = selections[key];
        const created = await requestJson<Creation>(origin, "/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "ensure_session",
            hostId: target.hostId,
            cwd: target.path,
            ...(selection?.role
              ? { chatRole: selection.role }
              : selection
                ? { provider: selection.provider, modelId: selection.modelId }
                : {}),
          }),
        });
        if (!created.sessionId)
          throw new Error(
            "Server did not confirm the new session. Your prompt was not sent.",
          );
        first.current.set(key, { sessionId: created.sessionId, message });
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
      onDraftChange={(text) => setDrafts((old) => ({ ...old, [key]: text }))}
      onSend={() => void send()}
      onStop={() => void chat.stop().catch((cause) => error(key, cause))}
      running={chat.active}
      disabled={!!busy[key] || (!!sessionId && !chat.state?.outboxScope)}
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
    />
  );
  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding">
      {sessionId ? (
        <>
          <View style={styles.root}>
            {chat.context ||
            chat.liveMessage ||
            chat.echoedUserMessages.length > 0 ? (
              <ChatTranscript
                sessionKey={key}
                mediaOrigin={origin}
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
          {messageError && (
            <Text
              accessibilityRole="alert"
              style={[styles.status, { color: colors.accent }]}
            >
              {messageError}
            </Text>
          )}
          {composer}
        </View>
      )}
    </KeyboardAvoidingView>
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
