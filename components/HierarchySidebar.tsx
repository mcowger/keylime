"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Bot, Loader2, Plus, Wrench } from "lucide-react";
import type {
  HierarchyProject,
  HierarchySnapshot,
  HierarchyRequest,
} from "@/lib/project-hierarchy-types";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import { WorktreesPanel } from "./WorktreesPanel";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";

type Host = { id: string; label: string };
type Props = {
  hosts: Host[];
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  selectedCwd: string | null;
  selectedHostId: string;
  refreshKey?: number;
  onSelectWorkspace: (path: string, host: string) => void;
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
  const [snapshots, setSnapshots] = useState<Record<string, HierarchySnapshot>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [managedProject, setManagedProject] = useState<{
    host: string;
    project: HierarchyProject;
  } | null>(null);
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
  const confirmForget = (what: string) =>
    window.confirm(
      `Unregister ${what}? Files and processes will not be deleted.`,
    );
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
    <div style={{ fontSize: 12, color: "var(--text)" }}>
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
              const defaultWorkspace = project.workspaces.find((workspace) => workspace.isDefault);
              const unavailableReason = hostUnavailableReason?.(host.id) ?? null;
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
                      title={unavailableReason ?? `New ${project.kind === "git" ? "workspace" : "session"}`}
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
                        ⋯
                      </summary>
                      <div
                        style={{
                          position: "absolute",
                          right: 0,
                          zIndex: 10,
                          minWidth: 150,
                          padding: 4,
                          background: "var(--bg-panel)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-control)",
                        }}
                      >
                        {project.kind === "git" && (
                          <button
                            style={{
                              ...button,
                              display: "block",
                              width: "100%",
                            }}
                            type="button"
                            onClick={(e) => {
                              e.currentTarget
                                .closest("details")
                                ?.removeAttribute("open");
                              setManagedProject({ host: host.id, project });
                            }}
                          >
                            Manage workspaces
                          </button>
                        )}
                        {project.kind === "git" && (
                          <button
                            style={{
                              ...button,
                              display: "block",
                              width: "100%",
                            }}
                            type="button"
                            disabled={busy}
                            onClick={(e) => {
                              e.currentTarget
                                .closest("details")
                                ?.removeAttribute("open");
                              void discover(host.id, project);
                            }}
                          >
                            Import workspaces
                          </button>
                        )}
                        <button
                          style={{ ...button, display: "block", width: "100%" }}
                          type="button"
                          disabled={busy}
                          onClick={(e) => {
                            e.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                            if (
                              confirmForget(
                                "this project and its registrations",
                              )
                            )
                              void operate(host.id, {
                                action: "unregisterProject",
                                projectId: project.id,
                              });
                          }}
                        >
                          Unregister project
                        </button>
                      </div>
                    </details>
                  </div>
                  {workspaces.map((workspace) => {
                    const runningCount = workspace.sessionIds.filter((id) =>
                      runningSessionIds.has(id),
                    ).length;
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
                            padding: "4px 0",
                          }}
                        >
                          <button
                            style={{
                              ...rowButton,
                              background:
                                selectedHostId === host.id &&
                                selectedCwd === workspace.path
                                  ? "var(--bg-selected)"
                                  : "transparent",
                            }}
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
                            {workspace.branch &&
                            workspace.branch !== workspace.name
                              ? ` (${workspace.branch})`
                              : ""}
                            {workspace.unavailable ? " (unavailable)" : ""}
                          </button>
                          {runningCount > 0 && (
                            <span
                              title={`${runningCount} running agents`}
                              aria-label={`${runningCount} running agents`}
                              style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
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
                                title={workspace.setup.error || `Setup ${workspace.setup.status}`}
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
                              ⋯
                            </summary>
                            <div
                              style={{
                                position: "absolute",
                                right: 0,
                                zIndex: 10,
                                minWidth: 150,
                                padding: 4,
                                background: "var(--bg-panel)",
                                border: "1px solid var(--border)",
                                borderRadius: "var(--radius-control)",
                              }}
                            >
                              <button
                                style={{
                                  ...button,
                                  display: "block",
                                  width: "100%",
                                }}
                                type="button"
                                disabled={busy || workspace.unavailable}
                                onClick={(e) => {
                                  e.currentTarget
                                    .closest("details")
                                    ?.removeAttribute("open");
                                  void discover(host.id, project, workspace.id);
                                }}
                              >
                                Import sessions
                              </button>
                              {!workspace.isDefault && (
                                <button
                                  style={{
                                    ...button,
                                    display: "block",
                                    width: "100%",
                                  }}
                                  type="button"
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.currentTarget
                                      .closest("details")
                                      ?.removeAttribute("open");
                                    if (
                                      confirmForget(
                                        "this workspace and its sessions",
                                      )
                                    )
                                      void operate(host.id, {
                                        action: "unregisterWorkspace",
                                        workspaceId: workspace.id,
                                      });
                                  }}
                                >
                                  Unregister workspace
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
                                      ⋯
                                    </summary>
                                    <button
                                      style={{
                                        ...button,
                                        position: "absolute",
                                        right: 0,
                                        zIndex: 10,
                                        whiteSpace: "nowrap",
                                      }}
                                      type="button"
                                      disabled={busy}
                                      onClick={(e) => {
                                        e.currentTarget
                                          .closest("details")
                                          ?.removeAttribute("open");
                                        if (confirmForget("this session"))
                                          void operate(host.id, {
                                            action: "unregisterSession",
                                            workspaceId: workspace.id,
                                            sessionId: id,
                                          });
                                      }}
                                    >
                                      Unregister session
                                    </button>
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
