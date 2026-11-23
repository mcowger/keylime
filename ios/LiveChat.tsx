import {
  cloneElement,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { File, Paths } from "expo-file-system";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import type { SettingsPreferences } from "./SettingsScreen";
import type { BrowserCommand, BrowserLink, BrowserReply } from "./browser-link";
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
import { resolveAvailableThinkingLevels } from "../lib/thinking-levels";
import {
  getToolNamesForPreset,
  isToolPreset,
  type ToolPreset,
} from "../lib/tool-presets";
import english from "../lib/i18n/locales/en.json";
import { ChatKeyboardArea } from "./ChatKeyboardArea";
import { ComposerMoreMenu } from "./ComposerMoreMenu";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";
import { ChatDialog } from "./ChatDialog";
import { PlanReview } from "./PlanReview";
import { ChatTranscript, type ChatTranscriptProps } from "./ChatTranscript";
import type { operations } from "./generated/web-http";
import {
  ensureChatSession,
  KeylimeHttpError,
  requestJson,
} from "./keylime-http";
import { theme } from "./theme";
import { useChatSession } from "./useChatSession";

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
type ChatView = ReturnType<typeof useChatSession>;
const emptyTranscriptMessages: ChatTranscriptProps["messages"] = [];
const RetainedTranscript = memo(function RetainedTranscript({
  element,
  visible,
}: {
  element: ReactElement<ChatTranscriptProps>;
  visible: boolean;
}) {
  return cloneElement(element, { visible });
});
const emptyTranscriptIds: ChatTranscriptProps["entryIds"] = [];
export type ChatHeaderState = Pick<ChatView, "active" | "state"> & {
  key: string;
  sessionId: string;
  hostId: string;
};

export type LiveChatProps = {
  origin: string;
  link: BrowserLink;
  target: ChatTarget | null;
  openSessionKeys: ReadonlySet<string>;
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
  onHeaderState?: (state: ChatHeaderState | null) => void;
};

type Selection = {
  provider?: string;
  modelId?: string;
  role?: string;
  thinkingLevel?: string;
  roleEffort?: string;
  previousThinkingLevel?: string;
};
type PrewalkMode = "off" | "suggest" | "on";
type ComposerModes = { plan?: boolean | null; prewalk?: PrewalkMode | null };

function resultField(reply: BrowserReply, field: string): unknown {
  const data =
    "success" in reply.data && reply.data.success ? reply.data.data : null;
  return data && typeof data === "object" && field in data
    ? (data as Record<string, unknown>)[field]
    : undefined;
}

function isPrewalkMode(value: unknown): value is PrewalkMode {
  return value === "off" || value === "suggest" || value === "on";
}

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
function loadToolPreset(): ToolPreset {
  try {
    const file = new File(Paths.document, "native-tool-preset.txt");
    const value = file.exists ? file.textSync() : undefined;
    return isToolPreset(value) ? value : "full";
  } catch {
    return "full";
  }
}

export function LiveChat({
  origin,
  link,
  target,
  openSessionKeys,
  visible,
  onUnauthorized,
  preferences,
  onCreated,
  onForked,
  onChooseProject,
  onChooseWorkspace,
  onHeaderState,
}: LiveChatProps) {
  const [advisorChoices, setAdvisorChoices] = useState(loadAdvisorChoices);
  const [toolPreset, setToolPreset] = useState(loadToolPreset);
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
    openSessionKeys,
    onUnauthorized,
  });
  const transcripts = useRef(
    new Map<
      string,
      {
        owner: string;
        element: ReactElement<ChatTranscriptProps>;
        messages: ChatTranscriptProps["messages"];
        entryIds: ChatTranscriptProps["entryIds"];
        echoes: ChatView["echoedUserMessages"];
      }
    >(),
  );
  const headerKey = target?.key;
  const headerHost = target?.hostId;
  const headerSession = target?.sessionId;
  const { active, state } = chat;
  useEffect(() => () => onHeaderState?.(null), [onHeaderState]);
  useEffect(() => {
    onHeaderState?.(
      headerKey && headerHost && headerSession
        ? {
            key: headerKey,
            hostId: headerHost,
            sessionId: headerSession,
            active,
            state,
          }
        : null,
    );
  }, [onHeaderState, headerKey, headerHost, headerSession, active, state]);
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
    messages: chat.context?.messages ?? emptyTranscriptMessages,
    entryIds: chat.context?.entryIds ?? emptyTranscriptIds,
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
        modes?: ComposerModes;
        attachments: ChatAttachmentsController;
      }
    >(),
  );
  const [modelRefresh, setModelRefresh] = useState<{
    host: string;
    cwd: string;
    count: number;
  }>();
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<{
    origin: string;
    host: string;
    cwd: string;
    data: ModelCatalog | null;
    error?: string;
  }>();
  const [rolesResult, setRolesResult] = useState<{
    origin: string;
    query: string;
    roles: Roles["roles"];
  }>();
  const [thinkingOverrides, setThinkingOverrides] = useState<
    Record<string, string>
  >({});
  const [selectionBusy, setSelectionBusy] = useState<Record<string, boolean>>(
    {},
  );
  const [modes, setModes] = useState<Record<string, ComposerModes>>({});
  const modeRevision = useRef(0);
  const lastPlanSignal = useRef<{ owner: string; enabled: boolean } | null>(
    null,
  );
  const selectionLocked = useRef(new Set<string>());
  const lastModelRefresh = useRef<typeof modelRefresh>(undefined);
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
  const sessionIdForRoles = target?.sessionId;
  const selectionOwner = target
    ? JSON.stringify([
        origin,
        target.hostId,
        target.sessionId
          ? ["session", target.sessionId]
          : ["new", target.key, target.path],
      ])
    : "";
  const currentSelection =
    target && !target.sessionId ? selections[selectionOwner] : undefined;
  const liveModel = chat.state?.state?.model;
  const catalogForTarget =
    catalog?.origin === origin && catalog.host === hostId && catalog.cwd === cwd
      ? catalog.data
      : null;
  const selected =
    currentSelection?.provider && currentSelection.modelId
      ? {
          provider: currentSelection.provider,
          modelId: currentSelection.modelId,
        }
      : liveModel
        ? { provider: liveModel.provider, modelId: liveModel.id }
        : (chat.context?.model ?? catalogForTarget?.defaultModel ?? null);
  const thinkingLevel = target
    ? (currentSelection?.thinkingLevel ??
      currentSelection?.roleEffort ??
      thinkingOverrides[selectionOwner] ??
      chat.state?.state?.thinkingLevel ??
      chat.context?.thinkingLevel ??
      "auto")
    : "auto";
  const currentModes = modes[selectionOwner] ?? {};
  const roleQuery =
    hostId && cwd
      ? new URLSearchParams({
          hostId,
          cwd,
          ...(sessionIdForRoles ? { sessionId: sessionIdForRoles } : {}),
          ...(thinkingLevel !== "auto" ||
          currentSelection?.thinkingLevel === "auto" ||
          thinkingOverrides[selectionOwner] === "auto"
            ? { thinkingLevel }
            : {}),
          ...(selected
            ? {
                currentProvider: selected.provider,
                currentModelId: selected.modelId,
              }
            : {}),
        }).toString()
      : null;
  useEffect(() => {
    if (!hostId || !cwd) return;
    let valid = true;
    const query = `hostId=${encodeURIComponent(hostId)}&cwd=${encodeURIComponent(cwd)}`;
    const refresh =
      modelRefresh?.host === hostId &&
      modelRefresh.cwd === cwd &&
      modelRefresh !== lastModelRefresh.current;
    if (refresh) lastModelRefresh.current = modelRefresh;
    setCatalog(undefined);
    void requestJson<ModelCatalog>(
      origin,
      `/api/models?${query}`,
      refresh ? { method: "POST" } : undefined,
    ).then(
      (data) => {
        if (valid) setCatalog({ origin, host: hostId, cwd, data });
      },
      (cause) => {
        if (!valid) return;
        if (cause instanceof KeylimeHttpError && cause.kind === "unauthorized")
          onUnauthorized();
        else
          setCatalog({
            origin,
            host: hostId,
            cwd,
            data: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
      },
    );
    return () => {
      valid = false;
    };
  }, [origin, hostId, cwd, modelRefresh, onUnauthorized]);
  useEffect(() => {
    if (!roleQuery) return;
    let valid = true;
    void requestJson<Roles>(origin, `/api/chat-roles?${roleQuery}`).then(
      (data) => {
        if (valid)
          setRolesResult({ origin, query: roleQuery, roles: data.roles });
      },
      (cause) => {
        if (!valid) return;
        if (cause instanceof KeylimeHttpError && cause.kind === "unauthorized")
          onUnauthorized();
        else if (target) error(target.key, cause);
      },
    );
    return () => {
      valid = false;
    };
  }, [origin, roleQuery, onUnauthorized]);
  useEffect(() => {
    if (!sessionIdForRoles || !chat.ready) return;
    const revision = ++modeRevision.current;
    const owner = selectionOwner;
    void Promise.all([
      chat.issueCommand({ type: "get_plan_state" }),
      chat.issueCommand({ type: "get_auto_prewalk" }),
    ])
      .then(([plan, prewalk]) => {
        if (modeRevision.current !== revision) return;
        const enabled = resultField(plan, "enabled");
        const mode = resultField(prewalk, "mode");
        setModes((old) => ({
          ...old,
          [owner]: {
            plan: typeof enabled === "boolean" ? enabled : false,
            prewalk: isPrewalkMode(mode) ? mode : null,
          },
        }));
      })
      .catch(() => {
        // A disconnected or unsupported runner leaves its mode unknown.
      });
    return () => {
      modeRevision.current++;
    };
  }, [chat.ready, chat.issueCommand, sessionIdForRoles, selectionOwner]);

  useEffect(() => {
    if (!sessionIdForRoles || !chat.ready) return;
    const previous = lastPlanSignal.current;
    lastPlanSignal.current = {
      owner: selectionOwner,
      enabled: chat.planEnabled,
    };
    if (
      !previous ||
      previous.owner !== selectionOwner ||
      previous.enabled === chat.planEnabled
    )
      return;
    modeRevision.current++;
    setModes((old) => ({
      ...old,
      [selectionOwner]: {
        ...old[selectionOwner],
        plan: chat.planEnabled,
      },
    }));
  }, [chat.planEnabled, chat.ready, sessionIdForRoles, selectionOwner]);

  function error(key: string, cause: unknown) {
    setErrors((old) => ({
      ...old,
      [key]: cause instanceof Error ? cause.message : String(cause),
    }));
  }
  function refreshModels(host: string, path: string) {
    setModelRefresh((old) => ({
      host,
      cwd: path,
      count: (old?.count ?? 0) + 1,
    }));
  }

  useEffect(() => {
    if (!target?.sessionId || !chat.ready) return;
    const pending = first.current.get(target.key);
    if (!pending || pending.sessionId !== target.sessionId) return;
    first.current.delete(target.key);
    const { key } = target;
    const operation = (async () => {
      modeRevision.current++;
      if (pending.modes?.plan)
        await chat.issueCommand({ type: "set_plan_mode", enabled: true });
      if (pending.modes?.prewalk) {
        const reply = await chat.issueCommand({
          type: "set_auto_prewalk",
          mode: pending.modes.prewalk,
        });
        if (resultField(reply, "mode") !== pending.modes.prewalk)
          throw new Error(
            "The runner did not accept the selected Auto prewalk mode. The message was not sent.",
          );
        setModes((old) => ({
          ...old,
          [selectionOwner]: {
            ...old[selectionOwner],
            prewalk: pending.modes?.prewalk,
          },
        }));
      }
      if (pending.command) await runSlashAction(key, pending.command);
      else await chat.sendFirst(pending.message, pending.attachments.payload);
    })();
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
    if (command.type === "reload" && target)
      refreshModels(target.hostId, target.path);
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
    if (
      !target ||
      chat.planProposal ||
      chat.planCommandPending ||
      locked.current.has(target.key) ||
      selectionLocked.current.has(target.key)
    )
      return;
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
        const selection = selections[selectionOwner];
        const created = await ensureChatSession(origin, {
          type: "ensure_session",
          hostId: target.hostId,
          cwd: target.path,
          ...(toolPreset === "full"
            ? {}
            : { toolNames: getToolNamesForPreset(toolPreset) }),
          ...(advisorEnabled ? { advisor: true } : {}),
          ...(selection?.role
            ? { chatRole: selection.role }
            : selection?.provider && selection.modelId
              ? { provider: selection.provider, modelId: selection.modelId }
              : {}),
          ...(selection?.thinkingLevel &&
          (selection.role || selection.thinkingLevel !== "auto")
            ? { thinkingLevel: selection.thinkingLevel }
            : {}),
        });
        persistAdvisor(target.hostId, created.sessionId, advisorEnabled);
        setNewAdvisorChoices((old) => {
          const next = { ...old };
          delete next[key];
          return next;
        });
        setSelections((old) => {
          if (old[selectionOwner] !== selection) return old;
          const next = { ...old };
          delete next[selectionOwner];
          return next;
        });
        if (created.kind === "initialization-interrupted") {
          onCreated(key, created.sessionId, target.hostId, target.path);
          error(
            key,
            "The host disconnected during setup. This chat was created, but your message wasn't sent. Check the model before sending again.",
          );
          return;
        }
        first.current.set(key, {
          modes: currentModes,
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
  for (const [id, entry] of transcripts.current) {
    if (!openSessionKeys.has(entry.owner)) transcripts.current.delete(id);
  }

  if (!target) return null;
  const { key, sessionId } = target;
  const data =
    catalog?.origin === origin &&
    catalog.host === target.hostId &&
    catalog.cwd === target.path
      ? catalog
      : undefined;
  const messageError = errors[key] || chat.error;
  const availableThinkingLevels = resolveAvailableThinkingLevels(
    selected
      ? data?.data?.thinkingLevels[`${selected.provider}:${selected.modelId}`]
      : undefined,
    selected,
    liveModel ? { ...liveModel, modelId: liveModel.id } : null,
  );
  const applySelection = (command: BrowserCommand, onSuccess: () => void) => {
    if (selectionLocked.current.has(key) || locked.current.has(key)) return;
    selectionLocked.current.add(key);
    setSelectionBusy((old) => ({ ...old, [key]: true }));
    setErrors((old) => ({ ...old, [key]: "" }));
    void chat
      .issueCommand(command)
      .then(async () => {
        onSuccess();
        if (
          latest.current?.key === key &&
          latest.current.sessionId === sessionId &&
          latest.current.hostId === target.hostId
        )
          await chat.refresh();
      })
      .catch((cause) => {
        error(key, cause);
        if (
          latest.current?.key === key &&
          latest.current.sessionId === sessionId &&
          latest.current.hostId === target.hostId
        )
          void chat.refresh();
      })
      .finally(() => {
        selectionLocked.current.delete(key);
        setSelectionBusy((old) => ({ ...old, [key]: false }));
      });
  };
  const choose = (provider: string, modelId: string) => {
    if (sessionId)
      applySelection({ type: "set_model", provider, modelId }, () => {});
    else
      setSelections((old) => ({
        ...old,
        [selectionOwner]: {
          provider,
          modelId,
          thinkingLevel:
            old[selectionOwner]?.thinkingLevel ??
            old[selectionOwner]?.previousThinkingLevel,
        },
      }));
  };
  const chooseRole = (role: Roles["roles"][number]) => {
    if (sessionId) {
      applySelection({ type: "set_chat_role", role: role.id }, () => {
        setThinkingOverrides((old) => {
          const next = { ...old };
          delete next[selectionOwner];
          return next;
        });
      });
    } else {
      setSelections((old) => ({
        ...old,
        [selectionOwner]: {
          role: role.id,
          ...(role.provider && role.modelId
            ? { provider: role.provider, modelId: role.modelId }
            : {}),
          previousThinkingLevel:
            old[selectionOwner]?.thinkingLevel ??
            old[selectionOwner]?.previousThinkingLevel,
          ...(role.effectiveThinkingLevel
            ? { roleEffort: role.effectiveThinkingLevel }
            : {}),
        },
      }));
    }
  };
  const chooseThinking = (level: string) => {
    if (!sessionId) {
      setSelections((old) => ({
        ...old,
        [selectionOwner]: { ...old[selectionOwner], thinkingLevel: level },
      }));
    } else if (level === "auto") {
      // As in the PWA, Auto leaves the runner's current selector untouched.
      setThinkingOverrides((old) => ({ ...old, [selectionOwner]: level }));
    } else {
      applySelection({ type: "set_thinking_level", level }, () => {
        setThinkingOverrides((old) => {
          const next = { ...old };
          delete next[selectionOwner];
          return next;
        });
      });
    }
  };
  const chooseMode = (
    field: "plan" | "prewalk",
    value: boolean | PrewalkMode,
  ) => {
    if (!sessionId) {
      setModes((old) => ({
        ...old,
        [selectionOwner]: { ...old[selectionOwner], [field]: value },
      }));
      return;
    }
    if (selectionLocked.current.has(key) || locked.current.has(key)) return;
    selectionLocked.current.add(key);
    modeRevision.current++;
    setSelectionBusy((old) => ({ ...old, [key]: true }));
    setErrors((old) => ({ ...old, [key]: "" }));
    const command: BrowserCommand =
      field === "plan"
        ? { type: "set_plan_mode", enabled: value === true }
        : { type: "set_auto_prewalk", mode: value as PrewalkMode };
    const query: BrowserCommand =
      field === "plan"
        ? { type: "get_plan_state" }
        : { type: "get_auto_prewalk" };
    const applyResult = (reply: BrowserReply) => {
      const actual = resultField(reply, field === "plan" ? "enabled" : "mode");
      if (
        field === "plan" ? typeof actual !== "boolean" : !isPrewalkMode(actual)
      )
        throw new Error("The runner did not report the selected mode.");
      setModes((old) => ({
        ...old,
        [selectionOwner]: { ...old[selectionOwner], [field]: actual },
      }));
      if (actual !== value)
        throw new Error("The runner selected a different mode.");
    };
    void chat
      .issueCommand(command)
      .then((reply) => {
        applyResult(reply);
        void chat.refresh();
      })
      .catch(async (cause) => {
        error(key, cause);
        try {
          const reply = await chat.issueCommand(query);
          const actual = resultField(
            reply,
            field === "plan" ? "enabled" : "mode",
          );
          setModes((old) => ({
            ...old,
            [selectionOwner]: {
              ...old[selectionOwner],
              [field]:
                field === "plan"
                  ? typeof actual === "boolean"
                    ? actual
                    : null
                  : isPrewalkMode(actual)
                    ? actual
                    : null,
            },
          }));
        } catch {
          setModes((old) => ({
            ...old,
            [selectionOwner]: {
              ...old[selectionOwner],
              [field]: null,
            },
          }));
        }
      })
      .finally(() => {
        selectionLocked.current.delete(key);
        setSelectionBusy((old) => ({ ...old, [key]: false }));
      });
  };
  const composer = (
    <ChatComposer
      draft={drafts[key] ?? ""}
      canSendAttachment={attachments.items.length > 0 && attachments.canSend}
      moreActions={
        <ComposerMoreMenu
          onAttachFiles={() => void attachments.pickFiles()}
          onPhotoLibrary={() => void attachments.pickPhotos()}
          onPasteImage={() => void attachments.paste()}
          attachmentsDisabled={attachments.picking}
          toolPreset={toolPreset}
          onToolPresetChange={(preset) => {
            setToolPreset(preset);
            try {
              new File(Paths.document, "native-tool-preset.txt").writeSync(
                preset,
              );
            } catch {
              // Keep the selection in memory if local storage is unavailable.
            }
            if (sessionId)
              setNotices((old) => ({
                ...old,
                [key]: english["agentSession.toolPresetNotice"],
              }));
          }}
          advisorEnabled={advisorEnabled}
          onAdvisorChange={(enabled) => {
            if (sessionId) persistAdvisor(target.hostId, sessionId, enabled);
            else setNewAdvisorChoices((old) => ({ ...old, [key]: enabled }));
          }}
        />
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
      modelActivity={chat.modelActivity}
      disabled={
        !attachments.canSend ||
        !!busy[key] ||
        !!selectionBusy[key] ||
        (!!sessionId && !chat.state?.outboxScope)
      }
      submissionBlocked={!!chat.planProposal || chat.planCommandPending}
      favoriteScope={origin}
      catalog={data?.data ?? null}
      catalogLoading={!data}
      catalogError={data?.error}
      pickerError={errors[key]}
      roles={
        rolesResult?.origin === origin && rolesResult.query === roleQuery
          ? rolesResult.roles
          : []
      }
      selectedModel={selected}
      thinkingLevel={thinkingLevel}
      availableThinkingLevels={availableThinkingLevels}
      onThinkingLevelChange={chooseThinking}
      planEnabled={currentModes.plan === true}
      planUnknown={currentModes.plan === null}
      planBusy={chat.planCommandPending}
      prewalk={currentModes.prewalk ?? null}
      onPlanChange={(enabled) => chooseMode("plan", enabled)}
      onPrewalkChange={(mode) => chooseMode("prewalk", mode)}
      onSelectModel={choose}
      onSelectRole={chooseRole}
      onRefreshModels={() => refreshModels(target.hostId, target.path)}
    >
      <ChatAttachmentChips controller={attachments} />
    </ChatComposer>
  );
  const transcriptOwner = sessionId
    ? JSON.stringify([origin, target.hostId, sessionId])
    : null;
  const transcriptKey = transcriptOwner
    ? JSON.stringify([transcriptOwner, chat.historyView])
    : null;
  const hasTranscript = !!(
    chat.context ||
    chat.liveMessage ||
    chat.echoedUserMessages.length
  );
  // A history invalidated while away must not reuse the old branch's list.
  if (transcriptOwner && !hasTranscript) {
    for (const [id, entry] of transcripts.current) {
      if (entry.owner === transcriptOwner) transcripts.current.delete(id);
    }
  }
  if (
    transcriptKey &&
    transcriptOwner &&
    openSessionKeys.has(transcriptOwner) &&
    hasTranscript
  ) {
    for (const [id, entry] of transcripts.current) {
      if (entry.owner === transcriptOwner && id !== transcriptKey)
        transcripts.current.delete(id);
    }
    const previous = transcripts.current.get(transcriptKey);
    const baseMessages = chat.context?.messages ?? emptyTranscriptMessages;
    const baseIds = chat.context?.entryIds ?? emptyTranscriptIds;
    const unchanged =
      previous &&
      previous.messages === baseMessages &&
      previous.entryIds === baseIds &&
      previous.echoes === chat.echoedUserMessages;
    const messages = unchanged
      ? previous.element.props.messages
      : chat.echoedUserMessages.length
        ? [
            ...baseMessages,
            ...chat.echoedUserMessages.map(({ message }) => message),
          ]
        : baseMessages;
    const entryIds = unchanged
      ? previous.element.props.entryIds
      : chat.echoedUserMessages.length
        ? [
            ...baseIds,
            ...chat.echoedUserMessages.map(({ id }) => `live-user:${id}`),
          ]
        : baseIds;
    transcripts.current.set(transcriptKey, {
      owner: transcriptOwner,
      messages: baseMessages,
      entryIds: baseIds,
      echoes: chat.echoedUserMessages,
      element: (
        <ChatTranscript
          sessionKey={transcriptOwner}
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
          messages={messages}
          entryIds={entryIds}
          liveMessage={chat.liveMessage}
          toolResults={chat.toolResults}
          historyHasMore={chat.hasOlder}
          loadingHistory={chat.loadingHistory}
          onLoadOlder={chat.loadOlder}
        />
      ),
    });
  }
  return (
    <View
      style={visible ? styles.root : { display: "none" }}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
    >
      <ChatKeyboardArea>
        {actions.confirmation}
        <View style={sessionId ? styles.root : { display: "none" }}>
          {[...transcripts.current].map(([id, entry]) => {
            const active = id === transcriptKey && hasTranscript;
            return (
              <View
                key={id}
                style={active ? styles.root : { display: "none" }}
                accessibilityElementsHidden={!active}
                importantForAccessibility={
                  active ? "auto" : "no-hide-descendants"
                }
              >
                <RetainedTranscript
                  element={entry.element}
                  visible={active && visible}
                />
              </View>
            );
          })}
          {sessionId && !hasTranscript && chat.loading && (
            <Text style={[styles.status, { color: colors.muted }]}>
              Loading…
            </Text>
          )}
        </View>
        {sessionId ? (
          <>
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
            {chat.planProposal && (
              <View style={styles.planReview}>
                <PlanReview
                  key={chat.planProposal.id}
                  proposal={chat.planProposal}
                  pending={chat.planCommandPending}
                  onRespond={chat.respondPlanProposal}
                />
              </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  planReview: { marginHorizontal: 16, marginBottom: 8, flexShrink: 1 },
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
