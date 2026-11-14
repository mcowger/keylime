"use client";

import { useEffect, useState } from "react";
import type { WorktreeContext } from "./SessionSidebar-helpers";
import type {
  WorkspaceBranches,
  WorkspaceBranchMode,
  WorkspaceCreationJob,
  WorkspaceDeleteResult,
} from "@/lib/workspace-creation-types";
import { sanitizeWorkspaceBranch } from "@/lib/workspace-branch";
import type { HierarchySnapshot } from "@/lib/project-hierarchy-types";
import { Alert, ConfirmDialog, Field, Select, TextInput } from "./ui/field";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";

export function WorktreesPanel({
  ctx,
  createOpen,
  onCreateOpenChange,
  createOnly = false,
}: {
  ctx: WorktreeContext | null;
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  createOnly?: boolean;
}) {
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
  const [localCreateOpen, setLocalCreateOpen] = useState(false);
  const modalOpen = createOpen ?? localCreateOpen;
  const setModalOpen = onCreateOpenChange ?? setLocalCreateOpen;
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
  const creationBranch =
    mode === "local" ? branch : sanitizeWorkspaceBranch(branch);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const selected = mode === "local" ? branch : baseRef;
      const next = await api("create", {
        projectPath,
        branch: creationBranch,
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
      style={
        createOnly
          ? undefined
          : { padding: 12, overflowY: "auto", height: "100%" }
      }
    >
      {!createOnly && <h3>Workspaces</h3>}
      {!createOnly &&
        project?.workspaces.map((w) => (
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
      {!createOnly && project?.kind === "git" && (
        <button onClick={() => setModalOpen(true)}>Create workspace</button>
      )}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent style={{ width: 520 }}>
          <DialogTitle>Create workspace</DialogTitle>
          {project?.kind === "git" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                marginTop: 16,
              }}
            >
              <Field label="Branch source">
                <Select
                  value={
                    { new: "New branch", local: "Existing local branch", remote: "Existing remote branch" }[mode]
                  }
                  required
                  options={["New branch", "Existing local branch", "Existing remote branch"]}
                  onChange={(value) => {
                    const nextMode: WorkspaceBranchMode =
                      value === "Existing local branch" ? "local" :
                      value === "Existing remote branch" ? "remote" : "new";
                    setMode(nextMode);
                    setBranch("");
                    setBaseRef(nextMode === "new" ? branches.defaultRef : "");
                  }}
                />
              </Field>
              {mode === "local" ? (
                <Field label="Branch">
                  <Select
                    value={branch}
                    placeholder="Select branch"
                    options={branches.local}
                    onChange={(value) => {
                      setBranch(value);
                      setName(value.replace(/[\\/]/g, "-"));
                    }}
                  />
                </Field>
              ) : (
                <>
                  <Field
                    label="Branch name"
                    hint={`Git branch: ${creationBranch || "Enter a branch name"}`}
                  >
                    <TextInput
                      value={branch}
                      onChange={(value) => {
                        setBranch(value);
                        setName(value.replace(/[\\/]/g, "-"));
                      }}
                    />
                  </Field>
                  <Field label={mode === "remote" ? "Remote branch" : "Base ref"}>
                    <Select
                      value={baseRef}
                      onChange={setBaseRef}
                      placeholder="Select ref"
                      options={
                        mode === "remote" ? branches.remote : [...branches.local, ...branches.remote]
                      }
                    />
                  </Field>
                </>
              )}
              <div style={{
                fontSize: 12,
                color: "var(--text-muted)",
                lineHeight: 1.5,
                overflowWrap: "anywhere",
              }}>
                Workspace directory: {projectPath}-worktrees/
                {creationBranch.replace(/[^a-zA-Z0-9._-]/g, "-")}
              </div>
              <Field label="Display name">
                <TextInput value={name} onChange={setName} />
              </Field>
              <div className="dialog-actions" style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
                <button
                  type="button"
                  className="dialog-action"
                  onClick={() => setModalOpen(false)}
                  style={{
                    padding: "6px 14px",
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="dialog-action"
                  disabled={
                    busy || !creationBranch || !name.trim() || (mode !== "local" && !baseRef)
                  }
                  onClick={() => void create()}
                  style={{
                    padding: "6px 14px",
                    background: "var(--accent-strong)",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--on-accent)",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    opacity: busy || !creationBranch || !name.trim() || (mode !== "local" && !baseRef) ? 0.6 : 1,
                  }}
                >
                  Create
                </button>
              </div>
              {job && (
                <div>
                  <p>
                    Setup: {job.status} / {job.stage}
                    {job.error ? ` — ${job.error}` : ""}
                  </p>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{job.logs}</pre>
                </div>
              )}
            </div>
          )}
          {error && (
            <Alert variant="error" description={error} style={{ marginTop: 12 }} />
          )}
        </DialogContent>
      </Dialog>
      {!modalOpen && error && <p role="alert">{error}</p>}
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
