import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyMessageDelta,
  displayMessage,
  isDeltaUpdate,
} from "../lib/message-delta";
import { isRecord } from "../lib/type-guards";
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
  toolEvents: Record<string, Event>;
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
  toolEvents: {},
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
const messageId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
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
}: {
  origin: string;
  hostId: string;
  sessionId: string | null;
  link: BrowserLink;
  onUnauthorized?: () => void;
}) {
  const key = JSON.stringify([origin, hostId, sessionId]);
  const keyRef = useRef(key);
  keyRef.current = key;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const [rendered, setRendered] = useState<{
    key: string;
    value: ChatSessionView;
  }>({ key, value: initial() });
  // Intents remain associated with their server and host across chat navigation.
  const pendingBySession = useRef(
    new Map<string, Map<string, PendingChatInput>>(),
  );
  const echoesBySession = useRef(
    new Map<string, Map<string, ChatUserMessage>>(),
  );
  const uncertainDialogs = useRef(new Map<string, Set<string | number>>());
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
    older(): Promise<void>;
    refresh(): Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (!sessionId) {
      runtime.current = null;
      setRendered({ key, value: { ...initial(), loading: false } });
      return;
    }
    let disposed = false;
    const current = () => !disposed && keyRef.current === key;
    let view = initial();
    let cursor: Cursor | null = null;
    let rootKnown = false;
    let revision: string | null = null;
    let liveId: string | null = null;
    let stream: { streamId: string; sequence: number } | null = null;
    let initialized = false;
    let reading = false;
    let requested = false;
    let stateRequested = false;
    let readPromise: Promise<void> | null = null;
    let paging = false;
    let wrapperConnected = false;
    const handoffReads = new Set<string>();
    let buffered: Event[] = [];
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
          return;
        }
      }
      echoes.set(`echo:${messageId()}`, message);
    }
    function publish() {
      if (!current()) return;
      for (const [id, echo] of echoes) {
        if (
          view.context?.messages.some(
            (saved) => saved.role === "user" && sameSavedUser(saved, echo),
          )
        )
          echoes.delete(id);
      }
      const echoedUserMessages = [...echoes].map(([id, message]) => ({
        id,
        message,
      }));
      const represented = new Set<string>();
      for (const id of view.context?.resolvedClientMessageIds ?? [])
        represented.add(id);
      for (const message of view.context?.messages ?? [])
        if (message.role === "user" && message.clientMessageId)
          represented.add(message.clientMessageId);
      for (const { message } of echoedUserMessages)
        if (message.clientMessageId) represented.add(message.clientMessageId);
      // A queue slot only hides the pending row while it is queued; it does
      // not prove the native message has appeared in durable history.
      for (const id of represented) local.delete(id);
      for (const id of view.queue.clientMessageIds?.steering ?? [])
        if (id) represented.add(id);
      for (const id of view.queue.clientMessageIds?.followUp ?? [])
        if (id) represented.add(id);
      const entries = view.outbox.filter(
        (entry) =>
          !represented.has(entry.id) &&
          !settled.has(entry.id) &&
          entry.state !== "delivered",
      );
      const pendingInput: PendingChatInput[] = entries.map(
        ({ id, message, state, error }) => ({ id, message, state, error }),
      );
      for (const entry of local.values())
        if (
          !represented.has(entry.id) &&
          (!settled.has(entry.id) || nativeSettled.has(entry.id)) &&
          !entries.some((item) => item.id === entry.id)
        )
          pendingInput.push(entry);
      setRendered({
        key,
        value: { ...view, pendingInput, echoedUserMessages },
      });
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
        typeof mark.streamId === "string" &&
        typeof mark.sequence === "number"
      ) {
        if (stream && stream.streamId !== mark.streamId) {
          stream = null;
          view = { ...view, liveMessage: null, toolEvents: {} };
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
          break;
        case "disconnected":
        case "process_exit":
          wrapperConnected = false;
          view = { ...view, ready: false, active: false };
          break;
        case "agent_start":
          view = { ...view, active: true, liveMessage: null, toolEvents: {} };
          liveId = null;
          break;
        case "agent_end":
        case "prompt_result":
        case "prompt_error":
          view = { ...view, active: false };
          void Promise.resolve().then(() => refresh(false));
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
          if (typeof event.toolCallId === "string")
            view = {
              ...view,
              toolEvents: { ...view.toolEvents, [event.toolCallId]: event },
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
      if (event.type === "ui_request" || event.type === "ui_end") {
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
          if (covered && mark.sequence <= snapshot.cursor.sequence) continue;
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
          next = result.context;
          nextHasOlder = false;
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
      cursor = position;
      rootKnown = true;
      view = { ...view, context: next, hasOlder: nextHasOlder, error: null };
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
          toolEvents: Object.fromEntries(
            last.live.toolEvents.map((event) => [
              event.toolCallId,
              event as Event,
            ]),
          ),
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
            if (state) {
              view = {
                ...view,
                state,
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
    async function issue(command: BrowserCommand): Promise<BrowserReply> {
      if (!current()) throw new Error("Session changed");
      const reply = await link.command(sessionId!, hostId, command);
      if (!current()) throw new Error("Session changed");
      if (!("success" in reply.data) || !reply.data.success) {
        const failure = reply.data as { error?: string; delivery?: string };
        const error = new Error(failure.error ?? "Command failed");
        Object.assign(error, { delivery: failure.delivery });
        throw error;
      }
      return reply;
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
            if (initialized) void refresh(true);
            else stateRequested = true;
          },
          onEnd(reason, code) {
            if (!current()) return;
            wrapperConnected = false;
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
    runtime.current = {
      key,
      issue,
      send,
      sendFirst,
      respondDialog,
      older,
      refresh: () => refresh(true),
    };
    setRendered({ key, value: view });
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
    void (async () => {
      try {
        const params = new URLSearchParams({ tail: "30", hostId });
        const page = await requestJson<JsonResponse<"getSession">>(
          origin,
          `${sessionPath}?${params}`,
        );
        if (!current()) return;
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
  }, [origin, hostId, sessionId, link, key]);

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
  const result = rendered.key === key ? rendered.value : initial();
  return {
    ...result,
    liveMessage: result.liveMessage
      ? (normalizeToolCalls(
          displayMessage(result.liveMessage) as unknown as AgentMessage,
        ) as unknown as LiveMessage)
      : null,
    issueCommand,
    send,
    sendFirst,
    respondDialog,
    stop,
    loadOlder,
    refresh,
  };
}
