"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";
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
}: {
  hostId: string;
  cwd: string | null;
  activeId: string | null;
  onSelect: (id: string | null) => void;
  enabled: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const changes = useRef(0);
  const [revision, setRevision] = useState(0);
  const workspace = useRef({ hostId, cwd });
  workspace.current = { hostId, cwd };
  const [busy, setBusy] = useState(false);
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
      {enabled && cwd && (
        <div
          className="workspace-terminal-tabs"
          role="tablist"
          aria-label="Workspace tabs"
        >
          <button
            role="tab"
            aria-selected={activeId === null}
            onClick={() => onSelect(null)}
          >
            Chat
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
            <Plus size={16} />
          </button>
        </div>
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
