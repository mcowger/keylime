import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getAgentDir } from "../omp/paths";
import { createGitEnvironment } from "../project-command-env";
import { resolveGithubRepo } from "../github-repo";
import type {
  ShipJob,
  ShipPr,
  ShipPreview,
  ShipRequest,
  ShipStepName,
  WorkspaceShipState,
} from "../workspace-ship-types";
import { HostOpError } from "./link-protocol";
import { readHierarchy } from "./project-hierarchy";
import { removeRegisteredWorktree } from "./workspace-creation";
import { sessionOps } from "./session-ops";

interface RecordPr {
  projectPath: string;
  path: string;
  base: string;
  pr: ShipPr;
  retryAt?: number;
  /** The watcher started the automatic cleanup once; a failure leaves it to the pill's Clean up. */
  autoFinished?: boolean;
}
const root = () => path.join(getAgentDir(), "omp-web", "ship");
const jobsDir = () => path.join(root(), "jobs");
const prFile = () => path.join(root(), "prs.json");
const active = new Map<string, ShipJob>();
let changed = () => {};
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
const persist = (job: ShipJob) =>
  save(path.join(jobsDir(), `${job.id}.json`), job);
function registered(input: { projectPath: string; path: string }) {
  if (
    !input ||
    typeof input.projectPath !== "string" ||
    typeof input.path !== "string"
  )
    throw new HostOpError(400, "invalid_request", "Invalid workspace request");
  const project = readHierarchy().projects.find(
    (p) => p.path === input.projectPath && p.kind === "git",
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
function command(
  cwd: string,
  program: string,
  args: string[],
  input?: string,
  job?: ShipJob,
  allowConflict = false,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...createGitEnvironment(), ...env },
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
export async function shipPreview(input: {
  projectPath: string;
  path: string;
}): Promise<ShipPreview> {
  const { base } = registered(input);
  const baseBranch = await branch(base.path);
  if (!baseBranch)
    throw new HostOpError(
      409,
      "base_detached",
      "Default workspace is not on a branch",
    );
  const [current, counts, workspaceDirty, baseDirty, repo, gh, unmerged, gitDir] =
    await Promise.all([
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
  if (unmerged) issues.push(`Unresolved conflicts: ${unmerged.split("\0").filter(Boolean).join(", ")}`);
  const operations = [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase or am"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ];
  for (const [file, operation] of operations) {
    if (fs.existsSync(path.join(gitDir, file)))
      issues.push(`A ${operation} is in progress; complete or abort it before shipping.`);
  }
  if (behind > 0 && !issues.length && (ahead > 0 || workspaceDirty)) {
    let head = "HEAD";
    let temporary: string | undefined;
    try {
      if (workspaceDirty) {
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), "keylime-ship-"));
        const index = path.join(temporary, "index");
        const source = await git(input.path, ["rev-parse", "--git-path", "index"]);
        const sourceIndex = path.resolve(input.path, source);
        if (fs.existsSync(sourceIndex)) fs.copyFileSync(sourceIndex, index);
        const env = { GIT_INDEX_FILE: index };
        if (!fs.existsSync(index))
          await command(input.path, "git", ["read-tree", "HEAD"], undefined, undefined, false, env);
        await command(input.path, "git", ["add", "--all"], undefined, undefined, false, env);
        const tree = await command(input.path, "git", ["write-tree"], undefined, undefined, false, env);
        head = await git(input.path, ["-c", "user.name=Keylime", "-c", "user.email=ship@invalid", "commit-tree", tree, "-p", "HEAD", "-m", "Ship preflight"]);
      }
      const result = await command(input.path, "git", [
        "merge-tree", "--write-tree", "--name-only", "-z", `refs/heads/${baseBranch}`, head,
      ], undefined, undefined, true);
      const fields = result.split("\0");
      const end = fields.indexOf("", 1);
      const conflicts = fields.slice(1, end < 0 ? undefined : end).filter(Boolean);
      if (conflicts.length) issues.push(`Potential conflicts with ${baseBranch}: ${conflicts.join(", ")}`);
    } finally {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return {
    branch: current,
    base: baseBranch,
    baseCheckout: base.path,
    ahead,
    behind,
    dirty: workspaceDirty,
    baseDirty,
    issues,
    github: { repo, gh },
    pr: records()[input.path]?.pr ?? null,
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
  return job;
}
export function workspaceShipState(
  workspacePath: string,
): WorkspaceShipState | undefined {
  recover();
  const pr = records()[workspacePath]?.pr;
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
  recover();
  registered(input);
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
          save(prFile(), all);
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
async function cleanup(job: ShipJob) {
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
            changed();
          }
        });
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
export async function startShip(input: ShipRequest): Promise<ShipJob> {
  if (
    !input ||
    !["local", "pr", "pr-auto"].includes(input.mode) ||
    typeof input.rebase !== "boolean" ||
    typeof input.cleanup !== "boolean" ||
    (input.mergeMethod !== undefined &&
      !["squash", "merge", "rebase"].includes(input.mergeMethod)) ||
    (input.mode !== "local" &&
      (!input.pr ||
        typeof input.pr.title !== "string" ||
        !input.pr.title.trim() ||
        typeof input.pr.body !== "string" ||
        !input.pr.body.trim()))
  )
    throw new HostOpError(400, "invalid_request", "Invalid ship request");
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
    if (preview.dirty) throw new Error("Workspace has uncommitted changes");
    if (!preview.branch) throw new Error("Workspace is not on a branch");
    if (input.rebase)
      await step(job, "rebase", async () => {
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
        await git(
          preview.baseCheckout,
          ["merge", "--ff-only", `refs/heads/${preview.branch}`],
          job,
        );
        job.landedSha = await git(preview.baseCheckout, ["rev-parse", "HEAD"]);
      });
      if (input.cleanup) await cleanup(job);
    } else {
      await step(job, "push", async () => {
        const upstream = await git(input.path, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]).catch(() => "");
        await git(
          input.path,
          [
            "push",
            ...(upstream ? ["--force-with-lease"] : []),
            "-u",
            "origin",
            "HEAD",
          ],
          job,
        );
      });
      await step(job, "createPr", async () => {
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
            input.pr!.title,
            "--body-file",
            "-",
          ],
          input.pr!.body,
          job,
        );
        const match = url.match(/https:\/\/[^\s]+\/pull\/(\d+)/);
        if (!match) throw new Error("Could not parse created PR URL");
        const pr: ShipPr = {
          number: Number(match[1]),
          url: match[0],
          state: "open",
          checks: "none",
          autoMerge: input.mode === "pr-auto",
          cleanup: input.cleanup,
          checkedAt: new Date().toISOString(),
        };
        const all = records();
        all[input.path] = {
          projectPath: input.projectPath,
          path: input.path,
          base: preview.base,
          pr,
        };
        save(prFile(), all);
        job.pr = pr;
      });
      if (input.mode === "pr-auto")
        await step(job, "autoMerge", async () => {
          await command(
            input.path,
            "gh",
            [
              "pr",
              "merge",
              String(job.pr!.number),
              `--${input.mergeMethod ?? "squash"}`,
              "--auto",
            ],
            undefined,
            job,
          );
        });
    }
  });
}
async function refresh(record: RecordPr) {
  const cwd = fs.existsSync(record.path) ? record.path : record.projectPath;
  const data = JSON.parse(
    await command(cwd, "gh", [
      "pr",
      "view",
      String(record.pr.number),
      "--json",
      "state,mergedAt,url,number,autoMergeRequest,statusCheckRollup",
    ]),
  ) as {
    state: string;
    mergedAt?: string | null;
    url: string;
    number: number;
    autoMergeRequest?: unknown;
    statusCheckRollup?: {
      status?: string;
      conclusion?: string;
      state?: string;
    }[];
  };
  const checks = data.statusCheckRollup ?? [];
  record.pr = {
    ...record.pr,
    number: data.number,
    url: data.url,
    state:
      data.mergedAt || data.state === "MERGED"
        ? "merged"
        : data.state === "CLOSED"
          ? "closed"
          : "open",
    autoMerge: !!data.autoMergeRequest,
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
  const all = records();
  if (all[record.path]) {
    all[record.path] = record;
    save(prFile(), all);
  }
  return record.pr;
}
export async function shipFinish(input: {
  projectPath: string;
  path: string;
}): Promise<ShipJob> {
  registered(input);
  const record = records()[input.path];
  if (!record || record.projectPath !== input.projectPath)
    throw new HostOpError(404, "pr_not_found", "No recorded PR for workspace");
  if (active.has(input.path))
    throw new HostOpError(
      409,
      "ship_running",
      "A ship job is already running for this workspace",
    );
  if ((await refresh(record)).state !== "merged")
    throw new HostOpError(409, "pr_not_merged", "PR is not merged");
  const job = createJob(input, "finish");
  job.pr = record.pr;
  for (const item of job.steps)
    if (["pullBase", "archiveSessions", "removeWorkspace"].includes(item.name))
      item.status = "pending";
  persist(job);
  return launch(job, async () => {
    const { base } = registered(input);
    const pull = job.steps.find((s) => s.name === "pullBase")!;
    if ((await dirty(base.path)) || (await branch(base.path)) !== record.base) {
      pull.status = "skipped";
      pull.detail = "Default workspace is dirty or not on the base branch";
      persist(job);
    } else
      await step(job, "pullBase", async () => {
        await git(base.path, ["pull", "--ff-only"], job);
      });
    await cleanup(job);
    const all = records();
    delete all[input.path];
    save(prFile(), all);
  });
}
export async function refreshShipPrs() {
  if (watching) return;
  watching = true;
  try {
    for (const record of Object.values(records())) {
      if (
        record.pr.state === "closed" ||
        active.has(record.path) ||
        (record.retryAt && record.retryAt > Date.now())
      )
        continue;
      try {
        const pr = await refresh(record);
        changed();
        if (pr.state === "merged" && pr.cleanup && !record.autoFinished) {
          const all = records();
          if (all[record.path]) {
            all[record.path].autoFinished = true;
            save(prFile(), all);
          }
          await shipFinish(record);
        }
      } catch {
        const all = records();
        if (all[record.path]) {
          all[record.path].retryAt = Date.now() + 300_000;
          save(prFile(), all);
        }
      }
    }
  } finally {
    watching = false;
  }
}
export function startShipWatcher(onChanged: () => void) {
  changed = onChanged;
  recover();
  if (!timer) {
    timer = setInterval(() => {
      void refreshShipPrs();
    }, 60_000);
    timer.unref();
  }
}
export function stopShipWatcher() {
  clearInterval(timer);
  timer = undefined;
}
