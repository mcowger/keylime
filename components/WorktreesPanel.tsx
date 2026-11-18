"use client";

import { useEffect, useState } from "react";
import type {
  WorkspaceBranches,
  WorkspaceBranchMode,
  WorkspaceCreationJob,
  WorkspaceCreateRequest,
} from "@/lib/workspace-creation-types";
import { sanitizeWorkspaceBranch } from "@/lib/workspace-branch";
import type { HierarchyProject } from "@/lib/project-hierarchy-types";
import { Alert, Field, Select, TextInput } from "./ui/field";
import { PendingOperation } from "./PendingOperation";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";

export async function readWorkspaceSetupJob(
  hostId: string,
  id: string,
  signal?: AbortSignal,
): Promise<WorkspaceCreationJob> {
  const params = new URLSearchParams({ hostId, action: "status", id });
  const response = await fetch(`/api/worktrees?${params}`, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export function WorktreesPanel({
  hostId,
  project,
  currentPath,
  onSelect,
  onCreate,
  onRemove,
  creation,
  removingPath,
  deletionDisabled,
}: {
  hostId: string;
  project: HierarchyProject;
  currentPath: string | null;
  onSelect: (path: string) => void;
  onCreate: (input: WorkspaceCreateRequest) => void;
  onRemove: (path: string) => void;
  creation?: WorkspaceCreationJob | "starting";
  removingPath?: string;
  deletionDisabled?: boolean;
}) {
  const [branches, setBranches] = useState<WorkspaceBranches>({
    local: [],
    remote: [],
    defaultRef: "",
    originAheadRef: null,
    otherRefs: [],
    pullRequests: [],
  });
  const [mode, setMode] = useState<WorkspaceBranchMode>("new");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [name, setName] = useState("");
  const [viewedJob, setViewedJob] = useState<WorkspaceCreationJob | null>(null);
  const [showCreationLogs, setShowCreationLogs] = useState(true);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const projectPath = project.path;
  const creationJob = creation === "starting" ? undefined : creation;
  const building = creation === "starting" ||
    (creationJob?.status === "running" && creationJob.stage !== "postNonBlocking");
  const job = viewedJob ?? (showCreationLogs ? creationJob : undefined);
  const creationBranch = mode === "local" ? branch : sanitizeWorkspaceBranch(branch);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ hostId, projectPath, action: "branches" });
    void fetch(`/api/worktrees?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const next = await response.json();
        if (!response.ok) throw new Error(next.error ?? `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        setBranches(next);
        setBaseRef(next.defaultRef.replace(/^refs\/(heads|remotes)\//, ""));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, [hostId, projectPath]);
  useEffect(() => {
    if (!viewedJob || viewedJob.status !== "running") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void readWorkspaceSetupJob(hostId, viewedJob.id, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) setViewedJob(next);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(String(e));
        });
    }, 1000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [hostId, viewedJob]);

  function viewLogs(id: string) {
    if (id === creationJob?.id) {
      setViewedJob(null);
      setShowCreationLogs(true);
    } else {
      void readWorkspaceSetupJob(hostId, id).then(setViewedJob).catch((e) => setError(String(e)));
    }
  }

  return (
    <div
      className="workspace-manager"
      style={{ padding: 12, overflowY: "auto", height: "100%" }}
    >
      <h3>Workspaces</h3>
      {project.workspaces.map((w) => (
          <div key={w.id} style={{ marginBottom: 8 }}>
            {w.setup && (
              <span>
                {" "}
                Setup: {w.setup.status}
                {w.setup.error ? ` — ${w.setup.error}` : ""}{" "}
                <button onClick={() => viewLogs(w.setup!.jobId)}>
                  View logs
                </button>
              </span>
            )}
            <button
              onClick={() => onSelect(w.path)}
              aria-pressed={currentPath === w.path}
            >
              {w.name}
              {w.isDefault ? " (default)" : ""}
            </button>
            {!w.isDefault && (
              <button
                disabled={deletionDisabled || w.setup?.status === "running"}
                onClick={() => onRemove(w.path)}
              >
                Delete
              </button>
            )}
            {removingPath === w.path && <PendingOperation label="Deleting workspace…" />}
          </div>
        ))}
      {!modalOpen && job && (
        <section aria-label="Workspace setup logs">
          <p>
            Setup: {job.status} / {job.stage}
            {job.error ? ` — ${job.error}` : ""}
          </p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {job.logs}
          </pre>
          <button type="button" onClick={() => {
            setViewedJob(null);
            setShowCreationLogs(false);
          }}>
            Close logs
          </button>
        </section>
      )}
      {!modalOpen && building && <PendingOperation label="Building workspace…" />}
      {project.kind === "git" && (
        <button disabled={building} onClick={() => setModalOpen(true)}>Create workspace</button>
      )}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent
          className="workspace-create-dialog"
          style={{ width: 520 }}
        >
          <DialogTitle>Create workspace</DialogTitle>
          <div
            style={{
              marginTop: 8,
              color: "var(--text-muted)",
              fontSize: 13,
              overflowWrap: "anywhere",
            }}
          >
            Project: {project.alias ?? project.name}
            {projectPath && <div>{projectPath}</div>}
          </div>
          {project.kind === "git" && (
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
                    {
                      new: "New branch",
                      local: "Existing local branch",
                      remote: "Existing remote branch",
                    }[mode]
                  }
                  required
                  options={[
                    "New branch",
                    "Existing local branch",
                    "Existing remote branch",
                  ]}
                  onChange={(value) => {
                    const nextMode: WorkspaceBranchMode =
                      value === "Existing local branch"
                        ? "local"
                        : value === "Existing remote branch"
                          ? "remote"
                          : "new";
                    setMode(nextMode);
                    setBranch("");
                    setBaseRef(
                      nextMode === "new"
                        ? branches.defaultRef.replace(
                            /^refs\/(heads|remotes)\//,
                            "",
                          )
                        : "",
                    );
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
                  <Field
                    label={mode === "remote" ? "Remote branch" : "Base ref"}
                  >
                    <Select
                      value={baseRef}
                      onChange={setBaseRef}
                      placeholder="Select ref"
                      options={
                        mode === "remote"
                          ? branches.remote
                          : [...branches.local, ...branches.remote]
                      }
                    />
                  </Field>
                </>
              )}
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                  overflowWrap: "anywhere",
                }}
              >
                Workspace directory: {projectPath}-worktrees/
                {creationBranch.replace(/[^a-zA-Z0-9._-]/g, "-")}
              </div>
              <Field label="Display name">
                <TextInput value={name} onChange={setName} />
              </Field>
              <div
                className="dialog-actions"
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  paddingTop: 4,
                }}
              >
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
                  {building ? "Close" : "Cancel"}
                </button>
                <button
                  type="button"
                  className="dialog-action"
                  disabled={
                    building ||
                    !creationBranch ||
                    !name.trim() ||
                    (mode !== "local" && !baseRef)
                  }
                  onClick={() => {
                    setViewedJob(null);
                    setShowCreationLogs(true);
                    onCreate({
                      projectPath,
                      branch: creationBranch,
                      mode,
                      baseRef: mode === "local" ? branch : baseRef,
                      name,
                    });
                  }}
                  style={{
                    padding: "6px 14px",
                    background: "var(--accent-strong)",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--on-accent)",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    opacity:
                      building ||
                      !creationBranch ||
                      !name.trim() ||
                      (mode !== "local" && !baseRef)
                        ? 0.6
                        : 1,
                  }}
                >
                  {building ? <PendingOperation label="Building workspace…" /> : "Create"}
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
            <Alert
              variant="error"
              description={error}
              style={{ marginTop: 12 }}
            />
          )}
        </DialogContent>
      </Dialog>
      {!modalOpen && error && <p role="alert">{error}</p>}
    </div>
  );
}
