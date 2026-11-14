"use client";

import { useEffect, useState } from "react";
import type { WorktreeContext } from "./SessionSidebar-helpers";
import type {
  WorkspaceBranches,
  WorkspaceBranchMode,
  WorkspaceCreationJob,
  WorkspaceCreationSettings,
  WorkspaceDeleteResult,
  WorkspacePipeline,
} from "@/lib/workspace-creation-types";
import type { HierarchySnapshot } from "@/lib/project-hierarchy-types";
import { ConfirmDialog } from "./ui/field";

export function WorktreesPanel({ ctx }: { ctx: WorktreeContext | null }) {
  const [branches, setBranches] = useState<WorkspaceBranches>({
    local: [],
    remote: [],
  });
  const [mode, setMode] = useState<WorkspaceBranchMode>("new");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [name, setName] = useState("");
  const [job, setJob] = useState<WorkspaceCreationJob | null>(null);
  const [snapshot, setSnapshot] = useState<HierarchySnapshot | null>(null);
  const [settings, setSettings] = useState<WorkspaceCreationSettings | null>(
    null,
  );
  const [scope, setScope] = useState<"defaults" | "override">("defaults");
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
    void refresh().catch((e) => setError(String(e)));
    void api("branches")
      .then(setBranches)
      .catch((e) => setError(String(e)));
    void api("settings")
      .then(setSettings)
      .catch((e) => setError(String(e)));
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
  const pipeline =
    settings && (scope === "defaults" ? settings.defaults : settings.override);
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
  async function saveSettings() {
    if (!settings) return;
    setBusy(true);
    try {
      const cleaned = pipeline && {
        pre: pipeline.pre.filter((s) => s.trim()),
        create: pipeline.create.filter((s) => s.trim()),
        post: pipeline.post.filter((s) => s.trim()),
      };
      setSettings(await api("settings", { projectPath, [scope]: cleaned }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function editPipeline(stage: keyof WorkspacePipeline, value: string) {
    if (!settings || !pipeline) return;
    setSettings({
      ...settings,
      [scope]: { ...pipeline, [stage]: value.split("\n") },
    });
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
                setBaseRef("");
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
          <h3>Creation commands</h3>
          <label>
            Settings{" "}
            <select
              value={scope}
              onChange={(e) =>
                setScope(e.target.value as "defaults" | "override")
              }
            >
              <option value="defaults">Host defaults</option>
              <option value="override">Project override</option>
            </select>
          </label>
          {scope === "override" && (
            <label>
              <input
                type="checkbox"
                checked={!!settings?.override}
                onChange={(e) =>
                  settings &&
                  setSettings({
                    ...settings,
                    override: e.target.checked
                      ? structuredClone(settings.defaults)
                      : null,
                  })
                }
              />{" "}
              Override all stages
            </label>
          )}
          {pipeline &&
            (["pre", "create", "post"] as const).map((stage) => (
              <label key={stage} style={{ display: "block" }}>
                {stage} commands (one per line)
                <textarea
                  value={pipeline[stage].join("\n")}
                  onChange={(e) => editPipeline(stage, e.target.value)}
                />
              </label>
            ))}
          <p>
            Commands receive OMP_PROJECT_PATH, OMP_WORKSPACE_PATH, OMP_BRANCH,
            OMP_BASE_REF, OMP_BRANCH_MODE and OMP_CREATE_RESULT. Write JSON{" "}
            {`{"path":"/absolute/worktree/path"}`} to OMP_CREATE_RESULT to
            return a custom path. An empty create stage uses Git.
          </p>
          <button
            disabled={busy || !settings}
            onClick={() => void saveSettings()}
          >
            Save settings
          </button>
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
