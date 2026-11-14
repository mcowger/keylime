import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "../omp/paths";
import { createGitEnvironment } from "../project-command-env";
import { listWorktrees, removeWorktree } from "../worktree";
import type {
  WorkspaceBranches,
  WorkspaceCreateRequest,
  WorkspaceCreationJob,
  WorkspaceCreationSettings,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResult,
  WorkspacePipeline,
  WorkspaceSettingsRequest,
} from "../workspace-creation-types";
import { sanitizeWorkspaceBranch } from "../workspace-branch";
import {
  readHierarchy,
  registerCreatedWorkspace,
  unregisterDeletedWorkspace,
  updateWorkspaceSetup,
} from "./project-hierarchy";
import { HostOpError } from "./link-protocol";

/** The daemon must fence new starts until release, including starts from other servers. */
export interface WorkspaceDeletionAdapter {
  fence(path: string): () => void;
  inspect(path: string): Promise<Array<{ id: string; cwd: string }>>;
  stop(path: string): Promise<void>;
}
let deletionAdapter: WorkspaceDeletionAdapter | undefined;
export function setWorkspaceDeletionAdapter(
  adapter: WorkspaceDeletionAdapter,
): void {
  deletionAdapter = adapter;
}
const empty = (): WorkspacePipeline => ({ pre: [], create: [], post: [] });
const root = () => path.join(getAgentDir(), "omp-web", "workspace-creation");
const settingsFile = () => path.join(root(), "settings.json");
const jobsDir = () => path.join(root(), "jobs");
function save(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function read<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}
function project(projectPath: string) {
  if (typeof projectPath !== "string")
    throw new HostOpError(400, "invalid_request", "Invalid project path");
  const found = readHierarchy().projects.find((p) => p.path === projectPath);
  if (!found || found.kind !== "git")
    throw new HostOpError(
      404,
      "project_not_found",
      "Registered Git project not found",
    );
  return found;
}
function validPipeline(p: WorkspacePipeline): boolean {
  return (
    !!p &&
    [p.pre, p.create, p.post].every(
      (a) =>
        Array.isArray(a) && a.every((s) => typeof s === "string" && !!s.trim()),
    )
  );
}
type StoredSettings = {
  defaults: WorkspacePipeline;
  projects: Record<string, WorkspacePipeline>;
};
function settings(): StoredSettings {
  return read(settingsFile(), { defaults: empty(), projects: {} });
}
export async function workspaceCreationSettings(
  input: WorkspaceSettingsRequest,
): Promise<WorkspaceCreationSettings> {
  if (
    input.projectPath !== undefined &&
    !readHierarchy().projects.some(
      (project) => project.path === input.projectPath,
    )
  )
    throw new HostOpError(
      404,
      "project_not_found",
      "Registered project not found",
    );
  if (input.override !== undefined && !input.projectPath)
    throw new HostOpError(
      400,
      "invalid_request",
      "Project overrides require a project",
    );
  const data = settings();
  if (input.defaults !== undefined) {
    if (!validPipeline(input.defaults))
      throw new HostOpError(400, "invalid_request", "Invalid default pipeline");
    data.defaults = input.defaults;
  }
  if (input.override !== undefined) {
    if (input.override === null) delete data.projects[input.projectPath!];
    else {
      if (!validPipeline(input.override))
        throw new HostOpError(
          400,
          "invalid_request",
          "Invalid project pipeline",
        );
      data.projects[input.projectPath!] = input.override;
    }
  }
  if (input.defaults !== undefined || input.override !== undefined)
    save(settingsFile(), data);
  return {
    defaults: data.defaults,
    override: input.projectPath
      ? (data.projects[input.projectPath] ?? null)
      : null,
  };
}
const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await exec("git", ["-C", cwd, ...args], {
      env: createGitEnvironment({ LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" }),
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
}
export async function workspaceBranches(
  projectPath: string,
): Promise<WorkspaceBranches> {
  project(projectPath);
  await git(projectPath, ["fetch", "--all", "--prune"]);
  const refs = await git(projectPath, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
  ]);
  const local: string[] = [],
    remote: string[] = [];
  for (const ref of refs.trim().split("\n")) {
    if (ref.startsWith("refs/heads/")) local.push(ref.slice(11));
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
      remote.push(ref.slice(13));
  }
  let defaultRef = "";
  const remotes = (await git(projectPath, ["remote"]))
    .trim()
    .split("\n")
    .filter(Boolean);
  remotes.sort((a, b) =>
    a === "origin" ? -1 : b === "origin" ? 1 : a.localeCompare(b),
  );
  for (const remoteName of remotes) {
    const advertised = await git(projectPath, [
      "ls-remote",
      "--symref",
      remoteName,
      "HEAD",
    ]);
    const branch = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(advertised)?.[1];
    if (branch) {
      defaultRef = local.includes(branch) ? branch : `${remoteName}/${branch}`;
      break;
    }
  }
  if (!defaultRef)
    defaultRef = local.includes("main")
      ? "main"
      : local.includes("master")
        ? "master"
        : (
            await git(projectPath, [
              "symbolic-ref",
              "--quiet",
              "--short",
              "HEAD",
            ])
          ).trim();
  return { local, remote, defaultRef };
}
const active = new Map<string, WorkspaceCreationJob>();
const running = new Map<string, Promise<void>>();
const children = new Map<string, ChildProcess>();
const interrupted = new Set<string>();
export function workspaceCreationBusy(): boolean {
  return active.size > 0;
}
export async function stopWorkspaceCreation(): Promise<void> {
  for (const id of active.keys()) interrupted.add(id);
  for (const child of children.values()) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  await Promise.allSettled(running.values());
}
let recovered = false;
function jobFile(id: string) {
  return path.join(jobsDir(), `${id}.json`);
}
function persist(job: WorkspaceCreationJob) {
  save(jobFile(job.id), job);
}
export function recoverWorkspaceCreation(): void {
  if (recovered) return;
  recovered = true;
  let files: string[];
  try {
    files = fs.readdirSync(jobsDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const job = read<WorkspaceCreationJob | null>(
      path.join(jobsDir(), file),
      null,
    );
    if (job?.status === "running" && !active.has(job.id)) {
      job.status = "interrupted";
      job.error = "Daemon restarted during setup";
      persist(job);
      if (job.workspaceId)
        updateWorkspaceSetup(job.workspaceId, {
          status: "interrupted",
          jobId: job.id,
          stage: job.stage,
          error: job.error,
        });
    }
  }
}
export async function workspaceCreationStatus(
  id: string,
): Promise<WorkspaceCreationJob> {
  recoverWorkspaceCreation();
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new HostOpError(400, "invalid_request", "Invalid job ID");
  const job =
    active.get(id) ?? read<WorkspaceCreationJob | null>(jobFile(id), null);
  if (!job) throw new HostOpError(404, "job_not_found", "Job not found");
  return job;
}
function run(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  job: WorkspaceCreationJob,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (interrupted.has(job.id)) {
    reject(new Error("Daemon stopped during setup"));
    return promise;
  }
  const child = spawn(command, {
    cwd,
    env,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(job.id, child);
  const output = (data: Buffer) => {
    job.logs += data.toString();
    persist(job);
  };
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  child.on("error", reject);
  child.on("close", (code) => {
    children.delete(job.id);
    code === 0 && !interrupted.has(job.id)
      ? resolve()
      : reject(new Error(`Command failed (exit ${code}): ${command}`));
  });
  return promise;
}
async function execute(job: WorkspaceCreationJob, requested: string) {
  const { input, pipeline } = job;
  const resultFile = path.join(root(), `result-${job.id}.json`);
  const env = createGitEnvironment({
    OMP_PROJECT_PATH: input.projectPath,
    OMP_WORKSPACE_PATH: requested,
    OMP_BRANCH: input.branch,
    OMP_BASE_REF: input.baseRef,
    OMP_BRANCH_MODE: input.mode,
    OMP_CREATE_RESULT: resultFile,
    GIT_TERMINAL_PROMPT: "0",
  });
  try {
    for (const cmd of pipeline.pre) await run(cmd, input.projectPath, env, job);
    job.stage = "create";
    persist(job);
    if (pipeline.create.length) {
      for (const cmd of pipeline.create)
        await run(cmd, input.projectPath, env, job);
    } else {
      const args = ["worktree", "add"];
      if (input.mode === "new") args.push("-b", input.branch);
      else if (input.mode === "remote")
        args.push("--track", "-b", input.branch);
      args.push(
        "--",
        requested,
        input.mode === "local" ? input.branch : input.baseRef,
      );
      await run(
        `git ${args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ")}`,
        input.projectPath,
        env,
        job,
      );
    }
    const result = read<{ path?: unknown }>(resultFile, {});
    const actual = typeof result.path === "string" ? result.path : requested;
    if (!path.isAbsolute(actual))
      throw new Error("Create result path must be absolute");
    const actualReal = fs.realpathSync(actual);
    const worktree = (await listWorktrees(input.projectPath)).find(
      (w) => fs.realpathSync(w.path) === actualReal && !w.isMain,
    );
    if (!worktree)
      throw new Error("Create result is not a linked worktree of this project");
    job.workspacePath = worktree.path;
    job.stage = "post";
    const workspace = registerCreatedWorkspace(
      input.projectPath,
      worktree.path,
      worktree.branch ?? input.branch,
      { status: "running", jobId: job.id, stage: job.stage },
      input.name,
    );
    job.workspaceId = workspace.id;
    persist(job);
    env.OMP_WORKSPACE_PATH = worktree.path;
    for (const cmd of pipeline.post) await run(cmd, worktree.path, env, job);
    job.status = "complete";
    updateWorkspaceSetup(workspace.id, {
      status: "complete",
      jobId: job.id,
      stage: job.stage,
    });
  } catch (e) {
    job.status = interrupted.has(job.id) ? "interrupted" : "failed";
    job.error = interrupted.has(job.id)
      ? "Daemon stopped during setup"
      : e instanceof Error
        ? e.message
        : String(e);
    if (job.workspaceId)
      updateWorkspaceSetup(job.workspaceId, {
        status: job.status,
        jobId: job.id,
        stage: job.stage,
        error: job.error,
      });
  } finally {
    persist(job);
    active.delete(job.id);
    interrupted.delete(job.id);
    try {
      fs.unlinkSync(resultFile);
    } catch {}
  }
}
export async function createWorkspace(
  input: WorkspaceCreateRequest,
): Promise<WorkspaceCreationJob> {
  recoverWorkspaceCreation();
  project(input.projectPath);
  if (typeof input.branch === "string" && input.mode !== "local")
    input = { ...input, branch: sanitizeWorkspaceBranch(input.branch) };
  if (
    typeof input.branch !== "string" ||
    !input.branch ||
    input.branch.startsWith("-") ||
    typeof input.baseRef !== "string" ||
    !input.baseRef ||
    input.baseRef.startsWith("-") ||
    !["local", "remote", "new"].includes(input.mode) ||
    typeof input.name !== "string" ||
    !input.name.trim()
  )
    throw new HostOpError(
      400,
      "invalid_request",
      "Invalid workspace creation request",
    );
  await git(input.projectPath, ["check-ref-format", "--branch", input.branch]);
  const directoryName = input.branch.replace(/[^a-zA-Z0-9._-]/g, "-");
  const requested = path.join(`${input.projectPath}-worktrees`, directoryName);
  if (fs.existsSync(requested))
    throw new HostOpError(
      409,
      "workspace_exists",
      "Workspace path already exists",
    );
  const config = await workspaceCreationSettings({
    projectPath: input.projectPath,
  });
  const job: WorkspaceCreationJob = {
    id: randomUUID(),
    input,
    pipeline: config.override ?? config.defaults,
    status: "running",
    stage: "pre",
    logs: "",
  };
  active.set(job.id, job);
  persist(job);
  const task = execute(job, requested);
  running.set(job.id, task);
  void task.finally(() => running.delete(job.id));
  return job;
}
const deletionLeases = new Map<
  string,
  { release: () => void; timer: NodeJS.Timeout }
>();
const deleting = new Set<string>();
export async function removeRegisteredWorktree(
  input: WorkspaceDeleteRequest,
  beforeRemove?: (workspacePath: string) => Promise<void>,
): Promise<WorkspaceDeleteResult> {
  recoverWorkspaceCreation();
  const owner = project(input.projectPath);
  const workspace = owner.workspaces.find((w) => w.path === input.path);
  if (!workspace || workspace.isDefault)
    throw new HostOpError(
      404,
      "workspace_not_found",
      "Registered linked workspace not found",
    );
  if (
    [...active.values()].some(
      (j) =>
        j.workspaceId === workspace.id || j.workspacePath === workspace.path,
    )
  )
    throw new HostOpError(409, "setup_running", "Workspace setup is running");
  if (!deletionAdapter)
    throw new HostOpError(
      503,
      "deletion_unavailable",
      "Process fencing is unavailable",
    );
  if (deleting.has(workspace.path))
    throw new HostOpError(
      409,
      "deletion_in_progress",
      "Workspace deletion is already in progress",
    );
  deleting.add(workspace.path);
  const previous = deletionLeases.get(workspace.path);
  if (previous) {
    clearTimeout(previous.timer);
    deletionLeases.delete(workspace.path);
  }
  const release = previous?.release ?? deletionAdapter.fence(workspace.path);
  let held = false;
  const hold = () => {
    const timer = setTimeout(() => {
      deletionLeases.delete(workspace.path);
      release();
    }, 120_000);
    timer.unref();
    deletionLeases.set(workspace.path, { release, timer });
    held = true;
  };
  try {
    if (input.cancel) return { status: "cancelled" };
    const processes = await deletionAdapter.inspect(workspace.path);
    if (processes.length && !input.stopProcesses)
      return { status: "processes", processes };
    if (processes.length) {
      await deletionAdapter.stop(workspace.path);
      if ((await deletionAdapter.inspect(workspace.path)).length)
        throw new HostOpError(
          409,
          "processes_running",
          "Could not stop all workspace processes",
        );
    }
    const dirty = (
      await git(workspace.path, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])
    ).trim();
    if (dirty && !input.discardChanges) {
      hold();
      return { status: "dirty" };
    }
    const target = (await listWorktrees(input.projectPath)).find(
      (worktree) => worktree.path === workspace.path,
    );
    if (!target || target.isMain)
      throw new HostOpError(
        404,
        "workspace_not_found",
        "Linked worktree not found",
      );
    const branch = target.branch;
    let merged = false;
    if (branch) {
      const defaultWorkspace = owner.workspaces.find((w) => w.isDefault);
      if (!defaultWorkspace)
        throw new HostOpError(
          409,
          "default_workspace_not_found",
          "Default workspace not found",
        );
      try {
        await git(defaultWorkspace.path, [
          "merge-base",
          "--is-ancestor",
          `refs/heads/${branch}`,
          "HEAD",
        ]);
        merged = true;
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== 1
        )
          throw error;
      }
      if (!merged) {
        // A squash merge has different commit IDs. Only treat it as integrated
        // when the branch changes are nonempty and a real merge adds nothing
        // to the default workspace's tree, without conflicts.
        let base = "";
        try {
          base = (await git(defaultWorkspace.path, [
            "merge-base",
            "HEAD",
            `refs/heads/${branch}`,
          ])).trim();
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== 1
          )
            throw error;
        }
        const changes = base
          ? await git(defaultWorkspace.path, [
              "diff",
              "--name-only",
              base,
              `refs/heads/${branch}`,
            ])
          : "";
        if (changes.trim()) {
          try {
            const tree = (await git(defaultWorkspace.path, [
              "merge-tree",
              "--write-tree",
              "HEAD",
              `refs/heads/${branch}`,
            ])).split("\n", 1)[0];
            const headTree = (await git(defaultWorkspace.path, [
              "rev-parse",
              "HEAD^{tree}",
            ])).trim();
            merged = tree === headTree;
          } catch (error) {
            if (
              !error ||
              typeof error !== "object" ||
              !("code" in error) ||
              error.code !== 1
            )
              throw error;
          }
        }
      }
      if (!merged && input.keepBranch === undefined) {
        hold();
        return { status: "branch", branch };
      }
      if (!merged && typeof input.keepBranch !== "boolean")
        throw new HostOpError(
          400,
          "invalid_request",
          "Invalid branch decision",
        );
    }
    if (beforeRemove) await beforeRemove(workspace.path);
    await removeWorktree(
      input.projectPath,
      workspace.path,
      input.discardChanges,
    );
    unregisterDeletedWorkspace(workspace.path);
    if (branch && (merged || input.keepBranch === false))
      await git(input.projectPath, [
        "branch",
        "-D",
        "--",
        branch,
      ]);
    return { status: "deleted" };
  } finally {
    deleting.delete(workspace.path);
    if (!held) release();
  }
}
