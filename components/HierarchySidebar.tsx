"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  FolderCog,
  FolderInput,
  Loader2,
  MoreHorizontal,
  Plus,
  Trash2,
  Wrench,
} from "lucide-react";
import type {
  HierarchyProject,
  HierarchySnapshot,
  HierarchyRequest,
} from "@/lib/project-hierarchy-types";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import type { WorkspaceDeleteResult } from "@/lib/workspace-creation-types";
import { WorktreesPanel } from "./WorktreesPanel";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { ShipDialog } from "./ShipDialog";
import { ConfirmDialog } from "./ui/field";
import { toast } from "./ui/toast";

type Host = { id: string; label: string };
type Props = {
  hosts: Host[];
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  selectedCwd: string | null;
  selectedHostId: string;
  refreshKey?: number;
  onSelectWorkspace: (path: string, host: string) => void;
  onWorkspaceRemoved: (path: string, host: string) => void;
  onProjects: (projects: ManagedProject[]) => void;
  onSnapshots: (snapshots: Record<string, HierarchySnapshot>) => void;
  searchQuery: string;
  matchedSessionIds: Set<string> | null;
  runningOnly: boolean;
  runningSessionIds: Set<string>;
  awaitingInputIds: Set<string>;
  unreadSessionIds: Set<string>;
  exitedSessionIds: Iterable<string>;
  collapsedHosts: Set<string>;
  onToggleHost: (host: string) => void;
  onSelectSession: (session: SessionInfo) => void;
  onAddProject: (host: string) => void;
  onNewWorkspace: (project: ManagedProject) => void;
  hostUnavailableReason?: (hostId: string) => string | null;
  onChanged: () => void;
};

type Discovery = {
  host: string;
  projectId: string;
  workspaceId?: string;
  snapshot: HierarchySnapshot;
};

export function HierarchySidebar({
  hosts,
  sessions,
  selectedSessionId,
  selectedCwd,
  selectedHostId,
  refreshKey,
  onSelectWorkspace,
  onWorkspaceRemoved,
  onSelectSession,
  onAddProject,
  onNewWorkspace,
  hostUnavailableReason,
  onProjects,
  onSnapshots,
  onChanged,
  searchQuery,
  matchedSessionIds,
  runningOnly,
  runningSessionIds,
  awaitingInputIds,
  unreadSessionIds,
  exitedSessionIds,
  collapsedHosts,
  onToggleHost,
}: Props) {
  const sidebarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismissMenus = (event: PointerEvent) => {
      sidebarRef.current
        ?.querySelectorAll<HTMLDetailsElement>("details[open]")
        .forEach((menu) => {
          if (event.target instanceof Node && !menu.contains(event.target))
            menu.open = false;
        });
    };
    document.addEventListener("pointerdown", dismissMenus);
    return () => document.removeEventListener("pointerdown", dismissMenus);
  }, []);
  const [snapshots, setSnapshots] = useState<Record<string, HierarchySnapshot>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [managedProject, setManagedProject] = useState<{
    host: string;
    project: HierarchyProject;
  } | null>(null);
  const [shipTarget, setShipTarget] = useState<{
    host: string;
    projectPath: string;
    path: string;
    sessionId: string;
  } | null>(null);
  const [finishTarget, setFinishTarget] = useState<{
    host: string;
    projectPath: string;
    path: string;
  } | null>(null);
  const finishAbort = useRef<AbortController | null>(null);
  useEffect(() => () => finishAbort.current?.abort(), []);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const confirmationRef = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(() => () => confirmationRef.current?.(false), []);
  const confirmAction = (title: string, description: string, confirmLabel: string) =>
    new Promise<boolean>((resolve) => {
      if (confirmationRef.current) return resolve(false);
      confirmationRef.current = resolve;
      setConfirmation({ title, description, confirmLabel, resolve });
    });
  const finishConfirmation = (confirmed: boolean) => {
    if (!confirmation) return;
    confirmationRef.current = null;
    setConfirmation(null);
    confirmation.resolve(confirmed);
  };
  const [branchChoice, setBranchChoice] = useState<{
    branch: string | undefined;
    resolve: (choice: boolean | null) => void;
  } | null>(null);
  const branchChoiceRef = useRef<((choice: boolean | null) => void) | null>(null);
  useEffect(() => () => branchChoiceRef.current?.(null), []);
  const chooseBranch = (branch: string | undefined) =>
    new Promise<boolean | null>((resolve) => {
      branchChoiceRef.current = resolve;
      setBranchChoice({ branch, resolve });
    });
  const finishBranchChoice = (choice: boolean | null) => {
    if (!branchChoice) return;
    branchChoiceRef.current = null;
    setBranchChoice(null);
    branchChoice.resolve(choice);
  };
  const finishShip = async () => {
    if (!finishTarget) return;
    const abort = new AbortController();
    finishAbort.current = abort;
    try {
      const response = await fetch("/api/ship/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finishTarget),
        signal: abort.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Cleanup failed");
      setFinishTarget(null);
      onChanged();
    } catch (error) {
      if (!abort.signal.aborted)
        toast.error(
          "Cleanup failed",
          error instanceof Error ? error.message : String(error),
        );
    }
  };
  useEffect(() => {
    onProjects(
      Object.entries(snapshots).flatMap(([hostId, snapshot]) =>
        snapshot.projects.flatMap((project) =>
          project.workspaces.map((workspace) => ({
            path: workspace.path,
            hostId,
            name: workspace.name,
            projectId: project.id,
            workspaceId: workspace.id,
            projectPath: project.path,
            projectName: project.alias ?? project.name,
            projectKind: project.kind,
            isDefaultWorkspace: workspace.isDefault,
            addedAt: project.addedAt,
            launchConfig: project.launchConfig,
          })),
        ),
      ),
    );
  }, [snapshots, onProjects]);
  useEffect(() => {
    onSnapshots(snapshots);
  }, [snapshots, onSnapshots]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    await Promise.all(
      hosts.map(async (host) => {
        try {
          const response = await fetch(
            `/api/hierarchy?${new URLSearchParams({ host: host.id })}`,
          );
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error ?? `HTTP ${response.status}`);
          setSnapshots((prev) => ({ ...prev, [host.id]: data }));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }),
    );
  }, [hosts]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    const refresh = () => {
      void load();
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);
  const operate = async (host: string, input: HierarchyRequest) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/hierarchy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, input }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      setSnapshots((prev) => ({ ...prev, [host]: data }));
      if (
        input.action !== "discoverWorkspaces" &&
        input.action !== "discoverSessions"
      )
        onChanged();
      return data as HierarchySnapshot;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const discover = async (
    host: string,
    project: HierarchyProject,
    workspaceId?: string,
  ) => {
    const result = await operate(
      host,
      workspaceId
        ? { action: "discoverSessions", workspaceId }
        : { action: "discoverWorkspaces", projectId: project.id },
    );
    if (result) {
      setChecked(new Set());
      setDiscovery({
        host,
        projectId: project.id,
        workspaceId,
        snapshot: result,
      });
    }
  };
  const unregisterWorkspace = async (
    hostId: string,
    projectPath: string,
    path: string,
  ) => {
    if (!(await confirmAction(
      "Delete workspace?",
      "Unregister this workspace and remove its checkout? Running processes and uncommitted changes require separate approval. Session history is kept.",
      "Delete workspace",
    ))) return;
    setBusy(true);
    setError(null);
    let stopProcesses = false;
    let discardChanges = false;
    let keepBranch: boolean | undefined;
    let cancel = false;
    try {
      while (true) {
        const response = await fetch("/api/worktrees", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hostId,
            action: "delete",
            input: {
              projectPath,
              path,
              stopProcesses,
              discardChanges,
              keepBranch,
              cancel,
            },
          }),
        });
        const result: WorkspaceDeleteResult & { error?: string } =
          await response.json();
        if (!response.ok)
          throw new Error(result.error ?? `HTTP ${response.status}`);
        if (result.status === "processes") {
          const processes =
            result.processes
              ?.map((p) => {
                const session = sessions.find(
                  (s) => s.id === p.id && (s.hostId ?? "local") === hostId,
                );
                const title =
                  session?.name?.trim() || session?.firstMessage?.trim();
                return title
                  ? `Session: ${title.slice(0, 120)}\n  Working directory: ${p.cwd}`
                  : `Unidentified session or terminal (ID: ${p.id})\n  Working directory: ${p.cwd}`;
              })
              .join("\n\n") ?? "";
          stopProcesses = await confirmAction(
            "Stop running processes?",
            `Deleting this workspace will stop these sessions or terminals:\n\n${processes}\n\nStop them and continue?`,
            "Stop and continue",
          );
          cancel = !stopProcesses;
        } else if (result.status === "dirty") {
          discardChanges = await confirmAction(
            "Discard uncommitted changes?",
            "Previously stopped sessions remain stopped if you cancel.",
            "Discard and continue",
          );
          cancel = !discardChanges;
        } else if (result.status === "branch") {
          const choice = await chooseBranch(result.branch);
          if (choice === null) cancel = true;
          else keepBranch = choice;
        } else {
          await load();
          if (result.status === "deleted") {
            onWorkspaceRemoved(path, hostId);
            onChanged();
          }
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const confirmForget = (what: string) =>
    confirmAction("Unregister?", `Unregister ${what}? Files and processes will not be deleted.`, "Unregister");
  const exitedIds = new Set(exitedSessionIds);
  const query = searchQuery.trim().toLowerCase();
  const button = {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    padding: "3px 6px",
    cursor: "pointer",
    fontSize: 11,
  } as const;
  const menu = {
    position: "absolute",
    right: 0,
    zIndex: 10,
    display: "flex",
    gap: 4,
    padding: 4,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    boxShadow: "var(--shadow-pop)",
  } as const;
  const menuButton = {
    ...button,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 6,
  } as const;
  const rowButton = {
    ...button,
    border: "none",
    background: "transparent",
    color: "var(--text)",
    textAlign: "left",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: 1,
  } as const;
  return (
    <div ref={sidebarRef} style={{ fontSize: 12, color: "var(--text)" }}>
      {shipTarget && (
        <ShipDialog
          open
          onOpenChange={(open) => {
            if (!open) setShipTarget(null);
          }}
          {...shipTarget}
          onRemoved={() => {
            onSelectWorkspace(shipTarget.projectPath, shipTarget.host);
            onChanged();
          }}
        />
      )}
      <ConfirmDialog
        open={finishTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFinishTarget(null);
        }}
        title="Clean up merged workspace?"
        description="Archive its sessions and delete the workspace and branch."
        confirmLabel="Clean up"
        cancelLabel="Cancel"
        onConfirm={() => void finishShip()}
      />
      {error && (
        <div role="alert" style={{ color: "var(--status-error)", padding: 8 }}>
          {error}
        </div>
      )}
      {hosts.map((host) => (
        <section key={host.id} style={{ marginBottom: 8 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 4px",
              color: "var(--text-muted)",
            }}
          >
            <button
              style={{
                ...rowButton,
                color: "var(--text-muted)",
                fontWeight: 600,
              }}
              type="button"
              aria-expanded={!collapsedHosts.has(host.id)}
              onClick={() => onToggleHost(host.id)}
            >
              {collapsedHosts.has(host.id) ? "▸" : "▾"}{" "}
              {host.label || "This machine"}
            </button>
            <button
              style={button}
              type="button"
              onClick={() => onAddProject(host.id)}
            >
              Add project
            </button>
          </div>
          {!collapsedHosts.has(host.id) &&
            (snapshots[host.id]?.projects ?? []).map((project) => {
              const projectMatch =
                !!query &&
                `${project.alias ?? ""} ${project.name} ${project.path}`
                  .toLowerCase()
                  .includes(query);
              const workspaces = project.workspaces.filter(
                (workspace) =>
                  (!runningOnly ||
                    (selectedHostId === host.id &&
                      selectedCwd === workspace.path) ||
                    workspace.sessionIds.some((id) =>
                      runningSessionIds.has(id),
                    )) &&
                  (!query ||
                    projectMatch ||
                    `${workspace.name} ${workspace.path} ${workspace.branch ?? ""}`
                      .toLowerCase()
                      .includes(query) ||
                    workspace.sessionIds.some((id) =>
                      matchedSessionIds?.has(id),
                    )),
              );
              if (!workspaces.length) return null;
              const defaultWorkspace = project.workspaces.find(
                (workspace) => workspace.isDefault,
              );
              const unavailableReason =
                hostUnavailableReason?.(host.id) ?? null;
              return (
                <div key={project.id} style={{ marginBottom: 4 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "5px 4px",
                      fontWeight: 600,
                    }}
                  >
                    <span
                      title={project.path}
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {project.alias || project.name}
                    </span>
                    <button
                      type="button"
                      aria-label={`New ${project.kind === "git" ? "workspace" : "session"} in ${project.alias || project.name}`}
                      title={
                        unavailableReason ??
                        `New ${project.kind === "git" ? "workspace" : "session"}`
                      }
                      disabled={!defaultWorkspace || unavailableReason !== null}
                      style={{ ...button, padding: "3px 6px" }}
                      onClick={() => {
                        if (!defaultWorkspace) return;
                        onNewWorkspace({
                          path: defaultWorkspace.path,
                          hostId: host.id,
                          name: defaultWorkspace.name,
                          projectId: project.id,
                          workspaceId: defaultWorkspace.id,
                          projectPath: project.path,
                          projectName: project.alias ?? project.name,
                          projectKind: project.kind,
                          isDefaultWorkspace: defaultWorkspace.isDefault,
                          addedAt: project.addedAt,
                          launchConfig: project.launchConfig,
                        });
                      }}
                    >
                      <Plus size={14} />
                    </button>
                    <details style={{ position: "relative" }}>
                      <summary
                        aria-label={`Actions for project ${project.alias || project.name}`}
                        style={{
                          cursor: "pointer",
                          listStyle: "none",
                          padding: "3px 6px",
                        }}
                      >
                        <MoreHorizontal size={16} aria-hidden="true" />
                      </summary>
                      <div style={menu}>
                        {project.kind === "git" && (
                          <button
                            style={menuButton}
                            type="button"
                            aria-label="Manage workspaces"
                            title="Manage workspaces"
                            onClick={(e) => {
                              e.currentTarget
                                .closest("details")
                                ?.removeAttribute("open");
                              setManagedProject({ host: host.id, project });
                            }}
                          >
                            <FolderCog size={16} aria-hidden="true" />
                          </button>
                        )}
                        {project.kind === "git" && (
                          <button
                            style={menuButton}
                            type="button"
                            aria-label="Import workspaces"
                            title="Import workspaces"
                            disabled={busy}
                            onClick={(e) => {
                              e.currentTarget
                                .closest("details")
                                ?.removeAttribute("open");
                              void discover(host.id, project);
                            }}
                          >
                            <FolderInput size={16} aria-hidden="true" />
                          </button>
                        )}
                        <button
                          style={menuButton}
                          type="button"
                          aria-label="Unregister project"
                          title="Unregister project"
                          disabled={busy}
                          onClick={(e) => {
                            e.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                            void confirmForget("this project and its registrations").then((confirmed) => {
                              if (confirmed) void operate(host.id, {
                                action: "unregisterProject",
                                projectId: project.id,
                              });
                            });
                          }}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </details>
                  </div>
                  {workspaces.map((workspace) => {
                    const runningCount = workspace.sessionIds.filter((id) =>
                      runningSessionIds.has(id),
                    ).length;
                    const latestSession = sessions
                      .filter(
                        (item) =>
                          workspace.sessionIds.includes(item.id) &&
                          (item.hostId ?? "local") === host.id,
                      )
                      .sort((a, b) =>
                        (b.lastMessageAt ?? b.modified).localeCompare(
                          a.lastMessageAt ?? a.modified,
                        ),
                      )[0];
                    const needsAttention = workspace.sessionIds.some(
                      (id) =>
                        awaitingInputIds.has(id) ||
                        unreadSessionIds.has(id) ||
                        exitedIds.has(id),
                    );
                    return (
                      <div key={workspace.id} style={{ marginLeft: 12 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "4px 6px",
                            borderRadius: "var(--radius-control)",
                            background:
                              selectedHostId === host.id &&
                              selectedCwd === workspace.path
                                ? "var(--bg-selected)"
                                : "transparent",
                          }}
                        >
                          <button
                            style={rowButton}
                            type="button"
                            title={workspace.path}
                            disabled={workspace.unavailable}
                            aria-pressed={
                              selectedHostId === host.id &&
                              selectedCwd === workspace.path
                            }
                            onClick={() =>
                              onSelectWorkspace(workspace.path, host.id)
                            }
                          >
                            {workspace.name}
                            {workspace.unavailable ? " (unavailable)" : ""}
                          </button>
                          {workspace.ship?.job?.status === "running" ? (
                            <span
                              title="Shipping"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 3,
                                fontSize: 11,
                                flexShrink: 0,
                              }}
                            >
                              <Loader2 size={12} className="animate-spin" />{" "}
                              Shipping...
                            </span>
                          ) : workspace.ship?.pr?.state === "open" ? (
                            <a
                              href={workspace.ship.pr.url}
                              target="_blank"
                              rel="noreferrer"
                              title={`Checks: ${workspace.ship.pr.checks}`}
                              style={{
                                fontSize: 11,
                                whiteSpace: "nowrap",
                                color: "var(--text)",
                              }}
                            >
                              <span
                                style={{
                                  color:
                                    workspace.ship.pr.checks === "passing"
                                      ? "var(--status-success)"
                                      : workspace.ship.pr.checks === "failing"
                                        ? "var(--status-error)"
                                        : "var(--status-warning)",
                                }}
                              >
                                ●
                              </span>{" "}
                              PR #{workspace.ship.pr.number}
                            </a>
                          ) : workspace.ship?.pr?.state === "merged" ? (
                            <span
                              style={{ fontSize: 11, whiteSpace: "nowrap" }}
                            >
                              Merged{" "}
                              <button
                                type="button"
                                onClick={() =>
                                  setFinishTarget({
                                    host: host.id,
                                    projectPath: project.path,
                                    path: workspace.path,
                                  })
                                }
                              >
                                Clean up
                              </button>
                            </span>
                          ) : workspace.ship?.pr?.state === "closed" ? (
                            <span
                              style={{ fontSize: 11, whiteSpace: "nowrap" }}
                            >
                              PR closed
                            </span>
                          ) : null}
                          {runningCount > 0 && (
                            <span
                              title={`${runningCount} running agents`}
                              aria-label={`${runningCount} running agents`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 3,
                                flexShrink: 0,
                              }}
                            >
                              <Bot size={14} aria-hidden="true" />
                              {runningCount}
                            </span>
                          )}
                          {needsAttention && (
                            <span
                              title="Attention required"
                              aria-label="Attention required"
                              style={{
                                color: "var(--status-warning)",
                                padding: "0 4px",
                              }}
                            >
                              <AlertCircle size={14} aria-hidden="true" />
                            </span>
                          )}
                          {workspace.setup &&
                            workspace.setup.status !== "complete" && (
                              <span
                                title={
                                  workspace.setup.error ||
                                  `Setup ${workspace.setup.status}`
                                }
                                aria-label={`Setup ${workspace.setup.status}`}
                              >
                                {workspace.setup.status === "running" ? (
                                  <Loader2 size={14} aria-hidden="true" />
                                ) : (
                                  <Wrench size={14} aria-hidden="true" />
                                )}
                              </span>
                            )}
                          <details style={{ position: "relative" }}>
                            <summary
                              aria-label={`Actions for workspace ${workspace.name}`}
                              style={{
                                cursor: "pointer",
                                listStyle: "none",
                                padding: "3px 6px",
                              }}
                            >
                              <MoreHorizontal size={16} aria-hidden="true" />
                            </summary>
                            <div style={menu}>
                              {!workspace.isDefault &&
                                project.kind === "git" && (
                                  <button
                                    style={menuButton}
                                    type="button"
                                    disabled={
                                      workspace.unavailable ||
                                      !latestSession ||
                                      runningSessionIds.has(latestSession.id)
                                    }
                                    title={
                                      latestSession &&
                                      runningSessionIds.has(latestSession.id)
                                        ? "Wait for the session to finish"
                                        : "Ship workspace"
                                    }
                                    onClick={(e) => {
                                      e.currentTarget
                                        .closest("details")
                                        ?.removeAttribute("open");
                                      if (latestSession)
                                        setShipTarget({
                                          host: host.id,
                                          projectPath: project.path,
                                          path: workspace.path,
                                          sessionId: latestSession.id,
                                        });
                                    }}
                                  >
                                    Ship...
                                  </button>
                                )}
                              <button
                                style={menuButton}
                                type="button"
                                aria-label="Import sessions"
                                title="Import sessions"
                                disabled={busy || workspace.unavailable}
                                onClick={(e) => {
                                  e.currentTarget
                                    .closest("details")
                                    ?.removeAttribute("open");
                                  void discover(host.id, project, workspace.id);
                                }}
                              >
                                <FolderInput size={16} aria-hidden="true" />
                              </button>
                              {!workspace.isDefault && (
                                <button
                                  style={menuButton}
                                  type="button"
                                  aria-label="Unregister workspace"
                                  title="Unregister workspace"
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.currentTarget
                                      .closest("details")
                                      ?.removeAttribute("open");
                                    void unregisterWorkspace(
                                      host.id,
                                      project.path,
                                      workspace.path,
                                    );
                                  }}
                                >
                                  <Trash2 size={16} aria-hidden="true" />
                                </button>
                              )}
                            </div>
                          </details>
                        </div>
                        {query &&
                          workspace.sessionIds
                            .filter((id) => matchedSessionIds?.has(id))
                            .map((id) => {
                              const session = sessions.find(
                                (item) =>
                                  item.id === id &&
                                  (item.hostId ?? "local") === host.id,
                              );
                              return (
                                <div
                                  key={id}
                                  style={{
                                    marginLeft: 18,
                                    display: "flex",
                                    alignItems: "center",
                                    background:
                                      selectedSessionId === id
                                        ? "var(--bg-selected)"
                                        : undefined,
                                  }}
                                >
                                  <button
                                    style={rowButton}
                                    type="button"
                                    disabled={!session || workspace.unavailable}
                                    aria-current={
                                      selectedSessionId === id
                                        ? "true"
                                        : undefined
                                    }
                                    onClick={() => {
                                      if (session) {
                                        onSelectWorkspace(
                                          workspace.path,
                                          host.id,
                                        );
                                        onSelectSession(session);
                                      }
                                    }}
                                  >
                                    {session?.name ||
                                      session?.firstMessage ||
                                      id}
                                  </button>
                                  <details style={{ position: "relative" }}>
                                    <summary
                                      aria-label={`Actions for session ${session?.name || session?.firstMessage || id}`}
                                      style={{
                                        cursor: "pointer",
                                        listStyle: "none",
                                        padding: "3px 6px",
                                      }}
                                    >
                                      <MoreHorizontal
                                        size={16}
                                        aria-hidden="true"
                                      />
                                    </summary>
                                    <div style={menu}>
                                      <button
                                        style={menuButton}
                                        type="button"
                                        aria-label="Unregister session"
                                        title="Unregister session"
                                        disabled={busy}
                                        onClick={(e) => {
                                          e.currentTarget
                                            .closest("details")
                                            ?.removeAttribute("open");
                                          void confirmForget("this session").then((confirmed) => {
                                            if (confirmed) void operate(host.id, {
                                              action: "unregisterSession",
                                              workspaceId: workspace.id,
                                              sessionId: id,
                                            });
                                          });
                                        }}
                                      >
                                        <Trash2 size={16} aria-hidden="true" />
                                      </button>
                                    </div>
                                  </details>
                                </div>
                              );
                            })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
        </section>
      ))}
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => { if (!open) finishConfirmation(false); }}
        title={confirmation?.title ?? ""}
        description={confirmation?.description}
        confirmLabel={confirmation?.confirmLabel ?? "Confirm"}
        danger
        onConfirm={() => finishConfirmation(true)}
      />
      <Dialog open={branchChoice !== null} onOpenChange={(open) => {
        if (!open) finishBranchChoice(null);
      }}>
        <DialogContent style={{ width: 420, maxWidth: "min(92vw, 420px)", padding: 22 }}>
          <DialogTitle>Keep or delete branch?</DialogTitle>
          <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.55 }}>
            Branch {branchChoice?.branch ?? "for this workspace"} is not confirmed merged.
            Choose whether to keep it or delete it along with the workspace.
          </p>
          <div className="dialog-actions" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="dialog-action" style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }} onClick={() => finishBranchChoice(null)}>Cancel</button>
            <button type="button" className="dialog-action" style={{ padding: "6px 14px", background: "var(--accent-strong)", border: "none", borderRadius: "var(--radius-control)", color: "var(--on-accent)", cursor: "pointer", fontSize: 13, fontWeight: 600 }} onClick={() => finishBranchChoice(true)}>Keep branch</button>
            <button type="button" className="dialog-action" style={{ padding: "6px 14px", background: "var(--status-error)", border: "none", borderRadius: "var(--radius-control)", color: "var(--on-accent)", cursor: "pointer", fontSize: 13, fontWeight: 600 }} onClick={() => finishBranchChoice(false)}>Delete branch</button>
          </div>
        </DialogContent>
      </Dialog>
      {managedProject && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setManagedProject(null);
          }}
        >
          <DialogContent>
            <DialogTitle>Manage workspaces</DialogTitle>
            <WorktreesPanel
              ctx={{
                hostId: managedProject.host,
                projectRoot: managedProject.project.path,
                currentPath: selectedCwd ?? "",
                worktrees: [],
                select: (path) => {
                  onSelectWorkspace(path, managedProject.host);
                  setManagedProject(null);
                },
                refresh: () => {
                  void load();
                  onChanged();
                },
              }}
            />
          </DialogContent>
        </Dialog>
      )}
      {discovery && (
        <div
          role="dialog"
          aria-label={
            discovery.workspaceId ? "Import sessions" : "Import workspaces"
          }
          style={{
            padding: 10,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
          }}
        >
          <strong>
            {discovery.workspaceId ? "Import sessions" : "Import workspaces"}
          </strong>
          {(discovery.workspaceId
            ? (discovery.snapshot.sessionCandidates ?? []).map((s) => ({
                id: s.id,
                label: s.name || s.firstMessage || s.id,
              }))
            : (discovery.snapshot.workspaceCandidates ?? []).map((w) => ({
                id: w.path,
                label: w.branch ? `${w.name} (${w.branch})` : w.path,
              }))
          ).map((candidate) => (
            <label
              key={candidate.id}
              style={{ display: "block", padding: "4px 0" }}
            >
              <input
                type="checkbox"
                checked={checked.has(candidate.id)}
                onChange={(e) =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(candidate.id);
                    else next.delete(candidate.id);
                    return next;
                  })
                }
              />{" "}
              {candidate.label}
            </label>
          ))}
          <button
            style={button}
            type="button"
            disabled={busy || checked.size === 0}
            onClick={async () => {
              const result = await operate(
                discovery.host,
                discovery.workspaceId
                  ? {
                      action: "importSessions",
                      workspaceId: discovery.workspaceId,
                      sessionIds: [...checked],
                    }
                  : {
                      action: "importWorkspaces",
                      projectId: discovery.projectId,
                      paths: [...checked],
                    },
              );
              if (result) setDiscovery(null);
            }}
          >
            Import selected
          </button>{" "}
          <button
            style={button}
            type="button"
            onClick={() => setDiscovery(null)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
