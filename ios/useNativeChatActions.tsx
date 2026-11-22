import { useEffect, useRef, useState } from "react";
import {
  BrowserLinkError,
  type BrowserCommand,
  type BrowserReply,
} from "./browser-link";
import {
  useChatActions,
  type ChatIdentity,
  type EditChatRequest,
  type ForkChatRequest,
} from "./ChatActions";
import type { TranscriptMessage } from "./ChatTranscript";
import { editReply, forkReply } from "./chat-mutations";

export type NativeChatActionsProps = {
  session: ChatIdentity;
  messages: readonly TranscriptMessage[];
  entryIds: readonly string[];
  busy: boolean;
  issueCommand: (command: BrowserCommand) => Promise<BrowserReply>;
  /** Load and apply the authoritative active tip; adopt a moved session only if expected is still selected. */
  reloadEdited: (
    result: { sessionId: string; leafId: string | null },
    expected: ChatIdentity,
  ) => Promise<void>;
  /** Atomically preserve/migrate the source draft and apply the update only for this edit's source. */
  setDraft: (
    expected: ChatIdentity,
    targetSessionId: string,
    update: (current: string) => string,
  ) => void;
  onForked: (newSessionId: string, text: string) => void | Promise<void>;
};

const identityKey = (session: ChatIdentity) =>
  JSON.stringify([session.origin, session.hostId, session.sessionId]);

/** Confirmation, command dispatch, and source-scoped edit/fork handoff for one chat. */
export function useNativeChatActions({
  session,
  messages,
  entryIds,
  busy,
  issueCommand,
  reloadEdited,
  setDraft,
  onForked,
}: NativeChatActionsProps) {
  const key = identityKey(session);
  const selection = useRef({ key, generation: 0 });
  if (selection.current.key !== key)
    selection.current = { key, generation: selection.current.generation + 1 };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [uncertainBySession, setUncertainBySession] = useState<
    Record<string, string>
  >({});
  const uncertain = uncertainBySession[key] ?? null;

  function block(identity: ChatIdentity, message: string) {
    if (alive.current)
      setUncertainBySession((previous) => ({
        ...previous,
        [identityKey(identity)]: message,
      }));
  }
  async function command(
    request: EditChatRequest | ForkChatRequest,
    type: "edit_message" | "fork",
  ) {
    try {
      return await issueCommand({ type, entryId: request.entryId });
    } catch (cause) {
      const delivery =
        typeof cause === "object" && cause !== null && "delivery" in cause
          ? cause.delivery
          : undefined;
      if (
        (cause instanceof BrowserLinkError &&
          cause.code === "transport_lost") ||
        delivery === "unknown" ||
        (cause instanceof Error && cause.message === "Session changed")
      ) {
        block(
          request.session,
          "The action's outcome is uncertain. Reconcile this chat before attempting another edit or fork.",
        );
      }
      throw cause;
    }
  }
  async function edit(request: EditChatRequest) {
    const generation = selection.current.generation;
    const reply = await command(request, "edit_message");
    const result = (() => {
      try {
        return editReply(reply);
      } catch (cause) {
        block(
          request.session,
          "The edit result was not confirmed. Reconcile this chat before attempting another edit or fork.",
        );
        throw cause;
      }
    })();
    if (result.cancelled) return;
    if (
      !alive.current ||
      selection.current.generation !== generation ||
      selection.current.key !== identityKey(request.session)
    ) {
      block(
        request.session,
        "The edit completed after leaving this chat. Reload it before attempting another edit or fork.",
      );
      return;
    }
    try {
      await reloadEdited(
        { sessionId: result.sessionId, leafId: result.leafId },
        request.session,
      );
      // The callback owns identity adoption and checks the original source. It must
      // preserve typing and attachments accumulated while the reload was pending.
      if (alive.current)
        setDraft(request.session, result.sessionId, (current) =>
          current.trim() ? current : request.text,
        );
    } catch (cause) {
      block(
        request.session,
        "The edit completed, but its history could not be reloaded. Reconcile this chat before attempting another edit or fork.",
      );
      throw cause;
    }
  }
  async function fork(request: ForkChatRequest) {
    const generation = selection.current.generation;
    const reply = await command(request, "fork");
    const result = (() => {
      try {
        return forkReply(reply);
      } catch (cause) {
        block(
          request.session,
          "The fork result was not confirmed. Check for the new chat before attempting another fork.",
        );
        throw cause;
      }
    })();
    if (result.cancelled || !result.newSessionId) return;
    if (
      !alive.current ||
      selection.current.generation !== generation ||
      selection.current.key !== identityKey(request.session)
    ) {
      block(
        request.session,
        "A fork was created after leaving this chat. Find the new chat before attempting another fork.",
      );
      return;
    }
    try {
      await onForked(
        result.newSessionId,
        request.editPrompt ? (result.text ?? "") : "",
      );
    } catch (cause) {
      block(
        request.session,
        "The fork was created but could not be opened. Find the new chat before attempting another fork.",
      );
      throw cause;
    }
  }

  const actions = useChatActions({
    session,
    messages,
    entryIds,
    busy: busy || !!uncertain,
    onEdit: edit,
    onFork: fork,
  });
  return {
    ...actions,
    uncertain,
    /** Call only after the owner has reconciled the uncertain mutation. */
    clearUncertain: () =>
      setUncertainBySession((previous) => {
        if (!(key in previous)) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      }),
  };
}
