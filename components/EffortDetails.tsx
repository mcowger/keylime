"use client";

import { useEffect, useState } from "react";
import type {
  EffortCleanupPreview,
  EffortRecord,
  SystemsRequest,
} from "@/lib/api-contracts/systems";
import { comparableProjectPath } from "@/lib/comparable-path";
import { LOCAL_HOST_ID } from "@/lib/project-ordering";
import { closeTerminal } from "@/lib/terminal-client";
import type { SessionInfo } from "@/lib/types";
import { sessionKey } from "@/lib/session-identity";
import type { SystemsAction } from "./SystemsHost";
import {
  SystemsButton,
  SystemsDialog,
  SystemsError,
  systemsCard,
  systemsInput,
  systemsMuted,
  systemsRow,
  systemsStack,
  useSystemsAction,
} from "./SystemsForms";

export type EffortTarget = { host: string; id: string };

export const effortStatusLabels: Record<EffortRecord["status"], string> = {
  creating: "Creating",
  failed: "Setup failed",
  ready: "Ready",
  cleaning: "Cleaning up",
  cleanup_failed: "Cleanup failed",
  cleaned: "Cleaned up",
};

export function EffortSavedChats({
  host,
  effort,
  cwd,
  openSessionIds = [],
  onSelect,
}: {
  host: string;
  effort: EffortRecord;
  cwd?: string;
  openSessionIds?: string[];
  onSelect: (session: SessionInfo) => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>();
  const [error, setError] = useState<string>();
  const revision = effort.sessionIds.join("\n");
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/sessions", { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Chats unavailable (HTTP ${response.status})`);
        const data = (await response.json()) as { sessions: SessionInfo[] };
        if (!abort.signal.aborted) {
          setSessions(data.sessions);
          setError(undefined);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => abort.abort();
  }, [host, revision]);
  const owned = new Set(effort.sessionIds);
  const target = cwd && comparableProjectPath(cwd);
  const saved = sessions?.filter((session) => {
    if (
      (session.hostId ?? LOCAL_HOST_ID) !== host ||
      !owned.has(session.id) ||
      openSessionIds.includes(sessionKey(session.id, session.hostId))
    )
      return false;
    if (!target) return true;
    const path = comparableProjectPath(session.cwd);
    if (
      !effort.members.some((member) => {
        const root = comparableProjectPath(member.path);
        return (
          root !== target && (path === root || path.startsWith(`${root}/`))
        );
      })
    )
      return path === target || path.startsWith(`${target}/`);
    return false;
  });
  return (
    <section style={systemsCard} aria-label="Saved Effort chats">
      <strong>Saved chats</strong>
      <SystemsError message={error} />
      {!error &&
        (!saved ? (
          <span role="status">Loading chats…</span>
        ) : (
          !saved.length && <span style={systemsMuted}>No saved chats.</span>
        ))}
      {saved?.map((session) => (
        <SystemsButton
          key={session.id}
          style={{ textAlign: "left" }}
          onClick={() => onSelect(session)}
        >
          {session.name || "Untitled chat"}
        </SystemsButton>
      ))}
    </section>
  );
}
type CleanupMode = Extract<SystemsRequest, { action: "cleanup" }>["mode"];
const cleanupOptions: { mode: CleanupMode; label: string; detail: string }[] = [
  {
    mode: "stop",
    label: "Stop only",
    detail: "Stop running processes and keep worktrees and chats.",
  },
  {
    mode: "remove",
    label: "Remove clean worktrees",
    detail: "Stop processes, archive chats, and remove clean worktrees.",
  },
  {
    mode: "force",
    label: "Force remove worktrees",
    detail:
      "Stop processes, archive chats, and discard all uncommitted, untracked, and Git-ignored files in these worktrees.",
  },
];

function CleanupReview({
  preview,
  busy,
  onConfirm,
  onCancel,
  unavailable,
}: {
  preview: EffortCleanupPreview;
  busy: boolean;
  onConfirm: (mode: CleanupMode) => void;
  onCancel: () => void;
  unavailable?: string;
}) {
  const [mode, setMode] = useState<CleanupMode>();
  const dirty = preview.repos.some((repo) => repo.dirty.length > 0);
  return (
    <div style={systemsStack}>
      <section aria-label="Running processes" style={systemsCard}>
        <strong>Running processes</strong>
        {preview.processes.length ? (
          <ul style={{ margin: 0 }}>
            {preview.processes.map((process, index) => (
              <li key={`${index}:${process}`}>{process}</li>
            ))}
          </ul>
        ) : (
          <span>None reported.</span>
        )}
      </section>
      {preview.repos.map((repo) => (
        <div key={repo.path} style={systemsCard}>
          <strong>{repo.path}</strong>
          <span>Branch: {repo.publication}</span>
          <span>
            Open PRs:{" "}
            {repo.openPrs.length ? repo.openPrs.join(", ") : "None reported"}
          </span>
          {repo.dirty.length > 0 ? (
            <div>
              Files requiring force removal (including Git-ignored files)
              <ul style={{ margin: 0 }}>
                {repo.dirty.map((file, index) => (
                  <li key={`${index}:${file}`}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <span>No changes or local files reported.</span>
          )}
        </div>
      ))}
      <form
        style={systemsStack}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !unavailable && mode) onConfirm(mode);
        }}
      >
        <fieldset disabled={busy || !!unavailable} style={systemsCard}>
          <legend>Choose what to do</legend>
          {cleanupOptions.map((option) => (
            <label key={option.mode}>
              <input
                type="radio"
                name="cleanup-mode"
                checked={mode === option.mode}
                disabled={option.mode === "remove" && dirty}
                onChange={() => setMode(option.mode)}
              />{" "}
              {option.label}
              <div style={systemsMuted}>{option.detail}</div>
            </label>
          ))}
        </fieldset>
        <span style={systemsMuted}>
          Cleanup keeps branches and PRs and doesn't push changes. Unexpected
          files at the Effort root stay in place.
        </span>
        <div style={systemsRow}>
          <SystemsButton
            type="submit"
            disabled={!mode || busy || !!unavailable}
            style={
              mode === "force" ? { color: "var(--status-error)" } : undefined
            }
          >
            {busy
              ? "Working…"
              : (cleanupOptions.find((option) => option.mode === mode)?.label ??
                "Confirm cleanup")}
          </SystemsButton>
          <SystemsButton disabled={busy} onClick={onCancel}>
            Back
          </SystemsButton>
        </div>
      </form>
    </div>
  );
}

export function EffortDetails({
  host,
  effort,
  action,
  unavailable,
  onClose,
  onOpenWorkspace,
  onNewChat,
  onOpenSession,
  onOpenTerminal,
}: {
  effort: EffortRecord;
  host: string;
  action: SystemsAction;
  unavailable?: string;
  onClose: () => void;
  onOpenWorkspace: (path: string) => void;
  onNewChat: () => void;
  onOpenSession: (session: SessionInfo) => void;
  onOpenTerminal: (id: string) => void;
}) {
  const { busy: systemsBusy, error, run, setError } = useSystemsAction(action);
  const [dismissingOutput, setDismissingOutput] = useState(false);
  const busy = systemsBusy || dismissingOutput;
  const [cleanup, setCleanup] = useState<EffortCleanupPreview>();
  const [rename, setRename] = useState<string>();
  const [retryAcknowledged, setRetryAcknowledged] = useState(false);
  const ready = effort.status === "ready";
  const interrupted = effort.members.some(
    (member) => member.status === "interrupted",
  );
  const disabled = busy || !!unavailable;
  const effortId = effort.id;
  const dismissOutput = async (terminalId: string) => {
    setDismissingOutput(true);
    setError(undefined);
    try {
      await closeTerminal(terminalId, host);
      await run({ action: "list" });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setDismissingOutput(false);
    }
  };
  const review = async () => {
    const result = await run({ action: "cleanupPreview", effortId });
    if (result?.cleanup) setCleanup(result.cleanup);
  };
  return (
    <SystemsDialog
      title={cleanup ? `Clean up ${effort.name}` : effort.name}
      busy={busy}
      onClose={onClose}
    >
      <div style={systemsStack}>
        <SystemsError message={unavailable ?? error} />
        {cleanup ? (
          <CleanupReview
            preview={cleanup}
            busy={busy}
            unavailable={unavailable}
            onConfirm={async (mode) => {
              const confirmation = cleanup.confirmation;
              setCleanup(undefined);
              await run({ action: "cleanup", effortId, mode, confirmation });
            }}
            onCancel={() => {
              setCleanup(undefined);
              setError(undefined);
            }}
          />
        ) : (
          <>
            <div style={systemsStack}>
              <div>
                <strong>{effort.systemName}</strong> ·{" "}
                <span role="status">{effortStatusLabels[effort.status]}</span>
              </div>
              <code>{effort.root}</code>
              <code>{effort.branch}</code>
              <SystemsError message={effort.error} />
              {effort.retainedPaths?.length ? (
                <div style={systemsCard}>
                  <strong>Files left at the Effort root</strong>
                  <ul style={{ margin: 0 }}>
                    {effort.retainedPaths.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            {rename !== undefined ? (
              <form
                style={systemsStack}
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (
                    !disabled &&
                    rename.trim() &&
                    (await run({
                      action: "renameEffort",
                      effortId,
                      name: rename.trim(),
                    }))
                  )
                    setRename(undefined);
                }}
              >
                <label>
                  Effort name{" "}
                  <input
                    style={systemsInput}
                    required
                    value={rename}
                    onChange={(event) => setRename(event.target.value)}
                  />
                </label>
                <span style={systemsMuted}>
                  Renaming doesn't move worktrees or rename the branch.
                </span>
                <div style={systemsRow}>
                  <SystemsButton
                    type="submit"
                    disabled={disabled || !rename.trim()}
                  >
                    Save name
                  </SystemsButton>
                  <SystemsButton
                    disabled={busy}
                    onClick={() => setRename(undefined)}
                  >
                    Cancel rename
                  </SystemsButton>
                </div>
              </form>
            ) : (
              <div style={systemsRow}>
                {ready && (
                  <>
                    <SystemsButton
                      disabled={disabled}
                      onClick={() => onOpenWorkspace(effort.root)}
                    >
                      Open Effort root
                    </SystemsButton>
                    <SystemsButton disabled={disabled} onClick={onNewChat}>
                      New root chat
                    </SystemsButton>
                  </>
                )}
                {effort.status !== "cleaned" &&
                  effort.status !== "cleaning" && (
                    <SystemsButton
                      disabled={disabled}
                      onClick={() => setRename(effort.name)}
                    >
                      Rename Effort
                    </SystemsButton>
                  )}
              </div>
            )}
            <section style={systemsCard} aria-label="Member worktrees">
              <strong>Member worktrees</strong>
              {effort.members.map((member) => (
                <div key={member.repoPath} style={systemsStack}>
                  <div style={systemsRow}>
                    <strong>{member.name}</strong>
                    <span style={systemsMuted}>
                      {member.status}
                      {member.stage ? ` · ${member.stage}` : ""}
                    </span>
                    {ready && member.status === "complete" && (
                      <SystemsButton
                        disabled={disabled}
                        onClick={() => onOpenWorkspace(member.path)}
                      >
                        Open {member.name}
                      </SystemsButton>
                    )}
                  </div>
                  <code>{member.path}</code>
                  <SystemsError message={member.error} />
                </div>
              ))}
            </section>
            {effort.status === "failed" && (
              <section style={systemsCard} aria-label="Retry setup">
                {interrupted && (
                  <label>
                    <input
                      type="checkbox"
                      checked={retryAcknowledged}
                      onChange={(event) =>
                        setRetryAcknowledged(event.target.checked)
                      }
                    />{" "}
                    An interrupted command may have run. I understand that retry
                    can run it again.
                  </label>
                )}
                <SystemsButton
                  disabled={disabled || (interrupted && !retryAcknowledged)}
                  onClick={() => {
                    setRetryAcknowledged(false);
                    void run({ action: "retry", effortId });
                  }}
                >
                  Retry incomplete setup
                </SystemsButton>
              </section>
            )}
            {effort.services.length > 0 && (
              <section style={systemsCard} aria-label="Effort services">
                <strong>Services</strong>
                <span style={systemsMuted}>
                  Running means the process is still active. It doesn't check
                  readiness.
                </span>
                {effort.services.map((service) => (
                  <div key={service.id} style={systemsStack}>
                    <span>
                      <strong>{service.name}</strong> · {service.status}
                    </span>
                    <SystemsError message={service.error} />
                    {ready && (
                      <div style={systemsRow}>
                        <SystemsButton
                          disabled={disabled || service.status === "running"}
                          onClick={() =>
                            void run({
                              action: "service",
                              effortId,
                              serviceId: service.id,
                              operation: "start",
                            })
                          }
                        >
                          Start {service.name}
                        </SystemsButton>
                        <SystemsButton
                          disabled={disabled || service.status !== "running"}
                          onClick={() =>
                            void run({
                              action: "service",
                              effortId,
                              serviceId: service.id,
                              operation: "stop",
                            })
                          }
                        >
                          Stop {service.name}
                        </SystemsButton>
                        <SystemsButton
                          disabled={disabled || service.status === "stopped"}
                          onClick={() =>
                            void run({
                              action: "service",
                              effortId,
                              serviceId: service.id,
                              operation: "restart",
                            })
                          }
                        >
                          Restart {service.name}
                        </SystemsButton>
                        {service.terminalId && (
                          <SystemsButton
                            disabled={disabled}
                            onClick={() => onOpenTerminal(service.terminalId!)}
                          >
                            Open {service.name} terminal
                          </SystemsButton>
                        )}
                      </div>
                    )}
                    {service.status === "exited" && service.terminalId && (
                      <div style={systemsRow}>
                        <SystemsButton
                          disabled={disabled}
                          aria-label={`Dismiss output for ${service.name}`}
                          onClick={dismissOutput.bind(null, service.terminalId)}
                        >
                          Dismiss output
                        </SystemsButton>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}
            {ready && !unavailable && (
              <EffortSavedChats
                host={host}
                effort={effort}
                onSelect={onOpenSession}
              />
            )}
            <div style={systemsRow}>
              {effort.status !== "cleaned" &&
                effort.status !== "cleaning" &&
                effort.status !== "creating" && (
                  <SystemsButton
                    disabled={disabled}
                    onClick={() => void review()}
                  >
                    {effort.status === "cleanup_failed"
                      ? "Preview remaining cleanup"
                      : "Preview cleanup"}
                  </SystemsButton>
                )}
              <SystemsButton disabled={busy} onClick={onClose}>
                Close
              </SystemsButton>
            </div>
          </>
        )}
      </div>
    </SystemsDialog>
  );
}
