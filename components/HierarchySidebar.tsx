"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  HierarchyProject,
  HierarchySnapshot,
  HierarchyRequest,
} from "@/lib/project-hierarchy-types";
import type { ManagedProject, SessionInfo } from "@/lib/types";

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
  collapsedHosts: Set<string>;
  onToggleHost: (host: string) => void;
  onSelectSession: (session: SessionInfo) => void;
  onAddProject: (host: string) => void;
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
  onProjects,
  onSnapshots,
  onChanged,
  searchQuery,
  matchedSessionIds,
  runningOnly,
  collapsedHosts,
  onToggleHost,
}: Props) {
  const [snapshots, setSnapshots] = useState<Record<string, HierarchySnapshot>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
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
                    workspace.sessionIds.some((id) =>
                      matchedSessionIds?.has(id),
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
              return (
                <details key={project.id} open style={{ marginBottom: 4 }}>
                  <summary
                    title={project.path}
                    style={{
                      padding: "5px 4px",
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    {project.alias || project.name}{" "}
                    <button
                      style={button}
                      type="button"
                      disabled={busy}
                      onClick={(e) => {
                        e.preventDefault();
                        if (confirmForget("this project and its registrations"))
                          void operate(host.id, {
                            action: "unregisterProject",
                            projectId: project.id,
                          });
                      }}
                    >
                      Unregister
                    </button>{" "}
                    {project.kind === "git" && (
                      <button
                        style={button}
                        type="button"
                        disabled={busy}
                        onClick={(e) => {
                          e.preventDefault();
                          void discover(host.id, project);
                        }}
                      >
                        Import workspaces
                      </button>
                    )}
                  </summary>
                  {workspaces.map((workspace) => (
                    <details key={workspace.id} open style={{ marginLeft: 12 }}>
                      <summary style={{ padding: "4px 0", cursor: "pointer" }}>
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
                          onClick={(e) => {
                            e.preventDefault();
                            onSelectWorkspace(workspace.path, host.id);
                          }}
                        >
                          {workspace.name}
                          {workspace.branch &&
                          workspace.branch !== workspace.name
                            ? ` (${workspace.branch})`
                            : ""}
                          {workspace.unavailable ? " (unavailable)" : ""}
                        </button>{" "}
                        {workspace.setup &&
                          workspace.setup.status !== "complete" && (
                            <span title={workspace.setup.error}>
                              Setup {workspace.setup.status}
                            </span>
                          )}{" "}
                        <button
                          style={button}
                          type="button"
                          disabled={busy || workspace.unavailable}
                          onClick={(e) => {
                            e.preventDefault();
                            void discover(host.id, project, workspace.id);
                          }}
                        >
                          Import sessions
                        </button>{" "}
                        {!workspace.isDefault && (
                          <button
                            style={button}
                            type="button"
                            disabled={busy}
                            onClick={(e) => {
                              e.preventDefault();
                              if (
                                confirmForget("this workspace and its sessions")
                              )
                                void operate(host.id, {
                                  action: "unregisterWorkspace",
                                  workspaceId: workspace.id,
                                });
                            }}
                          >
                            Unregister
                          </button>
                        )}
                      </summary>
                      {workspace.sessionIds
                        .filter(
                          (id) =>
                            (!runningOnly || matchedSessionIds?.has(id)) &&
                            (!query ||
                              projectMatch ||
                              `${workspace.name} ${workspace.path} ${workspace.branch ?? ""}`
                                .toLowerCase()
                                .includes(query) ||
                              matchedSessionIds?.has(id)),
                        )
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
                                gap: 6,
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
                                disabled={!session}
                                aria-current={
                                  selectedSessionId === id ? "true" : undefined
                                }
                                onClick={() => {
                                  if (session) {
                                    onSelectWorkspace(workspace.path, host.id);
                                    onSelectSession(session);
                                  }
                                }}
                              >
                                {session?.name || session?.firstMessage || id}
                                {!session && " (unavailable)"}
                              </button>
                              <button
                                style={button}
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  if (confirmForget("this session"))
                                    void operate(host.id, {
                                      action: "unregisterSession",
                                      workspaceId: workspace.id,
                                      sessionId: id,
                                    });
                                }}
                              >
                                Unregister
                              </button>
                            </div>
                          );
                        })}
                    </details>
                  ))}
                </details>
              );
            })}
        </section>
      ))}
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
