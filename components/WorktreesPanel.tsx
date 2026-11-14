"use client";

import { useEffect, useState } from "react";
import type { WorktreeContext } from "./SessionSidebar-helpers";
import type {
  WorkspaceBranches,
  WorkspaceBranchMode,
  WorkspaceCreationJob,
  WorkspaceDeleteResult,
} from "@/lib/workspace-creation-types";
import type { HierarchySnapshot } from "@/lib/project-hierarchy-types";
import { ConfirmDialog } from "./ui/field";

export function WorktreesPanel({ ctx }: { ctx: WorktreeContext | null }) {
  const [branches, setBranches] = useState<WorkspaceBranches>({
    local: [],
    remote: [],
    defaultRef: "",
  });
  const [mode, setMode] = useState<WorkspaceBranchMode>("new");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [name, setName] = useState("");
  const [job, setJob] = useState<WorkspaceCreationJob | null>(null);
  const [snapshot, setSnapshot] = useState<HierarchySnapshot | null>(null);
  const [pending, setPending] = useState<{
    path: string;
    status: "processes" | "dirty";
    processes?: Array<{ id: string; cwd: string }>;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const hostId = ctx?.hostId;
  const projectPath = ctx?.projectRoot;
  async function api(action: string, input?: unknown) {
    const params = new URLSearchParams({
      hostId: hostId ?? "",
      projectPath: projectPath ?? "",
      action,
    });
    const response =
      input === undefined
        ? await fetch(`/api/worktrees?${params}`)
        : await fetch("/api/worktrees", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hostId, action, input }),
          });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "Request failed");
    return value;
  }
  async function refresh() {
    const response = await fetch(
      `/api/hierarchy?${new URLSearchParams({ host: hostId ?? "" })}`,
    );
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? "Request failed");
    setSnapshot(value);
    ctx?.refresh();
  }
  useEffect(() => {
    if (!hostId || !projectPath) return;
    let current = true;
    setBranch("");
    setName("");
    setBaseRef("");
    void refresh().catch((e) => {
      if (current) setError(String(e));
    });
    void api("branches")
      .then((next: WorkspaceBranches) => {
        if (!current) return;
        setBranches(next);
        setBaseRef(next.defaultRef);
      })
      .catch((e) => {
        if (current) setError(String(e));
      });
    return () => {
      current = false;
    };
  }, [hostId, projectPath]);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = setInterval(() => {
      const params = new URLSearchParams({
        hostId: hostId ?? "",
        action: "status",
        id: job.id,
      });
      void fetch(`/api/worktrees?${params}`)
        .then((r) => r.json())
        .then((next: WorkspaceCreationJob) => {
          setJob(next);
          if (next.workspaceId) void refresh();
        })
        .catch((e) => setError(String(e)));
    }, 1000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status, hostId]);
  if (!ctx || ctx.error)
    return <div>{ctx?.error ?? "Select a project to manage workspaces."}</div>;
  const project = snapshot?.projects.find((p) => p.path === projectPath);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const selected = mode === "local" ? branch : baseRef;
      const next = await api("create", {
        projectPath,
        branch,
        mode,
        baseRef: selected,
        name,
      });
      setJob(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(
    path: string,
    stopProcesses: boolean,
    discardChanges: boolean,
    cancel = false,
  ) {
    setBusy(true);
    setError("");
    try {
      const result: WorkspaceDeleteResult = await api("delete", {
        projectPath,
        path,
        stopProcesses,
        discardChanges,
        cancel,
      });
      if (result.status === "processes" || result.status === "dirty")
        setPending({
          path,
          status: result.status,
          processes: result.processes,
        });
      else {
        setPending(null);
        await refresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="workspace-manager"
      style={{ padding: 12, overflowY: "auto", height: "100%" }}
    >
      <h3>Workspaces</h3>
      {project?.workspaces.map((w) => (
        <div key={w.id} style={{ marginBottom: 8 }}>
          {w.setup && (
            <span>
              {" "}
              Setup: {w.setup.status}
              {w.setup.error ? ` — ${w.setup.error}` : ""}{" "}
              <button
                onClick={() => {
                  const params = new URLSearchParams({
                    hostId: hostId ?? "",
                    action: "status",
                    id: w.setup!.jobId,
                  });
                  void fetch(`/api/worktrees?${params}`)
                    .then((r) => r.json())
                    .then(setJob)
                    .catch((e) => setError(String(e)));
                }}
              >
                View logs
              </button>
            </span>
          )}
          <button
            onClick={() => ctx.select(w.path)}
            aria-pressed={ctx.currentPath === w.path}
          >
            {w.name}
            {w.isDefault ? " (default)" : ""}
          </button>
          {!w.isDefault && (
            <button
              disabled={busy || w.setup?.status === "running"}
              onClick={() => setDeleteTarget(w.path)}
            >
              Delete
            </button>
          )}
          {pending?.path === w.path && (
            <div>
              {pending.status === "processes" ? (
                <>
                  <p>Stop these running processes before deletion?</p>
                  <ul>
                    {pending.processes?.map((p) => (
                      <li key={p.id}>
                        {p.id} — {p.cwd}
                      </li>
                    ))}
                  </ul>
                  <button onClick={() => void remove(w.path, true, false)}>
                    Stop and continue
                  </button>
                </>
              ) : (
                <>
                  <p>
                    Discard uncommitted changes? Previously stopped sessions
                    remain stopped if you cancel.
                  </p>
                  <button onClick={() => void remove(w.path, true, true)}>
                    Discard and delete
                  </button>
                </>
              )}{" "}
              <button onClick={() => void remove(w.path, false, false, true)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      ))}
      {project?.kind === "git" && (
        <>
          <h3>Create workspace</h3>
          <label>
            Branch source{" "}
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as WorkspaceBranchMode);
                setBranch("");
                setBaseRef(e.target.value === "new" ? branches.defaultRef : "");
              }}
            >
              <option value="new">New branch</option>
              <option value="local">Existing local branch</option>
              <option value="remote">Existing remote branch</option>
            </select>
          </label>
          {mode === "local" ? (
            <label>
              Branch{" "}
              <select
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value);
                  setName(e.target.value.replace(/[\\/]/g, "-"));
                }}
              >
                <option value="">Select branch</option>
                {branches.local.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                Branch name{" "}
                <input
                  value={branch}
                  onChange={(e) => {
                    setBranch(e.target.value);
                    setName(e.target.value.replace(/[\\/]/g, "-"));
                  }}
                />
              </label>
              <label>
                {mode === "remote" ? "Remote branch" : "Base ref"}{" "}
                <select
                  value={baseRef}
                  onChange={(e) => setBaseRef(e.target.value)}
                >
                  <option value="">Select ref</option>
                  {(mode === "remote"
                    ? branches.remote
                    : [...branches.local, ...branches.remote]
                  ).map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <p>
            Workspace directory: {projectPath}-worktrees/
            {branch.replace(/[^a-zA-Z0-9._-]/g, "-")}
          </p>
          <label>
            Display name{" "}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button
            disabled={
              busy || !branch || !name || (mode !== "local" && !baseRef)
            }
            onClick={() => void create()}
          >
            Create
          </button>
          {job && (
            <div>
              <p>
                Setup: {job.status} / {job.stage}
                {job.error ? ` — ${job.error}` : ""}
              </p>
              <pre style={{ whiteSpace: "pre-wrap" }}>{job.logs}</pre>
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete workspace?"
        description="Remove this worktree and its registrations. The branch and session history are kept. Running processes and uncommitted changes require separate approval."
        confirmLabel="Delete workspace"
        danger
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) void remove(target, false, false);
        }}
      />
    </div>
  );
}
