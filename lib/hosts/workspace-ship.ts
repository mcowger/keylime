import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Value } from "@sinclair/typebox/value";
import { getAgentDir, getSessionsDir } from "../omp/paths";
import { readSessionHeaderSync } from "../omp/session-files";
import { isValidSessionId } from "../session-file-references-core";
import { resolveSessionPath } from "../session-reader";
import { createGitEnvironment } from "../project-command-env";
import { resolveGithubRepo } from "../github-repo";
import {
  SHIP_MONITOR_GRANT_ID_PATTERN,
  ShipRegisterPrInputSchema,
} from "../api-contracts/workspace-models";
import type {
  ShipJob,
  ShipPr,
  ShipPrMonitor,
  ShipPreview,
  ShipMonitorStatusResult,
  ShipRegisterPrInput,
  ShipStartInput,
  ShipStartMonitorInput,
  ShipStepName,
  ShipStopMonitorRequest,
  WorkspaceShipState,
} from "../workspace-ship-types";
import { HostOpError, type ShipPrDigest } from "./link-protocol";
import { completePlanningWorkspace } from "./planning";
import { readHierarchy } from "./project-hierarchy";
import { removeRegisteredWorktree } from "./workspace-creation";
import { sessionOps } from "./session-ops";
import { isEffortPath } from "./systems";
import {
  githubShipPr,
  readShipFeedback,
  readShipPrStatus,
  type ShipFeedback,
} from "./workspace-ship-github";
import { publishWorkspaceJobChange } from "./workspace-job-changes";

interface PrMonitor {
  id: string;
  owner: string;
  sessionId: string;
  requestedAt: number;
  strictBaseline?: true;
  seen: string[];
  pending: ShipPrDigest[];
  pollFailed?: true;
  deliveryExpired?: true;
}

interface RecordPr {
  projectPath: string;
  path: string;
  workspaceId?: string;
  base: string;
  pr: ShipPr;
  /** Replaced by each Ship, not by watcher/receipt updates. Older records have no generation. */
  generation?: string;
  monitor?: PrMonitor;
  autoMerge?: { head: string; method: "squash" | "merge" | "rebase" };
  retryAt?: number;
  /** The watcher attempted automatic cleanup; a failure leaves cleanup to the workspace menu. */
  autoFinished?: boolean;
}
const root = () => path.join(getAgentDir(), "keylime", "ship");
const jobsDir = () => path.join(root(), "jobs");
const prFile = () => path.join(root(), "prs.json");
const active = new Map<string, ShipJob>();
const startingMonitors = new Map<string, symbol>();
let changed = () => {};
let offerDigest: ((owner: string, digest: ShipPrDigest) => void) | undefined;
const OFFER_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const DIGEST_LINK_LIMIT = 20;
const grantIdPattern = new RegExp(SHIP_MONITOR_GRANT_ID_PATTERN);
let timer: ReturnType<typeof setInterval> | undefined;
let watching = false;
let recovered = false;
let ghCache: { at: number; value: ShipPreview["github"]["gh"] } | undefined;
function save(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function read<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
const records = () => read<Record<string, RecordPr>>(prFile(), {});
let recordsRevision = 0;
function saveRecords(value: Record<string, RecordPr>) {
  save(prFile(), value);
  recordsRevision++;
  publishWorkspaceJobChange("ship");
}
function sameRecord(
  current: RecordPr | undefined,
  snapshot: RecordPr,
): current is RecordPr {
  return (
    !!current &&
    current.generation === snapshot.generation &&
    current.workspaceId === snapshot.workspaceId &&
    current.projectPath === snapshot.projectPath &&
    current.pr.url === snapshot.pr.url
  );
}

function publicPr(record: RecordPr): ShipPr {
  const { monitor, pr } = record;
  return monitor
    ? {
        ...pr,
        monitor: {
          id: monitor.id,
          state: monitor.deliveryExpired
            ? "delivery-expired"
            : monitor.pollFailed
              ? "error"
              : "watching",
        },
      }
    : pr;
}
const persist = (job: ShipJob) => {
  save(path.join(jobsDir(), `${job.id}.json`), job);
  publishWorkspaceJobChange("ship");
};

function assertShipAllowed(workspacePath: string): void {
  if (isEffortPath(workspacePath))
    throw new HostOpError(
      409,
      "effort_workspace",
      "Standalone Ship is not available for Effort workspaces",
    );
}

function registered(input: { projectPath: string; path: string }) {
  if (
    !input ||
    typeof input.projectPath !== "string" ||
    typeof input.path !== "string"
  )
    throw new HostOpError(400, "invalid_request", "Invalid workspace request");
  assertShipAllowed(input.path);
  const project = readHierarchy().projects.find(
    (p) => p.path === input.projectPath && p.kind === "git" && !p.hidden,
  );
  const workspace = project?.workspaces.find(
    (w) => w.path === input.path && !w.isDefault,
  );
  const base = project?.workspaces.find((w) => w.isDefault);
  if (!workspace || !base)
    throw new HostOpError(
      404,
      "workspace_not_found",
      "Registered linked workspace not found",
    );
  return { workspace, base };
}
function matchesWorkspace(record: RecordPr): boolean {
  if (!record.workspaceId) return false;
  const project = readHierarchy().projects.find(
    (item) =>
      item.path === record.projectPath && item.kind === "git" && !item.hidden,
  );
  return (
    project?.workspaces.some(
      (workspace) =>
        workspace.path === record.path &&
        workspace.id === record.workspaceId &&
        !workspace.isDefault,
    ) ?? false
  );
}

function requireWorkspace(
  input: { projectPath: string; path: string },
  workspaceId: string,
): void {
  if (registered(input).workspace.id !== workspaceId)
    throw new HostOpError(
      409,
      "ship_workspace_changed",
      "The workspace changed during Ship",
    );
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Resolve through the index, but never treat a cached path or cached cwd as liveness. */
function liveShipSession(
  input: { projectPath: string; path: string },
  id: string,
  file: string | null,
): boolean {
  if (!file) return false;
  try {
    const { workspace } = registered(input);
    if (!workspace.sessionIds.includes(id)) return false;
    const activeRoot = fs.realpathSync(getSessionsDir());
    const realFile = fs.realpathSync(file);
    if (!inside(activeRoot, realFile) || realFile === activeRoot) return false;
    const header = readSessionHeaderSync(file, true);
    return (
      header?.id === id &&
      typeof header.cwd === "string" &&
      path.isAbsolute(header.cwd) &&
      fs.realpathSync(workspace.path) === workspace.path &&
      inside(workspace.path, fs.realpathSync(header.cwd))
    );
  } catch (error) {
    if (
      error instanceof HostOpError ||
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw error;
  }
}

function assertLiveShipSession(
  input: { projectPath: string; path: string },
  id: string,
  file: string | null,
) {
  if (!liveShipSession(input, id, file))
    throw new HostOpError(
      409,
      "ship_session_unavailable",
      "Monitoring requires an active chat in this workspace",
    );
}
function command(
  cwd: string,
  program: string,
  args: string[],
  input?: string,
  job?: ShipJob,
  allowConflict = false,
  env?: NodeJS.ProcessEnv,
  timeout?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...createGitEnvironment(), ...env },
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (job) {
        job.logs = (job.logs + stdout + stderr).slice(-100_000);
        persist(job);
      }
      if (code === 0 || (allowConflict && code === 1)) resolve(stdout.trim());
      else
        reject(
          new Error(
            stderr.trim() || stdout.trim() || `${program} exited ${code}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}
const git = (cwd: string, args: string[], job?: ShipJob) =>
  command(cwd, "git", args, undefined, job);
async function branch(cwd: string) {
  return (
    (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
      () => "",
    )) || null
  );
}
async function dirty(cwd: string) {
  return !!(await git(cwd, ["status", "--porcelain", "--untracked-files=all"]));
}
async function ghState(cwd: string): Promise<ShipPreview["github"]["gh"]> {
  if (ghCache && Date.now() - ghCache.at < 60_000) return ghCache.value;
  let value: ShipPreview["github"]["gh"] = "ok";
  try {
    await command(cwd, "gh", ["auth", "status"]);
  } catch (error) {
    value =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "missing"
        : "unauthenticated";
  }
  ghCache = { at: Date.now(), value };
  return value;
}
async function openPr(
  cwd: string,
  repo: string,
  head: string,
): Promise<ShipPr | null> {
  const [owner, name] = repo.split("/");
  const data = JSON.parse(
    await command(cwd, "gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      head,
      "--state",
      "open",
      "--json",
      "number,url,autoMergeRequest,headRepositoryOwner,headRepository",
      "--limit",
      "100",
    ]),
  ) as {
    number: number;
    url: string;
    autoMergeRequest?: unknown;
    headRepositoryOwner: { login: string };
    headRepository: { name: string };
  }[];
  const matches = data.filter(
    (pr) =>
      pr.headRepositoryOwner?.login.toLowerCase() === owner.toLowerCase() &&
      pr.headRepository?.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length > 1)
    throw new Error("Multiple open pull requests found for this branch");
  const pr = matches[0];
  if (!pr) return null;
  const canonical = githubShipPr(pr.url, pr.number);
  if (canonical.number !== pr.number || canonical.repo !== repo.toLowerCase())
    throw new Error("Unexpected GitHub pull request identity");
  return {
    number: canonical.number,
    url: canonical.url,
    state: "open",
    checks: "none",
    autoMerge: !!pr.autoMergeRequest,
    cleanup: false,
    checkedAt: new Date().toISOString(),
  };
}
export async function registerShipPr(
  input: ShipRegisterPrInput,
  assertAvailable?: (path: string) => void,
): Promise<ShipPr> {
  if (!Value.Check(ShipRegisterPrInputSchema, input))
    throw new HostOpError(
      400,
      "invalid_request",
      "Invalid PR registration request",
    );
  const pinned = githubShipPr(input.prUrl);
  if (pinned.url !== input.prUrl)
    throw new HostOpError(400, "invalid_request", "Invalid canonical PR URL");
  const matches = readHierarchy().projects.flatMap((project) =>
    project.workspaces
      .filter((workspace) => workspace.sessionIds.includes(input.sessionId))
      .map((workspace) => ({
        projectPath: project.path,
        path: workspace.path,
      })),
  );
  if (matches.length !== 1)
    throw new HostOpError(
      409,
      "ship_session_unavailable",
      "Chat has no unique registered workspace",
    );
  const target = matches[0];
  const { workspace, base } = registered(target);
  const workspaceId = workspace.id;
  const assertIdle = () => {
    assertAvailable?.(target.path);
    if (active.has(target.path) || startingMonitors.has(target.path))
      throw new HostOpError(
        409,
        "ship_running",
        "Workspace shipping or monitoring is starting",
      );
  };
  assertIdle();
  const file = await resolveSessionPath(input.sessionId);
  assertLiveShipSession(target, input.sessionId, file);
  const [head, baseBranch, repo] = await Promise.all([
    branch(target.path),
    branch(base.path),
    resolveGithubRepo(target.path),
  ]);
  if (!head || !baseBranch || !repo || repo.toLowerCase() !== pinned.repo)
    throw new HostOpError(
      409,
      "pr_workspace_mismatch",
      "Pull request does not match this workspace",
    );
  const pr = await openPr(target.path, repo, head);
  if (!pr || pr.url !== pinned.url)
    throw new HostOpError(
      409,
      "pr_workspace_mismatch",
      "Open pull request does not match this workspace",
    );
  assertIdle();
  requireWorkspace(target, workspaceId);
  assertLiveShipSession(target, input.sessionId, file);
  const all = records();
  const current = all[target.path];
  if (
    current?.workspaceId === workspaceId &&
    current.projectPath === target.projectPath
  ) {
    if (current.pr.url === pr.url && current.pr.state === "open")
      return publicPr(current);
    if (
      current.pr.state === "open" ||
      current.monitor ||
      current.autoMerge ||
      current.pr.cleanup
    )
      throw new HostOpError(
        409,
        "ship_pr_conflict",
        "Another pull request is recorded for this workspace",
      );
  }
  all[target.path] = {
    ...target,
    workspaceId,
    base: baseBranch,
    generation: randomUUID(),
    pr,
  };
  saveRecords(all);
  changed();
  return pr;
}

export async function shipPreview(input: {
  projectPath: string;
  path: string;
}): Promise<ShipPreview> {
  const { base, workspace } = registered(input);
  const baseBranch = await branch(base.path);
  if (!baseBranch)
    throw new HostOpError(
      409,
      "base_detached",
      "Default workspace is not on a branch",
    );
  const [
    current,
    counts,
    workspaceDirty,
    baseDirty,
    repo,
    gh,
    unmerged,
    gitDir,
  ] = await Promise.all([
    branch(input.path),
    git(input.path, [
      "rev-list",
      "--left-right",
      "--count",
      `refs/heads/${baseBranch}...HEAD`,
    ]),
    dirty(input.path),
    dirty(base.path),
    resolveGithubRepo(input.path),
    ghState(input.path),
    git(input.path, ["diff", "--name-only", "--diff-filter=U", "-z"]),
    git(input.path, ["rev-parse", "--absolute-git-dir"]),
  ]);
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  const issues: string[] = [];
  if (!current) issues.push("Workspace is not on a branch.");
  if (unmerged)
    issues.push(
      `Unresolved conflicts: ${unmerged.split("\0").filter(Boolean).join(", ")}`,
    );
  const operations = [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase or am"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ];
  for (const [file, operation] of operations) {
    if (fs.existsSync(path.join(gitDir, file)))
      issues.push(
        `A ${operation} is in progress; complete or abort it before shipping.`,
      );
  }
  if (behind > 0 && !issues.length && (ahead > 0 || workspaceDirty)) {
    let head = "HEAD";
    let temporary: string | undefined;
    try {
      if (workspaceDirty) {
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), "keylime-ship-"));
        const index = path.join(temporary, "index");
        const source = await git(input.path, [
          "rev-parse",
          "--git-path",
          "index",
        ]);
        const sourceIndex = path.resolve(input.path, source);
        if (fs.existsSync(sourceIndex)) fs.copyFileSync(sourceIndex, index);
        const env = { GIT_INDEX_FILE: index };
        if (!fs.existsSync(index))
          await command(
            input.path,
            "git",
            ["read-tree", "HEAD"],
            undefined,
            undefined,
            false,
            env,
          );
        await command(
          input.path,
          "git",
          ["add", "--all"],
          undefined,
          undefined,
          false,
          env,
        );
        const tree = await command(
          input.path,
          "git",
          ["write-tree"],
          undefined,
          undefined,
          false,
          env,
        );
        head = await git(input.path, [
          "-c",
          "user.name=Keylime",
          "-c",
          "user.email=ship@invalid",
          "commit-tree",
          tree,
          "-p",
          "HEAD",
          "-m",
          "Ship preflight",
        ]);
      }
      const result = await command(
        input.path,
        "git",
        [
          "merge-tree",
          "--write-tree",
          "--name-only",
          "-z",
          `refs/heads/${baseBranch}`,
          head,
        ],
        undefined,
        undefined,
        true,
      );
      const fields = result.split("\0");
      const end = fields.indexOf("", 1);
      const conflicts = fields
        .slice(1, end < 0 ? undefined : end)
        .filter(Boolean);
      if (conflicts.length)
        issues.push(
          `Potential conflicts with ${baseBranch}: ${conflicts.join(", ")}`,
        );
    } finally {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  let detected: ShipPr | null = null;
  let prLookupError: string | null = null;
  if (current && repo && gh === "ok") {
    try {
      detected = await openPr(input.path, repo, current);
    } catch (error) {
      prLookupError = `Pull request lookup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const record = records()[input.path];
  const saved =
    record?.workspaceId === workspace.id ? publicPr(record) : undefined;
  const pr =
    detected && saved?.url === detected.url
      ? { ...saved, ...detected, cleanup: saved.cleanup }
      : detected;
  return {
    branch: current,
    base: baseBranch,
    baseCheckout: base.path,
    ahead,
    behind,
    dirty: workspaceDirty,
    baseDirty,
    issues,
    github: { repo, gh, prLookupError },
    pr,
  };
}
function recover() {
  if (recovered) return;
  recovered = true;
  let files: string[];
  try {
    files = fs.readdirSync(jobsDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const job = read<ShipJob | null>(path.join(jobsDir(), file), null);
    if (job?.status === "running") {
      job.status = "interrupted";
      job.error = "Daemon restarted during ship";
      persist(job);
    }
  }
}
export async function shipStatus(id: string): Promise<ShipJob> {
  recover();
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw new HostOpError(400, "invalid_request", "Invalid job ID");
  const job = read<ShipJob | null>(path.join(jobsDir(), `${id}.json`), null);
  if (!job) throw new HostOpError(404, "job_not_found", "Ship job not found");
  if (job.pr?.monitor) {
    const current = records()[job.path];
    if (
      current?.pr.url === job.pr.url &&
      current.monitor?.id === job.pr.monitor.id
    )
      job.pr.monitor = publicPr(current).monitor;
    else delete job.pr.monitor;
  }
  return job;
}
export function workspaceShipState(
  workspacePath: string,
): WorkspaceShipState | undefined {
  recover();
  const record = records()[workspacePath];
  const pr = record && matchesWorkspace(record) ? publicPr(record) : undefined;
  let jobs: ShipJob[] = [];
  try {
    jobs = fs
      .readdirSync(jobsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => read<ShipJob | null>(path.join(jobsDir(), f), null))
      .filter((j): j is ShipJob => !!j && j.path === workspacePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const latest = jobs.sort(
    (a, b) =>
      fs.statSync(path.join(jobsDir(), `${b.id}.json`)).mtimeMs -
      fs.statSync(path.join(jobsDir(), `${a.id}.json`)).mtimeMs,
  )[0];
  const job = latest?.status === "complete" ? undefined : latest;
  return pr || job
    ? {
        ...(pr ? { pr } : {}),
        ...(job
          ? { job: { id: job.id, kind: job.kind, status: job.status } }
          : {}),
      }
    : undefined;
}
const names: ShipStepName[] = [
  "rebase",
  "fastForward",
  "push",
  "createPr",
  "autoMerge",
  "pullBase",
  "archiveSessions",
  "removeWorkspace",
];
function createJob(
  input: { projectPath: string; path: string },
  kind: ShipJob["kind"],
  mode?: ShipJob["mode"],
) {
  registered(input);
  recover();
  if (active.has(input.path))
    throw new HostOpError(
      409,
      "ship_running",
      "A ship job is already running for this workspace",
    );
  const job: ShipJob = {
    id: randomUUID(),
    kind,
    projectPath: input.projectPath,
    path: input.path,
    mode,
    status: "running",
    steps: names.map((name) => ({ name, status: "skipped" })),
    logs: "",
  };
  // A Ship/cleanup job supersedes any standalone start awaiting validation.
  startingMonitors.delete(input.path);
  active.set(input.path, job);
  persist(job);
  return job;
}
async function step(
  job: ShipJob,
  name: ShipStepName,
  action: () => Promise<void>,
) {
  const item = job.steps.find((s) => s.name === name)!;
  item.status = "running";
  persist(job);
  try {
    await action();
    item.status = "done";
    persist(job);
  } catch (e) {
    item.status = "failed";
    item.detail = e instanceof Error ? e.message : String(e);
    persist(job);
    throw e;
  }
}
function launch(job: ShipJob, action: () => Promise<void>) {
  void (async () => {
    try {
      await action();
      job.status = "complete";
    } catch (error) {
      if (job.status !== "conflict") job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      if (job.kind === "finish") {
        const all = records();
        if (all[job.path]) {
          all[job.path].retryAt = Date.now() + 300_000;
          saveRecords(all);
        }
      }
    } finally {
      active.delete(job.path);
      persist(job);
      changed();
    }
  })();
  return job;
}
async function cleanup(job: ShipJob, workspaceId: string) {
  requireWorkspace(job, workspaceId);
  const { workspace } = registered(job);
  const remove = job.steps.find((s) => s.name === "removeWorkspace")!;
  remove.status = "running";
  persist(job);
  try {
    const result = await removeRegisteredWorktree(
      {
        projectPath: job.projectPath,
        path: job.path,
        stopProcesses: true,
        discardChanges: false,
        keepBranch: false,
      },
      async () => {
        requireWorkspace(job, workspaceId);
        await step(job, "archiveSessions", async () => {
          const sessions = await sessionOps.listSessions();
          const byId = new Map(sessions.map((s) => [s.id, s]));
          const depth = (id: string) => {
            let n = 0,
              current = byId.get(id);
            const seen = new Set<string>();
            while (
              current?.parentSessionId &&
              !seen.has(current.parentSessionId)
            ) {
              seen.add(current.parentSessionId);
              n++;
              current = byId.get(current.parentSessionId);
            }
            return n;
          };
          for (const id of [...workspace.sessionIds].sort(
            (a, b) => depth(b) - depth(a),
          )) {
            const result = await sessionOps.archiveSession(id);
            if (!result.ok) throw new Error(result.error);
            removeShipMonitorsForSession(id);
            changed();
          }
        });
        requireWorkspace(job, workspaceId);
      },
    );
    if (result.status !== "deleted")
      throw new Error(`Workspace removal refused: ${result.status}`);
    remove.status = "done";
    persist(job);
  } catch (error) {
    remove.status = "failed";
    remove.detail = error instanceof Error ? error.message : String(error);
    persist(job);
    throw error;
  }
}
export async function startShip(
  input: ShipStartInput,
  owner?: string,
): Promise<ShipJob> {
  if (
    !input ||
    !["local", "pr", "pr-auto"].includes(input.mode) ||
    typeof input.rebase !== "boolean" ||
    typeof input.cleanup !== "boolean" ||
    (input.monitorSessionId === undefined) !==
      (input.monitorGrantId === undefined) ||
    (input.monitorGrantId !== undefined &&
      (typeof input.monitorGrantId !== "string" ||
        !grantIdPattern.test(input.monitorGrantId))) ||
    (input.monitorSessionId !== undefined &&
      (input.mode === "local" ||
        typeof input.monitorSessionId !== "string" ||
        !isValidSessionId(input.monitorSessionId))) ||
    (input.mergeMethod !== undefined &&
      !["squash", "merge", "rebase"].includes(input.mergeMethod)) ||
    (input.pr !== undefined &&
      (!input.pr ||
        typeof input.pr.title !== "string" ||
        !input.pr.title.trim() ||
        typeof input.pr.body !== "string" ||
        !input.pr.body.trim())) ||
    (input.mode === "pr" && !input.pr)
  )
    throw new HostOpError(400, "invalid_request", "Invalid ship request");
  const workspaceId = registered(input).workspace.id;
  const requestedAt = Date.now();
  const sessionId = input.monitorSessionId;
  const grantId = input.monitorGrantId;
  let sessionFile: string | null = null;
  let monitoredAtStart: string | undefined;
  if (sessionId) {
    if (!owner)
      throw new HostOpError(
        403,
        "ship_monitor_owner_required",
        "Monitoring requires an authenticated server",
      );
    const { workspace } = registered(input);
    const prior = records()[input.path];
    if (prior?.workspaceId === workspaceId && prior.monitor)
      monitoredAtStart = prior.pr.url;
    if (workspace.sessionIds.includes(sessionId))
      sessionFile = await resolveSessionPath(sessionId);
    assertLiveShipSession(input, sessionId, sessionFile);
    if (records()[input.path]?.generation !== prior?.generation)
      throw new HostOpError(
        409,
        "ship_changed",
        "The recorded pull request changed during validation",
      );
  }
  const validateSession = () => {
    if (sessionId) assertLiveShipSession(input, sessionId, sessionFile);
  };
  const job = createJob(input, "ship", input.mode);
  for (const item of job.steps) {
    if (
      (item.name === "rebase" && input.rebase) ||
      (item.name === "fastForward" && input.mode === "local") ||
      (item.name === "push" && input.mode !== "local") ||
      (item.name === "createPr" && input.mode !== "local") ||
      (item.name === "autoMerge" && input.mode === "pr-auto") ||
      ((item.name === "archiveSessions" || item.name === "removeWorkspace") &&
        input.mode === "local" &&
        input.cleanup)
    )
      item.status = "pending";
  }
  persist(job);
  return launch(job, async () => {
    const preview = await shipPreview(input);
    requireWorkspace(input, workspaceId);
    if (preview.dirty) throw new Error("Workspace has uncommitted changes");
    if (!preview.branch) throw new Error("Workspace is not on a branch");
    if (input.mode === "pr" && preview.pr)
      throw new Error("An open pull request already exists for this branch");
    if (input.mode === "pr-auto" && !preview.pr && !input.pr)
      throw new Error(
        "A pull request title and body are required when no open pull request exists",
      );
    if (input.rebase)
      await step(job, "rebase", async () => {
        assertShipAllowed(input.path);
        validateSession();
        try {
          await git(input.path, ["rebase", `refs/heads/${preview.base}`], job);
        } catch (error) {
          const files = await git(input.path, [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ]).catch(() => "");
          await git(input.path, ["rebase", "--abort"], job).catch(() => {});
          if (files) {
            job.conflictFiles = files.split("\n");
            job.status = "conflict";
          }
          throw error;
        }
      });
    if (input.mode === "local") {
      await step(job, "fastForward", async () => {
        if (
          (await dirty(preview.baseCheckout)) ||
          (await branch(preview.baseCheckout)) !== preview.base
        )
          throw new Error(
            "Default workspace is dirty or no longer on the base branch",
          );
        assertShipAllowed(input.path);
        await git(
          preview.baseCheckout,
          ["merge", "--ff-only", `refs/heads/${preview.branch}`],
          job,
        );
        requireWorkspace(input, workspaceId);
        completePlanningWorkspace(input.projectPath, input.path);
        job.landedSha = await git(preview.baseCheckout, ["rev-parse", "HEAD"]);
      });
      if (input.cleanup) await cleanup(job, workspaceId);
    } else {
      let pushedHead = "";
      await step(job, "push", async () => {
        const upstream = await git(input.path, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]).catch(() => "");
        if (input.mode === "pr-auto")
          pushedHead = await git(input.path, ["rev-parse", "HEAD"]);
        assertShipAllowed(input.path);
        validateSession();
        await git(
          input.path,
          [
            "push",
            ...(upstream ? ["--force-with-lease"] : []),
            "-u",
            "origin",
            input.mode === "pr-auto"
              ? `${pushedHead}:refs/heads/${preview.branch}`
              : "HEAD",
          ],
          job,
        );
        if (input.mode === "pr-auto")
          await git(
            input.path,
            [
              "branch",
              `--set-upstream-to=origin/${preview.branch}`,
              preview.branch!,
            ],
            job,
          );
      });
      await step(job, "createPr", async () => {
        if (!preview.github.repo || preview.github.gh !== "ok")
          throw new Error(
            "GitHub repository and authentication are required to ship a pull request",
          );
        let existing = await openPr(
          input.path,
          preview.github.repo,
          preview.branch!,
        ).catch(() => preview.pr);
        if (existing && input.mode === "pr")
          throw new Error(
            "An open pull request already exists for this branch",
          );
        if (!existing) {
          if (!input.pr)
            throw new Error(
              "A pull request title and body are required when no open pull request exists",
            );
          assertShipAllowed(input.path);
          validateSession();
          try {
            const url = await command(
              input.path,
              "gh",
              [
                "pr",
                "create",
                "--base",
                preview.base,
                "--head",
                preview.branch!,
                "--title",
                input.pr.title,
                "--body-file",
                "-",
              ],
              input.pr.body,
              job,
            );
            const pr = githubShipPr(url);
            existing = {
              number: pr.number,
              url: pr.url,
              state: "open",
              checks: "none",
              autoMerge: false,
              cleanup: false,
              checkedAt: new Date().toISOString(),
            };
          } catch (error) {
            if (input.mode !== "pr-auto") throw error;
            existing = await openPr(
              input.path,
              preview.github.repo,
              preview.branch!,
            ).catch(() => null);
            if (!existing) throw error;
          }
        }
        assertShipAllowed(input.path);
        requireWorkspace(input, workspaceId);
        const { monitor: _previewMonitor, ...detected } = existing;
        const pr: ShipPr = { ...detected, cleanup: input.cleanup };
        const all = records();
        const previous = all[input.path];
        const samePr =
          previous?.projectPath === input.projectPath &&
          previous.workspaceId === workspaceId &&
          previous.pr.url === pr.url;
        const record: RecordPr = {
          projectPath: input.projectPath,
          path: input.path,
          workspaceId,
          base: preview.base,
          generation: job.id,
          pr,
        };
        // Same PR, same monitor, even if the caller opted out or connected from another server.
        if (samePr && previous.monitor) record.monitor = previous.monitor;
        let sessionError: unknown;
        if (sessionId && grantId && owner) {
          try {
            validateSession();
            if (!record.monitor && monitoredAtStart !== pr.url)
              record.monitor = {
                id: grantId,
                owner,
                sessionId,
                requestedAt,
                seen: [],
                pending: [],
              };
          } catch (error) {
            sessionError = error;
          }
        }
        all[input.path] = record;
        saveRecords(all);
        job.pr = publicPr(record);
        // GitHub may have created the PR just as the chat went away. Keep its PR record.
        if (sessionError) throw sessionError;
      });
      if (input.mode === "pr-auto")
        await step(job, "autoMerge", async () => {
          requireWorkspace(input, workspaceId);
          const all = records();
          const record = all[input.path];
          if (!record || record.generation !== job.id)
            throw new Error(
              "The recorded pull request changed during shipping",
            );
          record.autoMerge = {
            head: pushedHead,
            method: input.mergeMethod ?? "squash",
          };
          record.pr.autoMerge = true;
          job.pr = publicPr(record);
          saveRecords(all);
        });
      requireWorkspace(input, workspaceId);
      completePlanningWorkspace(input.projectPath, input.path);
    }
  });
}
async function refresh(record: RecordPr) {
  const cwd = fs.existsSync(record.path) ? record.path : record.projectPath;
  const data = await readShipPrStatus(cwd, record.pr.url, record.pr.number);
  const all = records();
  const current = all[record.path];
  // A result started before a new monitor was installed must not clear it.
  if (
    !sameRecord(current, record) ||
    !matchesWorkspace(current) ||
    active.has(record.path) ||
    current.monitor?.id !== record.monitor?.id
  )
    return;
  const wasMerged = current.pr.state === "merged";
  const checks = data.statusCheckRollup ?? [];
  current.pr = {
    ...current.pr,
    state:
      data.mergedAt || data.state === "MERGED" || current.pr.state === "merged"
        ? "merged"
        : data.state === "CLOSED"
          ? "closed"
          : "open",
    autoMerge: !!current.autoMerge || !!data.autoMergeRequest,
    checks: !checks.length
      ? "none"
      : checks.some((c) =>
            [
              "FAILURE",
              "ERROR",
              "TIMED_OUT",
              "CANCELLED",
              "ACTION_REQUIRED",
            ].includes(c.conclusion ?? c.state ?? ""),
          )
        ? "failing"
        : checks.some(
              (c) =>
                (c.status && c.status !== "COMPLETED") ||
                ["PENDING", "EXPECTED"].includes(c.state ?? ""),
            )
          ? "pending"
          : "passing",
    checkedAt: new Date().toISOString(),
  };
  if (current.pr.state !== "open") {
    delete current.autoMerge;
    current.pr.autoMerge = false;
  }
  if (current.pr.state !== "open") delete current.monitor;
  if (!wasMerged && current.pr.state === "merged" && matchesWorkspace(current))
    completePlanningWorkspace(current.projectPath, current.path);
  delete current.retryAt;
  saveRecords(all);
  return { record: current, data };
}
export async function shipFinish(input: {
  projectPath: string;
  path: string;
}): Promise<ShipJob> {
  registered(input);
  const snapshot = records()[input.path];
  if (
    !snapshot ||
    snapshot.projectPath !== input.projectPath ||
    !matchesWorkspace(snapshot)
  )
    throw new HostOpError(404, "pr_not_found", "No recorded PR for workspace");
  if (active.has(input.path))
    throw new HostOpError(
      409,
      "ship_running",
      "A ship job is already running for this workspace",
    );
  const record = (await refresh(snapshot))?.record;
  if (
    !record ||
    !sameRecord(records()[input.path], record) ||
    !matchesWorkspace(record)
  )
    throw new HostOpError(
      409,
      "ship_changed",
      "The recorded pull request changed during cleanup",
    );
  if (record.pr.state !== "merged")
    throw new HostOpError(409, "pr_not_merged", "PR is not merged");
  const job = createJob(input, "finish");
  job.pr = record.pr;
  for (const item of job.steps)
    if (["pullBase", "archiveSessions", "removeWorkspace"].includes(item.name))
      item.status = "pending";
  persist(job);
  return launch(job, async () => {
    requireWorkspace(input, record.workspaceId!);
    const { base } = registered(input);
    const pull = job.steps.find((s) => s.name === "pullBase")!;
    if ((await dirty(base.path)) || (await branch(base.path)) !== record.base) {
      pull.status = "skipped";
      pull.detail = "Default workspace is dirty or not on the base branch";
      persist(job);
    } else
      await step(job, "pullBase", async () => {
        requireWorkspace(input, record.workspaceId!);
        assertShipAllowed(input.path);
        await git(base.path, ["pull", "--ff-only"], job);
      });
    await cleanup(job, record.workspaceId!);
    const all = records();
    if (sameRecord(all[input.path], record)) {
      delete all[input.path];
      saveRecords(all);
    }
  });
}

export async function startShipMonitor(
  input: ShipStartMonitorInput,
  owner?: string,
  assertAvailable?: (path: string) => void,
): Promise<ShipPrMonitor> {
  const requestedAt = Date.now();
  const { workspace } = registered(input);
  const { path, projectPath, prUrl, sessionId, monitorId } = input;
  if (
    typeof prUrl !== "string" ||
    typeof sessionId !== "string" ||
    !isValidSessionId(sessionId) ||
    typeof monitorId !== "string" ||
    !grantIdPattern.test(monitorId)
  )
    throw new HostOpError(
      400,
      "invalid_request",
      "Invalid start monitor request",
    );
  if (!owner)
    throw new HostOpError(
      403,
      "ship_monitor_owner_required",
      "Monitoring requires an authenticated server",
    );
  const assertIdle = () => {
    assertAvailable?.(path);
    if (active.has(path))
      throw new HostOpError(
        409,
        "ship_running",
        "A ship job is already running for this workspace",
      );
  };
  const assertOpen = (open: boolean) => {
    if (!open)
      throw new HostOpError(
        409,
        "pr_not_open",
        "The recorded pull request is not open",
      );
  };
  assertIdle();
  const snapshot = records()[path];
  if (
    !snapshot ||
    snapshot.path !== path ||
    snapshot.workspaceId !== workspace.id ||
    snapshot.projectPath !== projectPath
  )
    throw new HostOpError(404, "pr_not_found", "No recorded PR for workspace");
  assertOpen(snapshot.pr.state === "open");
  const pinned = githubShipPr(snapshot.pr.url, snapshot.pr.number);
  if (snapshot.pr.url !== prUrl || pinned.url !== prUrl)
    throw new HostOpError(
      409,
      "ship_changed",
      "The selected pull request does not match the recorded pull request",
    );
  if (snapshot.monitor || startingMonitors.has(path))
    throw new HostOpError(
      409,
      "ship_monitor_exists",
      "A PR monitor already exists or is starting",
    );

  const start = Symbol();
  startingMonitors.set(path, start);
  const assertCurrent = (current: RecordPr | undefined): RecordPr => {
    assertIdle();
    if (
      startingMonitors.get(path) !== start ||
      !sameRecord(current, snapshot) ||
      !matchesWorkspace(current) ||
      current.path !== path ||
      current.pr.number !== pinned.number
    )
      throw new HostOpError(
        409,
        "ship_changed",
        "The recorded pull request changed during validation",
      );
    assertOpen(current.pr.state === "open");
    if (current.monitor)
      throw new HostOpError(
        409,
        "ship_monitor_exists",
        "A PR monitor already exists",
      );
    return current;
  };
  try {
    const file = workspace.sessionIds.includes(sessionId)
      ? await resolveSessionPath(sessionId)
      : null;
    assertCurrent(records()[path]);
    assertLiveShipSession(input, sessionId, file);
    const status = await readShipPrStatus(path, pinned.url, pinned.number);
    const all = records();
    const current = assertCurrent(all[path]);
    assertLiveShipSession(input, sessionId, file);
    assertOpen(status.state === "OPEN" && !status.mergedAt);
    current.monitor = {
      id: monitorId,
      owner,
      sessionId,
      requestedAt,
      strictBaseline: true,
      seen: [],
      pending: [],
    };
    saveRecords(all);
    changed();
    return { id: monitorId, state: "watching" };
  } finally {
    if (startingMonitors.get(path) === start) startingMonitors.delete(path);
  }
}

export async function shipMonitorStatus(
  input: ShipStopMonitorRequest,
  owner?: string,
): Promise<ShipMonitorStatusResult> {
  if (
    typeof input?.projectPath !== "string" ||
    typeof input.path !== "string" ||
    typeof input.monitorId !== "string" ||
    !grantIdPattern.test(input.monitorId)
  )
    throw new HostOpError(
      400,
      "invalid_request",
      "Invalid monitor status request",
    );
  if (!owner || isEffortPath(input.path)) return { watch: null };
  const snapshot = records()[input.path];
  const matches = (record: RecordPr | undefined) =>
    record &&
    record.projectPath === input.projectPath &&
    record.path === input.path &&
    record.pr.state === "open" &&
    record.monitor?.id === input.monitorId &&
    record.monitor.owner === owner
      ? record.monitor
      : undefined;
  const monitor = matches(snapshot);
  if (!snapshot || !monitor) return { watch: null };
  const file = await resolveSessionPath(monitor.sessionId);
  const current = records()[input.path];
  if (
    !sameRecord(current, snapshot) ||
    matches(current)?.sessionId !== monitor.sessionId ||
    isEffortPath(input.path) ||
    !liveShipSession(input, monitor.sessionId, file)
  )
    return { watch: null };
  return {
    watch: {
      sessionId: monitor.sessionId,
      prUrl: githubShipPr(current.pr.url, current.pr.number).url,
    },
  };
}

export function stopShipMonitor(input: ShipStopMonitorRequest, owner: string) {
  registered(input);
  if (typeof input.monitorId !== "string" || !input.monitorId)
    throw new HostOpError(400, "invalid_request", "Invalid monitor ID");
  const all = records();
  const record = all[input.path];
  const monitor = record?.monitor;
  if (
    record?.projectPath !== input.projectPath ||
    monitor?.id !== input.monitorId
  )
    return { stopped: false };
  if (monitor.owner !== owner)
    throw new HostOpError(
      403,
      "ship_monitor_owner_mismatch",
      "Only the server that started monitoring can stop it",
    );
  delete record.monitor;
  saveRecords(all);
  changed();
  return { stopped: true };
}

/** Call after successful archive/delete, before publishing the session change. */
export function removeShipMonitorsForSession(sessionId: string) {
  const all = records();
  let removed = false;
  for (const record of Object.values(all)) {
    if (record.monitor?.sessionId !== sessionId) continue;
    delete record.monitor;
    removed = true;
  }
  if (removed) {
    saveRecords(all);
    changed();
  }
}

export function acceptShipDigestReceipt(owner: string, id: string): boolean {
  const all = records();
  for (const { monitor } of Object.values(all)) {
    if (monitor?.owner !== owner) continue;
    const index = monitor.pending.findIndex((digest) => digest.id === id);
    if (index === -1) continue;
    monitor.pending.splice(index, 1);
    saveRecords(all);
    return true;
  }
  return false;
}

function currentWatch(current: RecordPr | undefined, snapshot: RecordPr) {
  return sameRecord(current, snapshot) &&
    !active.has(snapshot.path) &&
    current.pr.state === "open" &&
    current.monitor?.id === snapshot.monitor?.id
    ? current.monitor
    : undefined;
}

function expireDigests(monitor: PrMonitor, now: number) {
  // Legacy text offers have no monitorId. Never forward them on the new wire.
  const pending = monitor.pending.filter(
    (digest) =>
      digest.monitorId === monitor.id &&
      now - digest.createdAt < OFFER_LIFETIME,
  );
  if (pending.length === monitor.pending.length) return false;
  monitor.pending = pending;
  monitor.deliveryExpired = true;
  return true;
}

function batchFeedback(
  monitor: PrMonitor,
  prUrl: string,
  events: ShipFeedback[],
  now: number,
) {
  const seen = new Set(monitor.seen);
  const feedback: ShipPrDigest["feedback"] = [];
  let count = 0;
  // Ship includes its request's second. Standalone start must exclude feedback
  // that could already have existed on the PR when monitoring was requested.
  const since = monitor.strictBaseline
    ? monitor.requestedAt
    : Math.floor(monitor.requestedAt / 1000) * 1000;
  for (const event of events) {
    if (event.at < since || seen.has(event.key)) continue;
    seen.add(event.key);
    count++;
    if (feedback.length < DIGEST_LINK_LIMIT)
      feedback.push({ kind: event.kind, id: event.id });
  }
  if (!count) return false;
  const omitted = count - feedback.length;
  monitor.seen = [...seen];
  monitor.pending.push({
    id: randomUUID(),
    monitorId: monitor.id,
    sessionId: monitor.sessionId,
    createdAt: now,
    prUrl: githubShipPr(prUrl).url,
    feedback,
    omitted,
  });
  return true;
}

async function pollMonitor(record: RecordPr, cwd: string) {
  const snapshot = record.monitor;
  if (!snapshot) return;
  let file: string | null = null;
  let events: ShipFeedback[] | undefined;
  let sessionResolved = false;
  try {
    file = await resolveSessionPath(snapshot.sessionId);
    sessionResolved = true;
    if (
      liveShipSession(record, snapshot.sessionId, file) &&
      currentWatch(records()[record.path], record)
    )
      events = await readShipFeedback(cwd, record.pr.url);
  } catch {
    // A failed or partial read must not advance the seen baseline.
  }

  const all = records();
  const current = all[record.path];
  const monitor = currentWatch(current, record);
  if (!monitor) return;
  let live = false;
  if (sessionResolved) {
    try {
      live = liveShipSession(record, snapshot.sessionId, file);
      if (!live) {
        delete current.monitor;
        saveRecords(all);
        return;
      }
    } catch {
      // A storage problem is not proof that the session was removed.
    }
  }

  const now = Date.now();
  let dirty = expireDigests(monitor, now);
  if (events && live) {
    if (monitor.pollFailed) {
      delete monitor.pollFailed;
      dirty = true;
    }
    dirty = batchFeedback(monitor, record.pr.url, events, now) || dirty;
  } else if (!monitor.pollFailed) {
    monitor.pollFailed = true;
    dirty = true;
  }
  // Persist observations and assigned digest IDs together, before any offer.
  if (dirty) saveRecords(all);
  if (!live || !offerDigest || !monitor.pending.length) return;
  let revision = recordsRevision;
  let remaining: Set<string> | undefined;
  for (const pending of monitor.pending) {
    // The callback may synchronously change the watch or acknowledge an offer.
    if (revision !== recordsRevision) {
      const latest = currentWatch(records()[record.path], record);
      if (!latest) break;
      remaining = new Set(latest.pending.map(({ id }) => id));
      revision = recordsRevision;
    }
    if (
      Date.now() - pending.createdAt >= OFFER_LIFETIME ||
      (remaining && !remaining.has(pending.id))
    )
      continue;
    try {
      offerDigest?.(monitor.owner, pending);
    } catch {
      // No application receipt. Retry the persisted ID on the next poll.
    }
  }
}
export async function refreshShipPrs() {
  if (watching) return;
  watching = true;
  try {
    for (const path of Object.keys(records())) {
      const record = records()[path];
      if (
        !record ||
        active.has(path) ||
        isEffortPath(path) ||
        !matchesWorkspace(record)
      )
        continue;

      if (record.monitor) {
        const all = records();
        const monitor = currentWatch(all[path], record);
        if (monitor && expireDigests(monitor, Date.now())) {
          saveRecords(all);
          changed();
        }
      }
      if (
        record.pr.state === "closed" ||
        (record.retryAt && record.retryAt > Date.now())
      )
        continue;
      try {
        const result = await refresh(record);
        if (!result) continue;
        const { record: refreshed, data } = result;
        if (
          refreshed.autoMerge &&
          refreshed.pr.state === "open" &&
          data.headRefOid === refreshed.autoMerge.head &&
          data.mergeable === "MERGEABLE" &&
          data.mergeStateStatus === "CLEAN" &&
          data.isDraft === false &&
          Array.isArray(data.statusCheckRollup) &&
          data.statusCheckRollup.length > 0 &&
          data.statusCheckRollup.some((check) =>
            check.status
              ? check.conclusion === "SUCCESS"
              : check.state === "SUCCESS",
          ) &&
          data.statusCheckRollup.every((check) =>
            check.status
              ? check.status === "COMPLETED" &&
                ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(
                  check.conclusion ?? "",
                )
              : check.state === "SUCCESS",
          )
        ) {
          const current = records()[path];
          if (
            sameRecord(current, refreshed) &&
            matchesWorkspace(current) &&
            !active.has(path) &&
            current.autoMerge?.head === refreshed.autoMerge.head &&
            current.autoMerge.method === refreshed.autoMerge.method
          ) {
            try {
              await command(
                path,
                "gh",
                [
                  "pr",
                  "merge",
                  refreshed.pr.url,
                  `--${refreshed.autoMerge.method}`,
                  "--match-head-commit",
                  refreshed.autoMerge.head,
                ],
                undefined,
                undefined,
                false,
                { GH_PROMPT_DISABLED: "1" },
                20_000,
              );
              const all = records();
              const latest = all[path];
              if (
                sameRecord(latest, refreshed) &&
                latest.autoMerge?.head === refreshed.autoMerge.head &&
                latest.autoMerge.method === refreshed.autoMerge.method
              ) {
                delete latest.autoMerge;
                saveRecords(all);
              }
            } catch (error) {
              console.warn("Ship auto-merge failed; will retry", error);
            }
          }
        }
        if (refreshed.monitor) await pollMonitor(refreshed, refreshed.path);
        changed();
        if (
          refreshed.pr.state === "merged" &&
          refreshed.pr.cleanup &&
          !isEffortPath(path)
        ) {
          const all = records();
          const current = all[path];
          if (
            !sameRecord(current, refreshed) ||
            current.autoFinished ||
            !matchesWorkspace(current) ||
            active.has(path)
          )
            continue;
          current.autoFinished = true;
          saveRecords(all);
          await shipFinish(current);
        }
      } catch {
        const all = records();
        const current = all[path];
        if (
          sameRecord(current, record) &&
          !active.has(path) &&
          current.monitor?.id === record.monitor?.id
        ) {
          current.retryAt = Date.now() + 300_000;
          if (current.monitor) current.monitor.pollFailed = true;
          saveRecords(all);
          changed();
        }
      }
    }
  } finally {
    watching = false;
  }
}
export function shipWorkBusy(): boolean {
  return watching || active.size > 0;
}

export function startShipWatcher(
  onChanged: () => void,
  offer?: (owner: string, digest: ShipPrDigest) => void,
  mayPoll?: () => boolean,
) {
  changed = onChanged;
  offerDigest = offer;
  recover();
  if (!timer) {
    timer = setInterval(() => {
      if (mayPoll && !mayPoll()) return;
      void refreshShipPrs();
    }, 60_000);
    timer.unref();
  }
}
export function stopShipWatcher() {
  clearInterval(timer);
  timer = undefined;
  offerDigest = undefined;
  changed = () => {};
}
