import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyMessageDelta,
  displayMessage,
  isDeltaUpdate,
} from "../lib/message-delta";
import { isRecord } from "../lib/type-guards";
import { readModelActivity, type ModelActivity } from "../lib/model-activity";
import { normalizeToolCalls } from "../lib/normalize";
import type { AgentMessage } from "../lib/types";
import {
  BrowserLinkError,
  type BrowserCommand,
  type BrowserLink,
  type BrowserReply,
} from "./browser-link";
import type { components as BrowserComponents } from "./generated/browser-link";
import type { operations } from "./generated/web-http";
import { KeylimeHttpError, requestJson } from "./keylime-http";
import {
  applyCoveredToolEvent,
  applyToolEvent,
  reconcileToolSnapshot,
  retainEndedTools,
  type ChatToolResults,
} from "./chat-tool-state";
export type { ChatToolResult } from "./chat-tool-state";

type JsonResponse<
  K extends "getSession" | "getSessionContext" | "getSessionState",
> = operations[K]["responses"][200]["content"]["application/json"];
export type ChatContext = JsonResponse<"getSession">["context"];
export type ChatMessage = ChatContext["messages"][number];
export type ChatUserMessage = Extract<ChatMessage, { role: "user" }>;
export type EchoedUserMessage = { id: string; message: ChatUserMessage };
type SyncPage = Extract<
  JsonResponse<"getSessionContext">,
  { mode: "append" | "replace" }
>;
type StateResponse = JsonResponse<"getSessionState">;
type Cursor = SyncPage["cursor"];
type LiveMessage = NonNullable<
  NonNullable<SyncPage["live"]>["streamingMessage"]
>;
type OutboxEntry = StateResponse["outbox"][number];
type Queue = NonNullable<StateResponse["state"]>["queuedMessages"];
type Event = Record<string, unknown> & {
  type: string;
  web?: { streamId: string; sequence: number; first?: number };
};
export type ChatDialogRequest = Extract<
  BrowserComponents["schemas"]["BrowserEvent"]["data"],
  { type: "ui_request" }
>;
export type ChatDialogValue = Extract<
  BrowserCommand,
  { type: "ui_response" }
>["value"];
type PlanState = NonNullable<
  Extract<
    BrowserComponents["schemas"]["BrowserReply_get_plan_state"]["data"],
    { success: true }
  >["data"]
>;
export type ChatPlanProposal = NonNullable<PlanState["proposal"]>;

function readPlanState(value: unknown): PlanState | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean") return null;
  const proposal = value.proposal;
  if (
    proposal !== undefined &&
    (!value.enabled ||
      !isRecord(proposal) ||
      typeof proposal.id !== "string" ||
      typeof proposal.title !== "string" ||
      typeof proposal.content !== "string" ||
      typeof proposal.planFilePath !== "string")
  )
    return null;
  return {
    enabled: value.enabled,
    ...(proposal === undefined
      ? {}
      : { proposal: proposal as ChatPlanProposal }),
  };
}

type PendingPlanDecision = {
  id: string;
  proposal: ChatPlanProposal;
  uncertain: boolean;
  inFlight: boolean;
  reconcile?: () => void;
};
const planDecisionsByLink = new WeakMap<
  BrowserLink,
  { current: Map<string, PendingPlanDecision> }
>();
function planDecisions(link: BrowserLink) {
  let pending = planDecisionsByLink.get(link);
  if (!pending) {
    pending = { current: new Map() };
    planDecisionsByLink.set(link, pending);
  }
  return pending;
}
export type ChatAttachments = Pick<
  Extract<BrowserCommand, { type: "prompt" }>,
  "images" | "uploads" | "uploadProofs"
>;

export type PendingChatInput = {
  id: string;
  message: string;
  state: OutboxEntry["state"] | "sending" | "uncertain";
  error?: string;
};
export type ChatSessionView = {
  context: ChatContext | null;
  state: StateResponse | null;
  liveMessage: LiveMessage | null;
  planEnabled: boolean;
  planProposal?: ChatPlanProposal;
  planCommandPending: boolean;
  modelActivity?: ModelActivity;
  toolResults: ChatToolResults;
  historyView: number;
  queue: Queue;
  outbox: OutboxEntry[];
  pendingInput: PendingChatInput[];
  echoedUserMessages: EchoedUserMessage[];
  dialog: ChatDialogRequest | null;
  dialogSubmitting: boolean;
  dialogError: string | null;
  loading: boolean;
  loadingHistory: boolean;
  hasOlder: boolean;
  ready: boolean;
  active: boolean;
  error: string | null;
};

const emptyQueue: Queue = { steering: [], followUp: [] };
const initial = (): ChatSessionView => ({
  context: null,
  state: null,
  liveMessage: null,
  planEnabled: false,
  planCommandPending: false,
  toolResults: {},
  historyView: 0,
  queue: emptyQueue,
  outbox: [],
  pendingInput: [],
  echoedUserMessages: [],
  dialog: null,
  dialogSubmitting: false,
  dialogError: null,
  loading: true,
  loadingHistory: false,
  hasOlder: false,
  ready: false,
  active: false,
  error: null,
});

type CachedSession = {
  view: ChatSessionView;
  cursor: Cursor | null;
  revision: string | null;
  rootKnown: boolean;
};
const messageId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
function sameToolResults(a: ChatToolResults, b: ChatToolResults): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((id) => a[id] === b[id])
  );
}
function userText(message: ChatUserMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((block) =>
          block.type === "text" && block.text ? [block.text] : [],
        )
        .join("\n");
}

function sameSavedUser(saved: ChatUserMessage, echo: ChatUserMessage): boolean {
  if (saved.clientMessageId && saved.clientMessageId !== echo.clientMessageId)
    return false;
  if (saved.timestamp !== echo.timestamp || userText(saved) !== userText(echo))
    return false;
  if (saved.clientMessageId) return true;
  const images = (message: ChatUserMessage) =>
    typeof message.content === "string"
      ? "[]"
      : JSON.stringify(
          message.content.flatMap((block) =>
            block.type === "image"
              ? [[block.mimeType, block.data, block.url, block.source]]
              : [],
          ),
        );
  return images(saved) === images(echo);
}

export function useChatSession({
  origin,
  hostId,
  sessionId,
  link,
  onUnauthorized,
  openSessionKeys,
  advisor = false,
}: {
  origin: string;
  hostId: string;
  sessionId: string | null;
  link: BrowserLink;
  openSessionKeys: ReadonlySet<string>;
  advisor?: boolean;
  onUnauthorized?: () => void;
}) {
  const key = JSON.stringify([origin, hostId, sessionId]);
  const sessionOpen = openSessionKeys.has(key);
  const keyRef = useRef(key);
  keyRef.current = key;
  const openKeysRef = useRef(openSessionKeys);
  openKeysRef.current = openSessionKeys;
  const unauthorizedRef = useRef(onUnauthorized);
  const advisorRef = useRef(advisor);
  advisorRef.current = advisor;
  unauthorizedRef.current = onUnauthorized;
  const [rendered, setRendered] = useState<{
    key: string;
    value: ChatSessionView;
  }>({ key, value: initial() });
  const recent = useRef(new Map<string, CachedSession>());
  // Intents remain associated with their server and host across chat navigation.
  const pendingBySession = useRef(
    new Map<string, Map<string, PendingChatInput>>(),
  );
  const echoesBySession = useRef(
    new Map<string, Map<string, ChatUserMessage>>(),
  );
  const uncertainDialogs = useRef(new Map<string, Set<string | number>>());
  const pendingPlans = planDecisions(link);
  const runtime = useRef<{
    key: string;
    issue(command: BrowserCommand): Promise<BrowserReply>;
    send(
      message: string,
      mode?: "prompt" | "followUp" | "steer",
      attachments?: ChatAttachments,
    ): Promise<void>;
    sendFirst(message: string, attachments?: ChatAttachments): Promise<void>;
    respondDialog(value?: ChatDialogValue): Promise<void>;
    respondPlanProposal(
      id: string,
      approved: boolean,
      feedback?: string,
    ): Promise<boolean>;
    older(): Promise<void>;
    refresh(): Promise<void>;
  } | null>(null);

  useEffect(() => {
    for (const cachedKey of recent.current.keys()) {
      if (!openSessionKeys.has(cachedKey)) recent.current.delete(cachedKey);
    }
  }, [openSessionKeys]);

  useEffect(() => {
    if (!sessionId || !sessionOpen) {
      runtime.current = null;
      setRendered({ key, value: { ...initial(), loading: false } });
      return;
    }
    let disposed = false;
    const current = () =>
      !disposed && keyRef.current === key && openKeysRef.current.has(key);
    const cached = recent.current.get(key);
    let view = cached
      ? {
          ...cached.view,
          ready: false,
          loadingHistory: false,
          dialog: null,
          dialogSubmitting: false,
          dialogError: null,
        }
      : initial();
    const savedPlan = pendingPlans.current.get(key);
    if (savedPlan) {
      view = {
        ...view,
        planEnabled: true,
        planProposal: savedPlan.proposal,
        planCommandPending: true,
      };
    }
    let planRevision = 0;
    let planModePending = false;
    let planModeAwaitingAuthority = false;
    let planSynchronized = false;
    let cursor: Cursor | null = cached?.cursor ?? null;
    let rootKnown = cached?.rootKnown ?? false;
    let revision: string | null = cached?.revision ?? null;
    let liveId: string | null = null;
    let stream: { streamId: string; sequence: number } | null = null;
    let initialized = !!cached;
    let reconcilingCached = !!cached;
    let reading = false;
    let requested = false;
    let stateRequested = false;
    let readPromise: Promise<void> | null = null;
    let paging = false;
    let wrapperConnected = false;
    const handoffReads = new Set<string>();
    let buffered: Event[] = [];
    let historyGeneration = 0;
    let releaseSession: (() => void) | undefined;
    let subscribed = false;
    let outboxGeneration = 0;
    let subscriptionGeneration = 0;
    let dialogTimer: ReturnType<typeof setTimeout> | undefined;
    const uncertain =
      uncertainDialogs.current.get(key) ?? new Set<string | number>();
    uncertainDialogs.current.set(key, uncertain);
    const local =
      pendingBySession.current.get(key) ?? new Map<string, PendingChatInput>();
    pendingBySession.current.set(key, local);
    const echoes =
      echoesBySession.current.get(key) ?? new Map<string, ChatUserMessage>();
    echoesBySession.current.set(key, echoes);
    const settled = new Set<string>();
    const nativeSettled = new Set<string>();
    const seenOutbox = new Set<string>();
    let representedMessages: ChatContext["messages"] | undefined;
    let representedResolved:
      ChatContext["resolvedClientMessageIds"] | undefined;
    let savedClientIds = new Set<string>();
    let echoVersion = 0;
    let reconciledEchoVersion = -1;
    let reconciledMessages: ChatContext["messages"] | undefined;
    const hostQuery = `hostId=${encodeURIComponent(hostId)}`;
    const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const report = (cause: unknown) => {
      if (!current()) return;
      if (cause instanceof KeylimeHttpError && cause.kind === "unauthorized")
        unauthorizedRef.current?.();
      view = { ...view, error: errorText(cause), loading: false };
      publish();
    };
    function rememberUserMessage(raw: unknown, clientId?: string) {
      if (
        !isRecord(raw) ||
        raw.role !== "user" ||
        (typeof raw.content !== "string" && !Array.isArray(raw.content))
      )
        return;
      const native = raw as unknown as ChatUserMessage;
      const message: ChatUserMessage = clientId
        ? { ...native, clientMessageId: clientId }
        : native;
      if (
        view.context?.messages.some(
          (saved) => saved.role === "user" && sameSavedUser(saved, message),
        )
      )
        return;
      for (const [id, previous] of echoes) {
        if (
          previous.clientMessageId === message.clientMessageId &&
          sameSavedUser(previous, message)
        ) {
          echoes.set(id, message);
          echoVersion++;
          return;
        }
      }
      echoes.set(`echo:${messageId()}`, message);
      echoVersion++;
    }
    function publish() {
      if (!current()) return;
      if (
        reconciledEchoVersion !== echoVersion ||
        reconciledMessages !== view.context?.messages
      ) {
        reconciledMessages = view.context?.messages;
        reconciledEchoVersion = echoVersion;
        for (const [id, echo] of echoes) {
          if (
            view.context?.messages.some(
              (saved) => saved.role === "user" && sameSavedUser(saved, echo),
            )
          )
            echoes.delete(id);
        }
      }
      const previousEchoes = view.echoedUserMessages;
      const unchangedEchoes =
        previousEchoes.length === echoes.size &&
        previousEchoes.every(({ id, message }) => echoes.get(id) === message);
      const echoedUserMessages = unchangedEchoes
        ? previousEchoes
        : [...echoes].map(([id, message]) => ({ id, message }));
      const messages = view.context?.messages;
      const resolved = view.context?.resolvedClientMessageIds;
      if (
        messages !== representedMessages ||
        resolved !== representedResolved
      ) {
        representedMessages = messages;
        representedResolved = resolved;
        savedClientIds = new Set(resolved ?? []);
        for (const message of messages ?? [])
          if (message.role === "user" && message.clientMessageId)
            savedClientIds.add(message.clientMessageId);
      }
      const transientIds = new Set<string>();
      for (const { message } of echoedUserMessages)
        if (message.clientMessageId) transientIds.add(message.clientMessageId);
      // Queue membership hides a pending row, but does not prove delivery.
      for (const id of local.keys())
        if (savedClientIds.has(id) || transientIds.has(id)) local.delete(id);
      for (const id of view.queue.clientMessageIds?.steering ?? [])
        if (id) transientIds.add(id);
      for (const id of view.queue.clientMessageIds?.followUp ?? [])
        if (id) transientIds.add(id);
      const entries = view.outbox.filter(
        (entry) =>
          !savedClientIds.has(entry.id) &&
          !transientIds.has(entry.id) &&
          !settled.has(entry.id) &&
          entry.state !== "delivered",
      );
      const pendingInput: PendingChatInput[] = entries.map(
        ({ id, message, state, error }) => ({ id, message, state, error }),
      );
      for (const entry of local.values())
        if (
          !savedClientIds.has(entry.id) &&
          !transientIds.has(entry.id) &&
          (!settled.has(entry.id) || nativeSettled.has(entry.id)) &&
          !entries.some((item) => item.id === entry.id)
        )
          pendingInput.push(entry);
      const value = { ...view, pendingInput, echoedUserMessages };
      view = value;
      if (value.context && cursor) {
        recent.current.set(key, { view: value, cursor, revision, rootKnown });
      } else if (!cursor) {
        recent.current.delete(key);
      }
      setRendered({ key, value });
    }
    function applyOutbox(
      entries: OutboxEntry[],
      ids: string[],
      nativeIds: string[],
    ) {
      for (const id of nativeIds) nativeSettled.add(id);
      for (const entry of entries) {
        seenOutbox.add(entry.id);
        if (entry.settlement === "native") nativeSettled.add(entry.id);
        if (entry.state !== "delivered" || entry.settlement === "native") {
          local.set(entry.id, {
            id: entry.id,
            message: entry.message,
            state: entry.state === "delivered" ? "delivering" : entry.state,
            error: entry.error,
          });
        } else local.delete(entry.id);
      }
      for (const id of ids) {
        settled.add(id);
        if (!nativeSettled.has(id)) local.delete(id);
      }
      view = { ...view, outbox: entries };
      recoverHandoffs();
    }
    function recoverHandoffs() {
      if (!current() || !wrapperConnected) return;
      for (const id of nativeSettled) {
        if (
          !local.has(id) ||
          handoffReads.has(id) ||
          [...echoes.values()].some((message) => message.clientMessageId === id)
        )
          continue;
        handoffReads.add(id);
        void Promise.resolve()
          .then(() => reconcileIntent(id, false))
          .finally(() => handoffReads.delete(id));
      }
    }
    function releaseSaved() {
      const held = view.liveMessage;
      if (!held || held.role !== "assistant") return;
      if (
        view.context?.messages.some(
          (message) =>
            message.role === "assistant" &&
            (held.timestamp !== undefined
              ? message.timestamp === held.timestamp
              : JSON.stringify(message.content) ===
                JSON.stringify(held.content)),
        )
      ) {
        liveId = null;
        view = { ...view, liveMessage: null };
      }
    }
    function applyPlanState(state: PlanState) {
      if (planModeAwaitingAuthority) {
        planModeAwaitingAuthority = false;
        planModePending = false;
      }
      const pending = pendingPlans.current.get(key);
      if (
        pending &&
        !pending.inFlight &&
        (!pending.uncertain || state.proposal?.id !== pending.id)
      )
        pendingPlans.current.delete(key);
      view = {
        ...view,
        planEnabled: state.enabled,
        planProposal: state.proposal,
        planCommandPending: planModePending || pendingPlans.current.has(key),
      };
    }
    function applyPlanSnapshot(value: unknown, revisionAtStart: number) {
      if (!current() || planRevision !== revisionAtStart) return false;
      if (value === null) {
        // No live child is a valid passive read, but cannot resolve an
        // interrupted decision without a process-exit confirmation.
        if (pendingPlans.current.has(key)) return false;
        applyPlanState({ enabled: false });
      } else {
        const state = readPlanState(value);
        if (!state) return false;
        applyPlanState(state);
      }
      planSynchronized = true;
      publish();
      return true;
    }
    async function refreshPlan() {
      if (!current()) return false;
      const revisionAtStart = ++planRevision;
      try {
        const reply = await issueRaw({ type: "get_plan_state" });
        const data: unknown =
          "success" in reply.data && reply.data.success
            ? reply.data.data
            : undefined;
        return applyPlanSnapshot(data, revisionAtStart);
      } catch {
        return false;
      }
    }
    function applyEvent(event: Event) {
      if (!current()) return;
      const coveredByLive =
        /^(agent_start|agent_end|prompt_result|prompt_error|message_start|message_update|message_end|tool_execution_start|tool_execution_update|tool_execution_end)$/.test(
          event.type,
        ) && !(isRecord(event.message) && event.message.role === "user");
      const mark = event.web;
      if (
        mark &&
        event.type !== "ui_request" &&
        event.type !== "ui_end" &&
        event.type !== "plan_state_changed" &&
        event.type !== "connected" &&
        event.type !== "disconnected" &&
        event.type !== "process_exit" &&
        typeof mark.streamId === "string" &&
        typeof mark.sequence === "number"
      ) {
        if (stream && stream.streamId !== mark.streamId) {
          stream = null;
          view = {
            ...view,
            liveMessage: null,
            toolResults: retainEndedTools(view.toolResults),
          };
          liveId = null;
          void Promise.resolve().then(() => refresh(true));
        }
        if (
          coveredByLive &&
          stream?.streamId === mark.streamId &&
          mark.sequence <= stream.sequence
        )
          return;
        if (
          !stream ||
          stream.streamId !== mark.streamId ||
          mark.sequence > stream.sequence
        )
          stream = { streamId: mark.streamId, sequence: mark.sequence };
      }
      switch (event.type) {
        case "ui_request": {
          if (
            (typeof event.id !== "number" && typeof event.id !== "string") ||
            typeof event.method !== "string" ||
            !Array.isArray(event.args)
          )
            break;
          const request = event as unknown as ChatDialogRequest;
          clearTimeout(dialogTimer);
          view = {
            ...view,
            dialog: request,
            dialogSubmitting: uncertain.has(request.id),
            dialogError: uncertain.has(request.id)
              ? "Response may have been sent; waiting for confirmation."
              : null,
          };
          if (request.expiresAt !== undefined) {
            const id = request.id;
            dialogTimer = setTimeout(
              () => {
                if (!current() || view.dialog?.id !== id) return;
                uncertain.delete(id);
                view = {
                  ...view,
                  dialog: null,
                  dialogSubmitting: false,
                  dialogError: null,
                };
                publish();
              },
              Math.max(0, request.expiresAt - Date.now()),
            );
          }
          break;
        }
        case "ui_end":
          if (typeof event.id === "string" || typeof event.id === "number") {
            uncertain.delete(event.id);
            if (view.dialog?.id === event.id) {
              clearTimeout(dialogTimer);
              view = {
                ...view,
                dialog: null,
                dialogSubmitting: false,
                dialogError: null,
              };
            }
          }
          break;
        case "connected":
          wrapperConnected = true;
          recoverHandoffs();
          view = { ...view, ready: true };
          void Promise.resolve().then(() => refresh(true));
          void refreshPlan();
          break;
        case "disconnected":
        case "process_exit":
          wrapperConnected = false;
          planRevision += 1;
          if (event.type === "process_exit") {
            pendingPlans.current.delete(key);
            if (planModeAwaitingAuthority) {
              planModeAwaitingAuthority = false;
              planModePending = false;
            }
          }
          planSynchronized = false;
          view = {
            ...view,
            ready: false,
            active: false,
            modelActivity: undefined,
            ...(event.type === "process_exit"
              ? {
                  planEnabled: false,
                  planProposal: undefined,
                  planCommandPending: planModePending,
                }
              : {}),
          };
          break;
        case "plan_state_changed": {
          const state = readPlanState(event);
          if (state) {
            planRevision += 1;
            planSynchronized = true;
            applyPlanState(state);
          }
          break;
        }
        case "agent_start":
          view = {
            ...view,
            active: true,
            liveMessage: null,
            toolResults: retainEndedTools(view.toolResults),
          };
          liveId = null;
          break;
        case "model_activity": {
          const activity = readModelActivity(event.activity);
          const previous = view.modelActivity;
          if (
            activity &&
            (!previous ||
              activity.epoch > previous.epoch ||
              (activity.epoch === previous.epoch &&
                activity.version > previous.version))
          )
            view = { ...view, modelActivity: activity };
          break;
        }
        case "agent_end":
        case "prompt_result":
        case "prompt_error":
          view = { ...view, active: false, modelActivity: undefined };
          void Promise.resolve().then(() => refresh(true));
          break;
        case "auto_compaction_end":
        case "compaction_end":
          void Promise.resolve().then(() => refresh(true));
          break;
        case "queue_update":
          if (Array.isArray(event.steering) && Array.isArray(event.followUp))
            view = { ...view, queue: event as unknown as Queue };
          break;
        case "outbox_update":
          if (Array.isArray(event.entries))
            applyOutbox(
              event.entries as OutboxEntry[],
              Array.isArray(event.settledIds)
                ? (event.settledIds as string[])
                : [],
              Array.isArray(event.nativeSettledIds)
                ? (event.nativeSettledIds as string[])
                : [],
            );
          break;
        case "message_start":
        case "message_update":
        case "message_end": {
          const message = isRecord(event.message) ? event.message : null;
          if (message?.role === "user" && event.type !== "message_update") {
            const clientId =
              typeof event.clientMessageId === "string"
                ? event.clientMessageId
                : undefined;
            rememberUserMessage(message, clientId);
          }
          if (message?.role === "assistant") {
            const id =
              typeof event.messageId === "string" ? event.messageId : null;
            if (isDeltaUpdate(event)) {
              const base =
                !id || !liveId || id === liveId ? view.liveMessage : null;
              const next = applyMessageDelta(
                base ?? undefined,
                event.assistantMessageEvent,
              );
              if (next) view = { ...view, liveMessage: next };
              else void Promise.resolve().then(() => refresh(false));
            } else if (Array.isArray(message.content)) {
              view = {
                ...view,
                liveMessage: message as LiveMessage,
                active: event.type !== "message_end" || view.active,
              };
              liveId = id;
            }
            if (event.type === "message_end") releaseSaved();
          }
          if (event.type === "message_end")
            void Promise.resolve().then(() => refresh(false));
          break;
        }
        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end":
          view = {
            ...view,
            toolResults: applyToolEvent(
              view.toolResults,
              event,
              view.context?.messages ?? [],
            ),
          };
          break;
        case "session_history_changed":
          void Promise.resolve().then(() => refresh(false));
          break;
      }
      publish();
    }
    function receive(data: unknown) {
      if (!current() || !isRecord(data) || typeof data.type !== "string")
        return;
      const event = data as Event;
      if (event.type === "session_history_changed") {
        historyGeneration += 1;
        cursor = null;
        rootKnown = false;
        buffered = buffered.filter(
          (item) => !item.type.startsWith("tool_execution_"),
        );
        view = { ...view, toolResults: {}, historyView: view.historyView + 1 };
        publish();
      }
      if (
        event.type === "ui_request" ||
        event.type === "ui_end" ||
        event.type === "connected" ||
        event.type === "disconnected" ||
        event.type === "process_exit" ||
        event.type === "plan_state_changed"
      ) {
        applyEvent(event);
        return;
      }
      if (!initialized || reading || paging) buffered.push(event);
      else applyEvent(event);
    }
    function drain(snapshot: SyncPage["live"] | null) {
      const events = buffered;
      buffered = [];
      for (let index = 0; index < events.length; index++) {
        const event = events[index];
        const mark = event.web;
        if (snapshot && mark?.streamId === snapshot.cursor.streamId) {
          const covered =
            /^(agent_start|agent_end|prompt_result|prompt_error|message_start|message_update|message_end|tool_execution_start|tool_execution_update|tool_execution_end)$/.test(
              event.type,
            ) && !(isRecord(event.message) && event.message.role === "user");
          if (covered && mark.sequence <= snapshot.cursor.sequence) {
            // Ended calls are deliberately absent from the live snapshot, even
            // when its cursor covers their buffered end frame.
            view = {
              ...view,
              toolResults: applyCoveredToolEvent(
                view.toolResults,
                event,
                view.context?.messages ?? [],
              ),
            };
            continue;
          }
          if (
            isDeltaUpdate(event) &&
            (mark.first ?? mark.sequence) <= snapshot.cursor.sequence
          ) {
            // The snapshot covers only part of this merged delta. Keep the
            // suffix and fetch a covering snapshot rather than duplicate text.
            buffered.push(...events.slice(index));
            requested = true;
            return;
          }
        }
        applyEvent(event);
      }
    }
    async function sync() {
      const generation = historyGeneration;
      let replacedHistory = false;
      let next = view.context;
      let position = cursor;
      let nextHasOlder = view.hasOlder;
      let last: SyncPage | null = null;
      if (position && !rootKnown) {
        // Tail pages do not include the selected history's first entry. Probe
        // sync once for that durable root, then catch up from the tail's tip.
        const params = new URLSearchParams({ sync: "1", hostId });
        const first = await requestJson<JsonResponse<"getSessionContext">>(
          origin,
          `${sessionPath}/context?${params}`,
        );
        if (!current()) return null;
        if (!("mode" in first) || first.sessionId !== sessionId)
          throw new Error("Invalid session sync response");
        position = {
          firstEntryId: first.cursor.firstEntryId,
          lastEntryId: position.lastEntryId,
        };
      }
      while (current()) {
        const params = new URLSearchParams({ sync: "1", hostId });
        if (position) params.set("cursor", JSON.stringify(position));
        const result = await requestJson<JsonResponse<"getSessionContext">>(
          origin,
          `${sessionPath}/context?${params}`,
        );
        if (!current()) return null;
        if (
          !("mode" in result) ||
          result.sessionId !== sessionId ||
          result.context.messages.length !== result.context.entryIds.length
        )
          throw new Error("Invalid session sync response");
        if (
          result.mode === "append" &&
          result.baseEntryId !== (position?.lastEntryId ?? null)
        )
          throw new Error("Session history cursor changed");
        if (result.mode === "replace") {
          if (position?.lastEntryId) replacedHistory = true;
          next = result.context;
          nextHasOlder = false;
        } else if (next && result.context.entryIds.length === 0) {
          // Metadata may change even when the durable transcript does not.
          next = {
            ...result.context,
            messages: next.messages,
            entryIds: next.entryIds,
          };
        } else {
          const ids = new Set(next?.entryIds ?? []);
          const messages = [...(next?.messages ?? [])];
          const entryIds = [...(next?.entryIds ?? [])];
          result.context.entryIds.forEach((id, index) => {
            if (!ids.has(id)) {
              ids.add(id);
              entryIds.push(id);
              messages.push(result.context.messages[index]);
            }
          });
          next = { ...result.context, messages, entryIds };
        }
        const previous = position;
        position = result.cursor;
        last = result;
        if (!result.hasMore) break;
        if (
          previous?.firstEntryId === position.firstEntryId &&
          previous?.lastEntryId === position.lastEntryId
        )
          throw new Error("Session sync cursor did not advance");
      }
      if (!current() || !last || !next) return null;
      if (generation !== historyGeneration) {
        requested = true;
        return null;
      }
      if (replacedHistory) {
        view = { ...view, toolResults: {}, historyView: view.historyView + 1 };
        buffered = buffered.filter(
          (event) => !event.type.startsWith("tool_execution_"),
        );
      }
      cursor = position;
      rootKnown = true;
      const reconciledTools = reconcileToolSnapshot(
        view.toolResults,
        last.live?.toolEvents ?? [],
        next.messages,
      );
      view = {
        ...view,
        context: next,
        hasOlder: nextHasOlder,
        error: null,
        toolResults: sameToolResults(view.toolResults, reconciledTools)
          ? view.toolResults
          : reconciledTools,
      };
      releaseSaved();
      if (last.live) {
        stream = last.live.cursor;
        liveId = last.live.streamingMessageId ?? null;
        const saved = view.liveMessage;
        view = {
          ...view,
          active:
            last.live.isStreaming ||
            last.live.isPromptRunning ||
            last.live.isCompacting,
          liveMessage:
            last.live.streamingMessage ??
            (saved?.role === "assistant" ? saved : null),
        };
        releaseSaved();
      }
      return last.live;
    }
    function refresh(withState: boolean): Promise<void> {
      if (!current()) return Promise.resolve();
      requested = true;
      stateRequested ||= withState;
      if (paging) return Promise.resolve();
      if (readPromise) return readPromise;
      readPromise = (async () => {
        while (current() && requested) {
          requested = false;
          const loadState = stateRequested;
          stateRequested = false;
          reading = true;
          try {
            const stateBoundary = buffered.length;
            const state = loadState
              ? await requestJson<StateResponse>(
                  origin,
                  `${sessionPath}/state?${hostQuery}`,
                )
              : null;
            if (state) {
              for (const event of buffered.slice(0, stateBoundary)) {
                if (
                  event.type === "outbox_update" &&
                  Array.isArray(event.entries)
                )
                  applyOutbox(
                    event.entries as OutboxEntry[],
                    Array.isArray(event.settledIds)
                      ? (event.settledIds as string[])
                      : [],
                    Array.isArray(event.nativeSettledIds)
                      ? (event.nativeSettledIds as string[])
                      : [],
                  );
              }
              buffered = buffered.filter(
                (event, index) =>
                  index >= stateBoundary ||
                  (event.type !== "queue_update" &&
                    event.type !== "outbox_update"),
              );
            }
            const snapshot = await sync();
            if (!current()) return;
            if (reconcilingCached && !requested) {
              reconcilingCached = false;
              if (
                !snapshot ||
                (!snapshot.isStreaming &&
                  !snapshot.isPromptRunning &&
                  !snapshot.isCompacting)
              ) {
                liveId = null;
                const retained = retainEndedTools(view.toolResults);
                view = {
                  ...view,
                  liveMessage: null,
                  toolResults: sameToolResults(view.toolResults, retained)
                    ? view.toolResults
                    : retained,
                };
              }
            }
            if (state) {
              view = {
                ...view,
                state,
                modelActivity: state.state?.modelActivity,
                queue: state.state?.queuedMessages ?? emptyQueue,
              };
              applyOutbox(
                state.outbox,
                state.outboxSettledIds,
                state.nativeSettledIds ?? [],
              );
              if (!snapshot)
                view = {
                  ...view,
                  active: !!(
                    state.state?.isPromptRunning ||
                    state.state?.isStreaming ||
                    state.state?.isCompacting
                  ),
                };
            }
            reading = false;
            drain(snapshot);
            view = { ...view, loading: false };
            publish();
          } catch (cause) {
            reading = false;
            drain(null);
            report(cause);
            break;
          }
        }
      })().finally(() => {
        readPromise = null;
        if (current() && requested) void refresh(stateRequested);
      });
      return readPromise;
    }
    async function issueRaw(
      command: BrowserCommand,
      allowSessionChange = false,
    ): Promise<BrowserReply> {
      if (!current()) throw new Error("Session changed");
      const reply = await link.command(
        sessionId!,
        hostId,
        command,
        advisorRef.current,
      );
      if (!current() && !allowSessionChange) throw new Error("Session changed");
      if (!("success" in reply.data) || !reply.data.success) {
        const failure = reply.data as {
          error?: string;
          delivery?: string;
          code?: string;
        };
        const error = new Error(failure.error ?? "Command failed");
        Object.assign(error, {
          delivery: failure.delivery,
          code: failure.code,
        });
        throw error;
      }
      return reply;
    }
    async function issue(command: BrowserCommand): Promise<BrowserReply> {
      if (command.type === "respond_plan_proposal")
        throw new Error("Use respondPlanProposal to decide a plan.");
      if (command.type !== "get_plan_state" && command.type !== "set_plan_mode")
        return issueRaw(command);
      if (command.type === "set_plan_mode") {
        if (planModePending || pendingPlans.current.has(key))
          throw new Error("A plan command is already pending.");
        planModePending = true;
        view = { ...view, planCommandPending: true };
        publish();
      }
      const revisionAtStart = ++planRevision;
      try {
        const reply = await issueRaw(command);
        const data: unknown =
          "success" in reply.data && reply.data.success
            ? reply.data.data
            : undefined;
        applyPlanSnapshot(data, revisionAtStart);
        return reply;
      } catch (cause) {
        if (command.type === "set_plan_mode" && current()) {
          planModeAwaitingAuthority = true;
          await refreshPlan();
        }
        throw cause;
      } finally {
        if (command.type === "set_plan_mode") {
          if (!planModeAwaitingAuthority) planModePending = false;
          if (current()) {
            view = {
              ...view,
              planCommandPending:
                planModePending || pendingPlans.current.has(key),
            };
            publish();
          }
        }
      }
    }
    async function respondPlanProposal(
      id: string,
      approved: boolean,
      feedback?: string,
    ): Promise<boolean> {
      const proposal = view.planProposal;
      if (
        !current() ||
        !view.ready ||
        !planSynchronized ||
        !proposal ||
        proposal.id !== id ||
        planModePending ||
        pendingPlans.current.has(key)
      )
        return false;
      const pending: PendingPlanDecision = {
        id,
        proposal,
        uncertain: false,
        inFlight: true,
      };
      pendingPlans.current.set(key, pending);
      const revisionAtStart = ++planRevision;
      view = { ...view, planCommandPending: true };
      publish();
      try {
        const reply = await issueRaw(
          {
            type: "respond_plan_proposal",
            id,
            approved,
            ...(feedback === undefined ? {} : { feedback }),
          },
          true,
        );
        const data: unknown =
          "success" in reply.data && reply.data.success
            ? reply.data.data
            : undefined;
        const state = readPlanState(data);
        if (!state) throw new Error("Invalid plan decision response.");
        pending.inFlight = false;
        if (pendingPlans.current.get(key) === pending && current()) {
          if (!applyPlanSnapshot(state, revisionAtStart)) await refreshPlan();
          void refresh(true);
        } else if (!current()) pending.reconcile?.();
        return true;
      } catch (cause) {
        pending.inFlight = false;
        pending.uncertain = !(
          (cause instanceof BrowserLinkError &&
            cause.code === "transport_unavailable") ||
          (isRecord(cause) &&
            (cause.delivery === "refused" ||
              cause.code === "stale_proposal" ||
              cause.code === "rpc_command_failed"))
        );
        if (pendingPlans.current.get(key) === pending && current()) {
          await refreshPlan();
          void refresh(true);
        } else if (!current()) pending.reconcile?.();
        return false;
      }
    }
    async function respondDialog(value?: ChatDialogValue) {
      const request = view.dialog;
      if (!request || view.dialogSubmitting || !current())
        throw new Error("No answerable dialog");
      const id = request.id;
      uncertain.add(id);
      view = { ...view, dialogSubmitting: true, dialogError: null };
      publish();
      try {
        await issue({
          type: "ui_response",
          id,
          ...(value === undefined ? {} : { value }),
        });
        uncertain.delete(id);
        if (current() && view.dialog?.id === id) {
          clearTimeout(dialogTimer);
          view = {
            ...view,
            dialog: null,
            dialogSubmitting: false,
            dialogError: null,
          };
          publish();
        }
      } catch (cause) {
        const refused =
          (cause instanceof BrowserLinkError &&
            cause.code === "transport_unavailable") ||
          (isRecord(cause) && cause.delivery === "refused");
        if (refused) uncertain.delete(id);
        if (current() && view.dialog?.id === id) {
          view = {
            ...view,
            dialogSubmitting: !refused,
            dialogError: refused
              ? errorText(cause)
              : "Response may have been sent; waiting for confirmation.",
          };
          publish();
        }
        throw cause;
      }
    }
    async function reconcileIntent(id: string, refreshBefore = true) {
      try {
        if (refreshBefore) await refresh(true);
        const reply = await issue({
          type: "get_client_message_status",
          clientMessageIds: [id],
        });
        const data: unknown =
          "success" in reply.data && reply.data.success
            ? reply.data.data
            : null;
        if (!isRecord(data)) return;
        const persisted =
          Array.isArray(data.persistedClientMessageIds) &&
          data.persistedClientMessageIds.includes(id);
        const resolved =
          Array.isArray(data.resolvedClientMessageIds) &&
          data.resolvedClientMessageIds.includes(id);
        if (Array.isArray(data.messages)) {
          for (const item of data.messages) {
            if (isRecord(item) && item.clientMessageId === id)
              rememberUserMessage(item.message, id);
          }
        }
        if (resolved) local.delete(id);
        if (persisted) void refresh(false);
        publish();
      } catch {
        // Absence or an unavailable status is not proof of non-delivery.
      }
    }
    async function sendFirst(message: string, attachments?: ChatAttachments) {
      if (
        !message.trim() &&
        !attachments?.uploads?.length &&
        !attachments?.images?.length
      )
        return;
      if (!view.ready) throw new Error("Session subscription is not ready.");
      if ([...local.values()].some((item) => item.message === message))
        throw new Error(
          "This prompt has already been submitted; reconcile before trying again.",
        );
      const id = messageId();
      local.set(id, { id, message, state: "sending" });
      publish();
      try {
        await issue({
          type: "prompt",
          clientMessageId: id,
          message,
          ...attachments,
        });
        const pending = local.get(id);
        if (pending) local.set(id, { ...pending, state: "delivered" });
        publish();
      } catch (cause) {
        const refused =
          (cause instanceof BrowserLinkError &&
            cause.code === "transport_unavailable") ||
          (isRecord(cause) && cause.delivery === "refused");
        if (refused) local.delete(id);
        else
          local.set(id, {
            id,
            message,
            state: "uncertain",
            error: errorText(cause),
          });
        if (current()) {
          publish();
          if (!refused) void reconcileIntent(id);
        }
        throw cause;
      }
    }
    async function send(
      message: string,
      mode: "prompt" | "followUp" | "steer" = "prompt",
      attachments?: ChatAttachments,
    ) {
      if (
        !message.trim() &&
        !attachments?.uploads?.length &&
        !attachments?.images?.length
      )
        return;
      if (
        [...local.values()].some(
          (item) => item.message === message && item.state === "uncertain",
        )
      )
        throw new Error(
          "Previous delivery is uncertain; reconcile before sending again.",
        );
      const scope = view.state?.outboxScope;
      if (!scope) throw new Error("Session outbox is not ready.");
      const id = messageId();
      local.set(id, { id, message, state: "sending" });
      outboxGeneration += 1;
      publish();
      try {
        const reply = await issue({
          type: "outbox_add",
          id,
          scope,
          message,
          mode,
          ...attachments,
        });
        const data: unknown =
          "success" in reply.data && reply.data.success
            ? reply.data.data
            : undefined;
        if (
          !isRecord(data) ||
          !isRecord(data.entry) ||
          data.entry.id !== id ||
          data.entry.sessionId !== sessionId
        )
          throw new Error("Outbox receipt could not be confirmed");
        if (!current()) return;
        const entry = data.entry as OutboxEntry;
        local.set(id, {
          id,
          message: entry.message,
          state: entry.state,
          error: entry.error,
        });
        seenOutbox.add(id);
        if (!settled.has(id) && !view.outbox.some((item) => item.id === id))
          view = { ...view, outbox: [...view.outbox, entry] };
        subscribeSession();
        publish();
      } catch (cause) {
        const refused =
          (cause instanceof BrowserLinkError &&
            cause.code === "transport_unavailable") ||
          (isRecord(cause) && cause.delivery === "refused");
        if (refused) local.delete(id);
        else if (!settled.has(id) && !seenOutbox.has(id))
          local.set(id, {
            id,
            message,
            state: "uncertain",
            error: errorText(cause),
          });
        if (!current()) throw cause;
        publish();
        if (!refused) {
          // Never reissue this intent automatically. Reconcile the web receipt
          // and native correlation before the user can send this text again.
          subscribeSession();
          void reconcileIntent(id);
        }
        throw cause;
      }
    }
    async function older() {
      if (readPromise) await readPromise;
      if (
        !current() ||
        paging ||
        !view.hasOlder ||
        !revision ||
        !view.context?.entryIds.length
      )
        return;
      paging = true;
      const before = view.context.entryIds[0];
      const generation = revision;
      const historyAtStart = historyGeneration;
      view = { ...view, loadingHistory: true };
      publish();
      try {
        const params = new URLSearchParams({
          tail: "30",
          before,
          historyRevision: generation,
          hostId,
        });
        const page = await requestJson<JsonResponse<"getSession">>(
          origin,
          `${sessionPath}?${params}`,
        );
        if (!current()) return;
        if (
          historyAtStart !== historyGeneration ||
          page.historyRevision !== generation ||
          page.context.entryIds.length !== page.context.messages.length ||
          view.context?.entryIds[0] !== before
        )
          throw new Error("History changed while loading older messages");
        const seen = new Set(view.context.entryIds);
        if (
          page.context.entryIds.some((id) => seen.has(id)) ||
          (page.historyHasMore && !page.context.entryIds.length)
        )
          throw new Error("Invalid history page");
        view = {
          ...view,
          context: {
            ...view.context,
            messages: [...page.context.messages, ...view.context.messages],
            entryIds: [...page.context.entryIds, ...view.context.entryIds],
          },
          hasOlder: !!page.historyHasMore,
        };
      } catch (cause) {
        if (current()) {
          view = { ...view, toolResults: {} };
          cursor = null;
          requested = true;
          report(cause);
        }
      } finally {
        paging = false;
        if (current()) {
          view = { ...view, loadingHistory: false };
          drain(null);
          publish();
          if (requested) void refresh(stateRequested);
        }
      }
    }
    function subscribeSession() {
      if (!current() || subscribed) return;
      subscribed = true;
      subscriptionGeneration = outboxGeneration;
      releaseSession = link.subscribe(
        { kind: "session", hostId, sessionId: sessionId! },
        {
          onOpen() {
            wrapperConnected = false;
            planSynchronized = false;
            if (!current()) return;
            clearTimeout(dialogTimer);
            view = {
              ...view,
              ready: true,
              dialog: null,
              dialogSubmitting: false,
              dialogError: null,
            };
            publish();
            void refreshPlan();
            if (initialized) void refresh(true);
            else stateRequested = true;
          },
          onEnd(reason, code) {
            if (!current()) return;
            planSynchronized = false;
            wrapperConnected = false;
            planRevision += 1;
            if (code) {
              subscribed = false;
              releaseSession = undefined;
            }
            view = {
              ...view,
              ready: false,
              ...(code === "session_not_managed" ? {} : { error: reason }),
            };
            publish();
            if (
              code === "session_not_managed" &&
              outboxGeneration > subscriptionGeneration
            )
              subscribeSession();
          },
          onEvent: receive,
        },
      );
    }
    if (savedPlan)
      savedPlan.reconcile = () => {
        void refreshPlan();
      };
    runtime.current = {
      key,
      issue,
      send,
      sendFirst,
      respondDialog,
      respondPlanProposal,
      older,
      refresh: () => refresh(true),
    };
    publish();
    subscribeSession();
    const releaseRunning = link.subscribe(
      { kind: "running" },
      {
        onEvent(data) {
          if (!current() || !isRecord(data)) return;
          if (
            data.type === "running" &&
            Array.isArray(data.runningSessions) &&
            data.runningSessions.some(
              (item) =>
                isRecord(item) &&
                item.hostId === hostId &&
                item.id === sessionId,
            )
          )
            subscribeSession();
          if (data.type !== "sessions-changed" || !Array.isArray(data.sessions))
            return;
          if (
            data.sessions.some(
              (item) =>
                isRecord(item) &&
                item.hostId === hostId &&
                item.sessionId === sessionId,
            )
          ) {
            if (initialized) void refresh(false);
            else requested = true;
          }
        },
      },
    );
    if (cached) {
      void refresh(true).then(() => {
        for (const pending of local.values())
          if (pending.state === "uncertain") void reconcileIntent(pending.id);
      });
    } else
      void (async () => {
        try {
          const historyAtStart = historyGeneration;
          const params = new URLSearchParams({ tail: "30", hostId });
          const page = await requestJson<JsonResponse<"getSession">>(
            origin,
            `${sessionPath}?${params}`,
          );
          if (!current()) return;
          if (historyAtStart !== historyGeneration) {
            initialized = true;
            await refresh(true);
            return;
          }
          if (page.context.messages.length !== page.context.entryIds.length)
            throw new Error("Invalid session history");
          revision = page.historyRevision ?? null;
          cursor = {
            firstEntryId: page.context.entryIds[0] ?? null,
            lastEntryId:
              page.context.entryIds[page.context.entryIds.length - 1] ?? null,
          };
          rootKnown = !page.historyHasMore;
          view = {
            ...view,
            context: page.context,
            hasOlder: !!page.historyHasMore,
          };
          initialized = true;
          await refresh(true);
          for (const pending of local.values())
            if (pending.state === "uncertain") void reconcileIntent(pending.id);
        } catch (cause) {
          if (current()) {
            initialized = true;
            if (cause instanceof KeylimeHttpError && cause.status === 404) {
              await refresh(true);
              return;
            }
            drain(null);
            report(cause);
          }
        }
      })();
    return () => {
      disposed = true;
      clearTimeout(dialogTimer);
      releaseSession?.();
      releaseRunning();
      if (runtime.current?.key === key) runtime.current = null;
    };
  }, [origin, hostId, sessionId, link, key, sessionOpen]);

  const issueCommand = useCallback((command: BrowserCommand) => {
    const target = runtime.current;
    if (!target || target.key !== keyRef.current)
      return Promise.reject(new Error("No active session"));
    return target.issue(command);
  }, []);
  const send = useCallback(
    (
      message: string,
      mode?: "prompt" | "followUp" | "steer",
      attachments?: ChatAttachments,
    ) => {
      const target = runtime.current;
      if (!target || target.key !== keyRef.current)
        return Promise.reject(new Error("No active session"));
      return target.send(message, mode, attachments);
    },
    [],
  );
  const sendFirst = useCallback(
    (message: string, attachments?: ChatAttachments) => {
      const target = runtime.current;
      if (!target || target.key !== keyRef.current)
        return Promise.reject(new Error("No active session"));
      return target.sendFirst(message, attachments);
    },
    [],
  );
  const respondDialog = useCallback((value?: ChatDialogValue) => {
    const target = runtime.current;
    if (!target || target.key !== keyRef.current)
      return Promise.reject(new Error("No active session"));
    return target.respondDialog(value);
  }, []);
  const respondPlanProposal = useCallback(
    (id: string, approved: boolean, feedback?: string) => {
      const target = runtime.current;
      if (!target || target.key !== keyRef.current)
        return Promise.resolve(false);
      return target.respondPlanProposal(id, approved, feedback);
    },
    [],
  );
  const stop = useCallback(async () => {
    await issueCommand({ type: "abort" });
  }, [issueCommand]);
  const loadOlder = useCallback(
    () =>
      runtime.current?.key === keyRef.current
        ? runtime.current.older()
        : Promise.resolve(),
    [],
  );
  const refresh = useCallback(
    () =>
      runtime.current?.key === keyRef.current
        ? runtime.current.refresh()
        : Promise.resolve(),
    [],
  );
  const result =
    rendered.key === key && (!sessionId || openSessionKeys.has(key))
      ? rendered.value
      : openSessionKeys.has(key) && recent.current.has(key)
        ? {
            ...recent.current.get(key)!.view,
            ready: false,
            loadingHistory: false,
            dialog: null,
            dialogSubmitting: false,
            dialogError: null,
          }
        : initial();
  const liveMessage = useMemo(
    () =>
      result.liveMessage
        ? (normalizeToolCalls(
            displayMessage(result.liveMessage) as unknown as AgentMessage,
          ) as unknown as LiveMessage)
        : null,
    [result.liveMessage],
  );
  return {
    ...result,
    liveMessage,
    issueCommand,
    send,
    sendFirst,
    respondDialog,
    respondPlanProposal,
    stop,
    loadOlder,
    refresh,
  };
}
