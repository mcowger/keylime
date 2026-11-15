"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { WorkspaceChatPicker } from "./WorkspaceChatPicker";
import type { SessionInfo } from "@/lib/types";
import { openEventStream } from "@/lib/event-stream";
import { MessageSquarePlus, Terminal as TerminalIcon, X } from "lucide-react";
import {
  closeTerminal,
  createTerminal,
  listTerminals,
} from "@/lib/terminal-client";
import type { WorkspaceTerminal as TerminalInfo } from "@/lib/terminal-types";
import { WorkspaceTerminal } from "./WorkspaceTerminal";

type Entry = { hostId: string; terminal: TerminalInfo };

export function WorkspaceTerminalTabs({
  hostId,
  cwd,
  activeId,
  onSelect,
  enabled,
  chatTabs,
  activeChatId,
  onSelectChat,
  onCloseChat,
  onNewChat,
  mobile,
  headerTarget,
  onSelectSaved,
  onGenerateTitle,
  canGenerateTitle,
  onRename,
  activeSessionName,
  canRename,
}: {
  hostId: string;
  cwd: string | null;
  activeId: string | null;
  onSelect: (id: string | null) => void;
  enabled: boolean;
  chatTabs: { id: string; title: string; sessionId?: string }[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onCloseChat: (id: string) => void | Promise<void>;
  onNewChat: () => void;
  mobile: boolean;
  headerTarget: HTMLElement | null;
  onSelectSaved: (session: SessionInfo) => void;
  onGenerateTitle: () => void;
  canGenerateTitle: boolean;
  onRename: (name: string) => void;
  activeSessionName: string;
  canRename: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const changes = useRef(0);
  const [revision, setRevision] = useState(0);
  const workspace = useRef({ hostId, cwd });
  workspace.current = { hostId, cwd };
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [renameValue, setRenameValue] = useState("");
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  const [attention, setAttention] = useState<Set<string>>(() => new Set());
  const closingChats = useRef(new Set<string>());
  const [closingChatIds, setClosingChatIds] = useState(new Set<string>());
  const closeChat = async (id: string) => {
    if (closingChats.current.has(id)) return;
    closingChats.current.add(id);
    setClosingChatIds(new Set(closingChats.current));
    try {
      await onCloseChat(id);
    } finally {
      closingChats.current.delete(id);
      setClosingChatIds(new Set(closingChats.current));
    }
  };
  useEffect(() => {
    const source = openEventStream({ kind: "running" });
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          runningSessionIds?: string[];
          runningSessions?: Array<{ id: string; awaitingInput?: boolean }>;
        };
        if (data.runningSessionIds) setRunning(new Set(data.runningSessionIds));
        if (data.runningSessions)
          setAttention(
            new Set(
              data.runningSessions
                .filter((session) => session.awaitingInput)
                .map((session) => session.id),
            ),
          );
      } catch {
        /* Ignore malformed event frames. */
      }
    };
    return () => source.close();
  }, []);
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const version = changes.current;
    void listTerminals(hostId, cwd)
      .then(({ terminals }) => {
        if (cancelled || version !== changes.current) return;
        setEntries((previous) => [
          ...previous.filter(
            (entry) => entry.hostId !== hostId || entry.terminal.cwd !== cwd,
          ),
          ...terminals.map((terminal) => ({ hostId, terminal })),
        ]);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, cwd, revision]);
  const visible = entries.filter(
    (entry) => entry.hostId === hostId && entry.terminal.cwd === cwd,
  );
  const create = async () => {
    if (!cwd || busy) return;
    setBusy(true);
    try {
      const { terminal } = await createTerminal(hostId, cwd);
      changes.current++;
      setRevision((value) => value + 1);
      setEntries((previous) => [...previous, { hostId, terminal }]);
      if (workspace.current.hostId === hostId && workspace.current.cwd === cwd)
        onSelect(terminal.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const close = async (entry: Entry) => {
    try {
      await closeTerminal(entry.terminal.id, entry.hostId);
      changes.current++;
      setRevision((value) => value + 1);
      setEntries((previous) =>
        previous.filter(
          (item) =>
            item.hostId !== entry.hostId ||
            item.terminal.id !== entry.terminal.id,
        ),
      );
      if (activeId === entry.terminal.id) onSelect(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      {enabled && cwd && !mobile && (
        <div
          className="workspace-terminal-tabs"
          role="tablist"
          aria-label="Workspace tabs"
        >
          {chatTabs.map((tab) => (
            <div key={tab.id} className="workspace-terminal-tab">
              <button
                role="tab"
                aria-selected={activeId === null && activeChatId === tab.id}
                onClick={() => onSelectChat(tab.id)}
                title={tab.title}
              >
                {tab.title}
              </button>
              <button
                aria-label={`${tab.sessionId ? "Archive" : "Close"} ${tab.title}`}
                title={tab.sessionId ? "Archive chat" : "Close chat"}
                disabled={closingChatIds.has(tab.id)}
                onClick={() => void closeChat(tab.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button onClick={onNewChat} title="New chat" aria-label="New chat">
            <MessageSquarePlus size={16} />
          </button>
          {visible.map((entry) => (
            <div
              key={`${entry.hostId}:${entry.terminal.id}`}
              className="workspace-terminal-tab"
            >
              <button
                role="tab"
                aria-selected={activeId === entry.terminal.id}
                onClick={() => onSelect(entry.terminal.id)}
                title={entry.terminal.cwd}
              >
                <TerminalIcon size={14} /> {entry.terminal.title}
              </button>
              <button
                aria-label={`Close ${entry.terminal.title}`}
                title="Close terminal"
                onClick={() => void close(entry)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            onClick={() => void create()}
            disabled={busy}
            title="New terminal"
            aria-label="New terminal"
          >
            <TerminalIcon size={16} />
          </button>
          <button onClick={() => setPickerOpen(true)}>Chats</button>
        </div>
      )}
      {enabled &&
        cwd &&
        mobile &&
        headerTarget &&
        createPortal(
          <button
            ref={triggerRef}
            className="workspace-switcher-trigger"
            onClick={() => setPickerOpen(true)}
            aria-label={`Workspace tabs, ${chatTabs.length + visible.length} open`}
          >
            {(activeId === null
              ? chatTabs.find((tab) => tab.id === activeChatId)?.title
              : visible.find((entry) => entry.terminal.id === activeId)?.terminal
                  .title) || "Workspace"} ·{" "}
            {chatTabs.length + visible.length} tabs
          </button>,
          headerTarget,
        )}
      {enabled && cwd && (
        <Dialog
          open={pickerOpen}
          onOpenChange={(open) => {
            setPickerOpen(open);
            if (!open && mobile)
              requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        >
          <DialogContent
            ariaLabel="Workspace tabs and saved chats"
            className="workspace-switcher-dialog"
            style={
              mobile
                ? {
                    top: "auto",
                    bottom: 0,
                    left: 0,
                    transform: "none",
                    animation: "none",
                    width: "100%",
                    maxWidth: "100%",
                    borderRadius: "16px 16px 0 0",
                    paddingBottom: "max(20px, env(safe-area-inset-bottom))",
                  }
                : { width: 500 }
            }
          >
            <DialogTitle>Workspace tabs</DialogTitle>
            <button
              className="workspace-switcher-close"
              aria-label="Close workspace tabs"
              onClick={() => {
                setPickerOpen(false);
                if (mobile)
                  requestAnimationFrame(() => triggerRef.current?.focus());
              }}
            >
              <X size={18} />
            </button>
            {mobile && (
              <div className="workspace-switcher-list">
                {chatTabs.map((tab) => (
                  <div className="workspace-switcher-row" key={tab.id}>
                    <button
                      onClick={() => {
                        setPickerOpen(false);
                        onSelectChat(tab.id);
                      }}
                      aria-current={
                        activeId === null && activeChatId === tab.id
                          ? "page"
                          : undefined
                      }
                    >
                      {tab.title}
                      {activeId === null && activeChatId === tab.id
                        ? " · Active"
                        : ""}
                      {tab.sessionId && attention.has(tab.sessionId)
                        ? " · Needs attention"
                        : tab.sessionId && running.has(tab.sessionId)
                          ? " · Running"
                          : ""}
                    </button>
                    {activeId === null && activeChatId === tab.id && (
                      <button
                        onClick={onGenerateTitle}
                        disabled={!canGenerateTitle}
                      >
                        Generate title
                      </button>
                    )}
                    {activeId === null &&
                      activeChatId === tab.id &&
                      canRename && (
                        <button
                          onClick={() => {
                            setRenameValue(activeSessionName);
                            setRenaming(true);
                          }}
                        >
                          Rename
                        </button>
                      )}
                    <button
                      aria-label={`${tab.sessionId ? "Archive" : "Close"} ${tab.title}`}
                      title={tab.sessionId ? "Archive chat" : "Close chat"}
                      disabled={closingChatIds.has(tab.id)}
                      onClick={() => void closeChat(tab.id)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                {visible.map((entry) => (
                  <div
                    className="workspace-switcher-row"
                    key={entry.terminal.id}
                  >
                    <button
                      onClick={() => {
                        setPickerOpen(false);
                        onSelect(entry.terminal.id);
                      }}
                    >
                      {entry.terminal.title}
                      {activeId === entry.terminal.id ? " · Active" : ""}
                    </button>
                    <button
                      aria-label={`Close ${entry.terminal.title}`}
                      onClick={() => void close(entry)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                <div className="workspace-switcher-actions">
                  <button
                    onClick={() => {
                      onNewChat();
                      setPickerOpen(false);
                    }}
                  >
                    New chat
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      void create();
                      setPickerOpen(false);
                    }}
                  >
                    New terminal
                  </button>
                </div>
              </div>
            )}
            {mobile && renaming && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  onRename(renameValue);
                  setRenaming(false);
                }}
              >
                <label>
                  Chat name{" "}
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                  />
                </label>
                <button type="submit">Save</button>
                <button type="button" onClick={() => setRenaming(false)}>
                  Cancel
                </button>
              </form>
            )}
            {pickerOpen && (
              <WorkspaceChatPicker
                hostId={hostId}
                cwd={cwd}
                onSelect={(session) => {
                  setPickerOpen(false);
                  onSelectSaved(session);
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
      {enabled && error && (
        <div className="workspace-terminal-error" role="alert">
          {error}
        </div>
      )}
      {entries.map((entry) => (
        <WorkspaceTerminal
          key={`${entry.hostId}:${entry.terminal.id}`}
          terminal={entry.terminal}
          hostId={entry.hostId}
          active={
            enabled &&
            entry.hostId === hostId &&
            entry.terminal.cwd === cwd &&
            activeId === entry.terminal.id
          }
        />
      ))}
    </>
  );
}
