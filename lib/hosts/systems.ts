import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  EffortCleanupPreview,
  EffortPlan,
  EffortRecord,
  SystemDefinition,
  SystemRecord,
  SystemsRequest,
  SystemsResult,
} from "../api-contracts/systems";
import { resolveGithubRepo } from "../github-repo";
import { getAgentDir } from "../omp/paths";
import { createGitEnvironment } from "../project-command-env";
import type { WorkspaceCreationJob } from "../workspace-creation-types";
import { HostOpError } from "./link-protocol";
import {
  canonicalRepoPath,
  readHierarchy,
  registerCreatedWorkspace,
  registerEffortRoot,
  registerSystemRepo,
  unregisterDeletedWorkspace,
  unregisterEffortRoot,
  updateWorkspaceSetup,
} from "./project-hierarchy";
import { sessionOps } from "./session-ops";
import type { TerminalManager } from "./terminals";
import {
  removeRegisteredWorktree,
  resolvePullRequest,
  runEffortWorkspaceJob,
  workspaceBranches,
  workspaceGit as git,
  workspaceSetupPlan,
  type WorkspaceDeletionAdapter,
  type WorkspaceSetupPlan,
} from "./workspace-creation";
import { copyPaseoIncludes } from "./workspace-paseo";

export type SystemsRuntime = {
  terminals: TerminalManager;
  processes: WorkspaceDeletionAdapter;
  sessionsChanged: () => void;
};

type Stage = WorkspaceCreationJob["stage"];
type Member = EffortRecord["members"][number] & {
  setup: WorkspaceSetupPlan;
  repoIdentity: string;
  directoryIdentity?: string;
  gitIdentity?: string;
  next: number;
  inFlight?: boolean;
  checkoutStarted?: boolean;
  included?: boolean;
  blockingDone?: boolean;
  removing?: boolean;
};
type Effort = Omit<EffortRecord, "members" | "sessionIds"> & {
  members: Member[];
  rootIdentity?: string;
  docsWritten?: boolean;
  instructions: string;
  servicesAdmitted?: boolean;
};
type State = { root?: string; systems: SystemRecord[]; efforts: Effort[] };
type PlanInput = Extract<SystemsRequest, { action: "preview" | "create" }>;

const jobs = new Map<string, Promise<void>>();
const busy = new Set<string>();
const setupStopping = new Set<string>();
const exec = promisify(execFile);
const stateFile = () => path.join(getAgentDir(), "keylime", "systems.json");
const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const conflict = (code: string, message: string) =>
  new HostOpError(409, code, message);
const invalid = (message: string) =>
  new HostOpError(400, "invalid_request", message);
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function load(): State {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as State;
    if (!Array.isArray(state.systems) || !Array.isArray(state.efforts))
      throw new Error("Invalid Systems state");
    return state;
  } catch (error) {
    if (missing(error)) return { systems: [], efforts: [] };
    throw error;
  }
}
function save(state: State) {
  const target = stateFile();
  const temp = `${target}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function checkpoint(effort: Effort) {
  const state = load();
  const index = state.efforts.findIndex(({ id }) => id === effort.id);
  if (index < 0) state.efforts.push(effort);
  else state.efforts[index] = effort;
  save(state);
}
function lstat(value: string) {
  try {
    return fs.lstatSync(value, { bigint: true });
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
function canonical(value: string): string {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(absolute);
    return parent === absolute
      ? absolute
      : path.join(canonical(parent), path.basename(absolute));
  }
}
function within(root: string, child: string) {
  const relative = path.relative(root, child);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function ownsPath(effort: Effort, value: string, resolved: string): boolean {
  return [effort.root, ...effort.members.map((member) => member.path)].some(
    (root) => within(root, value) || within(root, resolved),
  );
}
function matchingEffort(value: string, matches: (effort: Effort) => boolean) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  const state = load();
  const efforts = state.efforts.filter(matches);
  if (!efforts.length) return false;
  const absolute = path.resolve(value);
  let resolved = absolute;
  try {
    resolved = canonical(absolute);
  } catch {
    /* still fence the recorded path */
  }
  return efforts.some((effort) => ownsPath(effort, absolute, resolved));
}
export function isEffortPath(value: string): boolean {
  return matchingEffort(value, (effort) => effort.status !== "cleaned");
}
export function isEffortCleaningPath(value: string): boolean {
  return matchingEffort(
    value,
    (effort) =>
      effort.status === "cleaning" || effort.status === "cleanup_failed",
  );
}
export function isEffortRepo(value: string): boolean {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  const absolute = path.resolve(value);
  let resolved = absolute;
  try {
    resolved = canonical(absolute);
  } catch {
    /* still protect the recorded Repo */
  }
  const state = load();
  const same = (repoPath: string) =>
    repoPath === absolute || repoPath === resolved;
  return (
    state.systems.some((system) => system.repoPaths.some(same)) ||
    state.efforts.some(
      (effort) =>
        effort.status !== "cleaned" &&
        effort.members.some((member) => same(member.repoPath)),
    )
  );
}
export function systemsBusy(): boolean {
  return busy.size > 0;
}
export async function waitForSystemsSetup(): Promise<void> {
  await Promise.allSettled(jobs.values());
}
export async function stopSystems(): Promise<void> {
  for (const id of jobs.keys()) setupStopping.add(id);
  await waitForSystemsSetup();
}
function systemFor(state: State, id: string): SystemRecord {
  const system = state.systems.find((entry) => entry.id === id);
  if (!system)
    throw new HostOpError(404, "system_not_found", "System not found");
  return system;
}
function effortFor(state: State, id: string): Effort {
  const effort = state.efforts.find((entry) => entry.id === id);
  if (!effort)
    throw new HostOpError(404, "effort_not_found", "Effort not found");
  return effort;
}
function nameOf(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name))
    throw invalid("Use a name of 1–120 characters without control characters");
  return name;
}
function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
}
function slugFor(name: string) {
  const slug = slugOf(name);
  if (!slug)
    throw invalid(
      "Use a name containing letters or digits that can form a Git branch",
    );
  return slug;
}
function rootOf(state: State): string {
  return (
    state.root ??
    canonical(path.join(os.homedir(), "workspace", "keylime-worktrees"))
  );
}
function setRoot(state: State, value: string) {
  const expanded = value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : value;
  if (!path.isAbsolute(expanded) || /[\u0000\r\n]/.test(expanded))
    throw invalid("Use an absolute worktrees root or a path starting with ~/");
  const resolved = canonical(expanded);
  if (
    isEffortPath(resolved) ||
    (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory())
  )
    throw invalid(
      "Worktrees root must be a directory outside existing Efforts",
    );
  state.root = resolved;
  save(state);
}
function saveSystem(
  state: State,
  input: Extract<SystemsRequest, { action: "saveSystem" }>,
) {
  const definition = input.definition;
  const previous =
    input.id === undefined ? undefined : systemFor(state, input.id);
  const name = nameOf(definition.name);
  const slug = previous?.slug ?? slugFor(name);
  if (
    state.systems.some(
      (system) => system.slug === slug && system.id !== previous?.id,
    )
  )
    throw conflict("system_exists", `A System already uses the slug ${slug}`);
  if (!definition.repoPaths.length) throw invalid("Select at least one Repo");
  const repoPaths = definition.repoPaths.map((value) => {
    try {
      return canonicalRepoPath(value);
    } catch (error) {
      throw invalid(`${value}: ${reason(error)}`);
    }
  });
  if (new Set(repoPaths).size !== repoPaths.length)
    throw invalid("Select each Repo only once");
  const ids = new Set<string>();
  const names = new Set<string>();
  const services: SystemDefinition["services"] = definition.services.map(
    (service) => {
      const serviceName = nameOf(service.name);
      if (
        !service.id.trim() ||
        service.id.length > 120 ||
        /[\u0000-\u001f\u007f]/.test(service.id) ||
        !service.command.trim() ||
        service.command.includes("\0") ||
        ids.has(service.id) ||
        names.has(serviceName.toLowerCase())
      )
        throw invalid(
          "Each service needs a unique ID, a unique name, and a command",
        );
      ids.add(service.id);
      names.add(serviceName.toLowerCase());
      return { id: service.id, name: serviceName, command: service.command };
    },
  );
  for (const repoPath of repoPaths) registerSystemRepo(repoPath);
  const record = {
    id: previous?.id ?? randomUUID(),
    name,
    slug,
    repoPaths,
    services,
    instructions: definition.instructions,
    archived: previous?.archived ?? false,
  };
  if (previous) state.systems[state.systems.indexOf(previous)] = record;
  else state.systems.push(record);
  save(state);
}
function directoryIdentity(value: string): string | undefined {
  const stat = lstat(value);
  if (!stat) return undefined;
  if (!stat.isDirectory() || fs.realpathSync(value) !== value)
    throw conflict(
      "effort_path_changed",
      `Not the expected directory: ${value}`,
    );
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
function requireDirectory(value: string, expected: string | undefined): string {
  const actual = directoryIdentity(value);
  if (!actual || actual !== expected)
    throw conflict(
      "effort_path_changed",
      `Directory changed or disappeared: ${value}`,
    );
  return actual;
}
async function gitDirectory(
  cwd: string,
  option: "--git-dir" | "--git-common-dir",
) {
  const result = fs.realpathSync(
    (await git(cwd, ["rev-parse", "--path-format=absolute", option])).trimEnd(),
  );
  return { path: result, identity: `${result}:${directoryIdentity(result)}` };
}
async function validateRepo(repoPath: string, expected?: string) {
  if (canonicalRepoPath(repoPath) !== repoPath)
    throw conflict("effort_repo_changed", `Repo checkout changed: ${repoPath}`);
  const identity = (await gitDirectory(repoPath, "--git-common-dir")).identity;
  if (expected && expected !== identity)
    throw conflict("effort_repo_changed", `Repo checkout changed: ${repoPath}`);
  return identity;
}
async function baseFor(
  repoPath: string,
  ref: string,
): Promise<{ baseRef: string; baseCommit: string }> {
  if (!ref || ref.startsWith("-") || /[\u0000-\u0020\u007f]/.test(ref))
    throw invalid(`No valid base ref for ${repoPath}`);
  if (/^refs\/pull\/[1-9]\d*\/head$/.test(ref))
    return {
      baseRef: ref,
      baseCommit: await resolvePullRequest(repoPath, ref),
    };
  const commit = (candidate: string) =>
    git(repoPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${candidate}^{commit}`,
    ]).then((output) => output.trim());
  if (/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(ref)) {
    const baseCommit = await commit(ref).catch(() => "");
    if (baseCommit) return { baseRef: ref, baseCommit };
  } else {
    const candidates = ref.startsWith("refs/")
      ? [ref]
      : ["heads", "remotes", "tags"].map((kind) => `refs/${kind}/${ref}`);
    const valid = (
      await Promise.all(
        candidates.map(async (baseRef) => {
          if (!/^refs\/(?:heads|remotes|tags)\//.test(baseRef)) return null;
          try {
            await git(repoPath, ["check-ref-format", baseRef]);
            return { baseRef, baseCommit: await commit(baseRef) };
          } catch {
            return null;
          }
        }),
      )
    ).filter((candidate) => candidate !== null);
    if (valid.length === 1) return valid[0];
    if (valid.length > 1)
      throw invalid(
        `Base ${ref} is ambiguous in ${repoPath}. Select a full ref.`,
      );
  }
  throw invalid(`Base ${ref} does not resolve to a commit in ${repoPath}`);
}
async function checkBranch(repoPath: string, branch: string) {
  try {
    await git(repoPath, ["check-ref-format", "--branch", branch]);
  } catch {
    throw invalid(`Invalid Git branch: ${branch}`);
  }
  const refs = (
    await git(repoPath, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ])
  )
    .trimEnd()
    .split("\n");
  const full = `refs/heads/${branch}`;
  if (
    refs.some(
      (ref) =>
        ref === full ||
        ref.startsWith(`${full}/`) ||
        (ref.startsWith("refs/heads/") && full.startsWith(`${ref}/`)) ||
        (ref.startsWith("refs/remotes/") && ref.endsWith(`/${branch}`)),
    )
  )
    throw conflict(
      "effort_branch_exists",
      `Branch ${branch} already exists or conflicts with a ref in ${repoPath}`,
    );
}
function checkTarget(state: State, target: string) {
  if (
    canonical(target) !== target ||
    lstat(target) ||
    state.efforts.some(
      (effort) =>
        effort.status !== "cleaned" &&
        (within(effort.root, target) || within(target, effort.root)),
    )
  )
    throw conflict(
      "effort_path_exists",
      `Effort target already exists: ${target}`,
    );
  const overlaps = readHierarchy().projects.some((project) =>
    project.workspaces.some(
      (workspace) =>
        within(target, workspace.path) ||
        (project.kind === "git" && within(workspace.path, target)),
    ),
  );
  if (overlaps)
    throw conflict(
      "effort_path_exists",
      `Effort target overlaps a registered checkout: ${target}`,
    );
  for (
    let directory = path.dirname(target);
    directory !== path.dirname(directory);
    directory = path.dirname(directory)
  )
    if (lstat(path.join(directory, ".git")))
      throw conflict(
        "effort_path_exists",
        `Effort target is inside a Git checkout: ${target}`,
      );
}
async function prepare(state: State, input: PlanInput) {
  const system = systemFor(state, input.systemId);
  if (system.archived)
    throw conflict(
      "system_archived",
      "Restore this System before creating an Effort",
    );
  const name = nameOf(input.name);
  const slug = slugFor(name);
  const configuredRoot = rootOf(state);
  const root = path.join(configuredRoot, system.slug, slug);
  checkTarget(state, root);
  const branch = `${system.slug}/${slug}`;
  if (
    state.efforts.some(
      (effort) => effort.status !== "cleaned" && effort.branch === branch,
    )
  )
    throw conflict(
      "effort_branch_exists",
      `An Effort already uses branch ${branch}`,
    );
  const selected = new Map<string, string>();
  for (const { repoPath, ref } of input.bases ?? []) {
    if (!system.repoPaths.includes(repoPath) || selected.has(repoPath))
      throw invalid("Choose at most one base per System Repo");
    selected.set(repoPath, ref);
  }
  const names = new Set<string>();
  const repos = readHierarchy().projects;
  const members = await Promise.all(
    system.repoPaths.map(async (repoPath) => {
      const project = repos.find((repo) => repo.path === repoPath);
      if (!project)
        throw conflict(
          "effort_repo_changed",
          `Repo is no longer registered: ${repoPath}`,
        );
      const stem = slugOf(path.basename(repoPath)) || "repo";
      let directory = stem;
      for (let suffix = 2; names.has(directory); suffix++)
        directory = `${stem}-${suffix}`;
      names.add(directory);
      const target = path.join(root, directory);
      const [repoIdentity, branches, setup] = await Promise.all([
        validateRepo(repoPath),
        workspaceBranches(repoPath, { localOnly: true }),
        workspaceSetupPlan(repoPath),
        checkBranch(repoPath, branch),
      ]);
      const base = await baseFor(
        repoPath,
        selected.get(repoPath) ?? branches.defaultRef,
      );
      const skipsCustomCreate = setup.pipeline.create.length > 0;
      const plan = {
        repoPath,
        name: project.name,
        path: target,
        ...base,
        skipsCustomCreate,
        branches,
      };
      return {
        plan,
        setup: { ...setup, pipeline: { ...setup.pipeline, create: [] } },
        repoIdentity,
      };
    }),
  );
  const definition = { systemId: system.id, name, slug, root, branch };
  const confirmation = fingerprint([
    system,
    configuredRoot,
    definition,
    members.map(({ plan: { branches: _branches, ...plan }, ...pinned }) => [
      plan,
      pinned,
    ]),
  ]);
  const preview: EffortPlan = {
    ...definition,
    members: members.map(({ plan }) => plan),
    confirmation,
  };
  return { preview, members, system, configuredRoot };
}

async function worktreeFields(member: Member) {
  const output = await git(member.repoPath, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  return output
    .split("\0\0")
    .map((entry) => entry.split("\0"))
    .find((fields) => fields[0] === `worktree ${member.path}`);
}
async function verifyWorktree(effort: Effort, member: Member): Promise<string> {
  requireDirectory(effort.root, effort.rootIdentity);
  requireDirectory(member.path, member.directoryIdentity);
  await validateRepo(member.repoPath, member.repoIdentity);
  const branch = `branch refs/heads/${effort.branch}`;
  const fields = await worktreeFields(member);
  if (
    !fields?.includes(branch) ||
    fields.some((field) => field.startsWith("prunable")) ||
    (!member.gitIdentity && !fields.includes(`HEAD ${member.baseCommit}`))
  )
    throw conflict(
      "effort_checkout_changed",
      `Unexpected Git worktree or branch: ${member.path}`,
    );
  const [common, checkout] = await Promise.all([
    gitDirectory(member.path, "--git-common-dir"),
    gitDirectory(member.path, "--git-dir"),
  ]);
  if (
    common.identity !== member.repoIdentity ||
    checkout.path === common.path ||
    !within(path.join(common.path, "worktrees"), checkout.path) ||
    (member.gitIdentity && member.gitIdentity !== checkout.identity)
  )
    throw conflict(
      "effort_checkout_changed",
      `Git worktree was replaced: ${member.path}`,
    );
  requireDirectory(member.path, member.directoryIdentity);
  requireDirectory(effort.root, effort.rootIdentity);
  return checkout.identity;
}
function generatedFiles(effort: Effort) {
  const instructions = effort.instructions;
  const agents = `${instructions}${instructions ? (instructions.endsWith("\n") ? "\n" : "\n\n") : ""}See [repomap.md](repomap.md) for the repositories in this Effort.\n`;
  const cell = (value: string) =>
    value.replace(/\r?\n/g, " ").replace(/[\\|`]/g, "\\$&");
  const map = [
    "# Repos in this Effort",
    "",
    "| Repo | Path | Branch | Base |",
    "| --- | --- | --- | --- |",
    ...effort.members.map(
      (member) =>
        `| ${cell(member.name)} | ${cell(path.relative(effort.root, member.path))} | ${cell(effort.branch)} | ${cell(member.baseRef)} |`,
    ),
    "",
  ].join("\n");
  return [
    ["AGENTS.md", agents],
    ["repomap.md", map],
  ] as const;
}
function publishRoot(effort: Effort) {
  if (!effort.rootIdentity) {
    if (canonical(effort.root) !== effort.root || lstat(effort.root))
      throw conflict(
        "effort_path_exists",
        `Effort root already exists: ${effort.root}`,
      );
    fs.mkdirSync(path.dirname(effort.root), { recursive: true });
    fs.mkdirSync(effort.root);
    effort.rootIdentity = directoryIdentity(effort.root);
    checkpoint(effort);
  }
  requireDirectory(effort.root, effort.rootIdentity);
  if (!effort.docsWritten) {
    for (const [filename, contents] of generatedFiles(effort)) {
      try {
        fs.writeFileSync(path.join(effort.root, filename), contents, {
          flag: "wx",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    effort.docsWritten = true;
    checkpoint(effort);
  }
  registerEffortRoot(effort.root, effort.name);
}
function ensureSetupRunning(effort: Effort) {
  if (setupStopping.has(effort.id))
    throw new Error("Daemon stopped during setup");
}
function workspaceProgress(job: WorkspaceCreationJob) {
  return {
    status: job.status,
    jobId: job.id,
    stage: job.stage,
    error: job.error,
  };
}
async function setupMember(
  effort: Effort,
  member: Member,
  nonBlocking: boolean,
) {
  const { pipeline, source, paseo } = member.setup;
  const job: WorkspaceCreationJob = {
    id: randomUUID(),
    input: {
      projectPath: member.repoPath,
      branch: effort.branch,
      name: effort.name,
      mode: "new",
      baseRef: member.baseRef,
    },
    pipeline,
    source,
    ...(paseo?.fingerprint
      ? { paseo: { path: paseo.path, fingerprint: paseo.fingerprint } }
      : {}),
    status: "running",
    stage: nonBlocking
      ? "postNonBlocking"
      : member.gitIdentity
        ? "postBlocking"
        : "pre",
    logs: member.skipsCustomCreate
      ? "Skipping custom create command for Effort worktree.\n"
      : "",
  };
  member.status = "running";
  member.jobId = job.id;
  member.stage = job.stage;
  delete member.error;
  checkpoint(effort);
  try {
    await runEffortWorkspaceJob(job, member.path, paseo, async (run) => {
      const commands = async (stage: Stage, list: string[], cwd: string) => {
        job.stage = member.stage = stage;
        if (job.workspaceId)
          updateWorkspaceSetup(job.workspaceId, workspaceProgress(job));
        while (member.next < list.length) {
          ensureSetupRunning(effort);
          if (stage === "pre")
            await validateRepo(member.repoPath, member.repoIdentity);
          else await verifyWorktree(effort, member);
          ensureSetupRunning(effort);
          member.inFlight = true;
          checkpoint(effort);
          try {
            await run(list[member.next], cwd);
          } catch (error) {
            if (!setupStopping.has(effort.id)) member.inFlight = false;
            throw error;
          }
          member.inFlight = false;
          member.next++;
          checkpoint(effort);
        }
      };
      requireDirectory(effort.root, effort.rootIdentity);
      await validateRepo(member.repoPath, member.repoIdentity);
      if (!nonBlocking && !member.checkoutStarted) {
        await commands("pre", pipeline.pre, member.repoPath);
        ensureSetupRunning(effort);
        requireDirectory(effort.root, effort.rootIdentity);
        fs.mkdirSync(member.path);
        member.directoryIdentity = directoryIdentity(member.path);
        member.checkoutStarted = true;
        member.next = 0;
        job.stage = member.stage = "create";
        checkpoint(effort);
      }
      let created = false;
      if (!member.gitIdentity && !(await worktreeFields(member))) {
        requireDirectory(member.path, member.directoryIdentity);
        if (fs.readdirSync(member.path).length)
          throw conflict(
            "effort_checkout_changed",
            `Unexpected files at ${member.path}`,
          );
        await checkBranch(member.repoPath, effort.branch);
        await validateRepo(member.repoPath, member.repoIdentity);
        ensureSetupRunning(effort);
        requireDirectory(effort.root, effort.rootIdentity);
        requireDirectory(member.path, member.directoryIdentity);
        await git(member.repoPath, [
          "worktree",
          "add",
          "-b",
          effort.branch,
          "--",
          member.path,
          member.baseCommit,
        ]);
        created = true;
      }
      const gitIdentity = await verifyWorktree(effort, member);
      if (
        !created &&
        !member.gitIdentity &&
        (await dirtyPaths(member.path)).paths.length
      )
        throw conflict(
          "effort_checkout_uncertain",
          `Worktree creation was interrupted and ${member.path} has changes. Review them before retrying.`,
        );
      member.gitIdentity = gitIdentity;
      job.workspacePath = member.path;
      job.stage = member.stage = nonBlocking
        ? "postNonBlocking"
        : "postBlocking";
      checkpoint(effort);
      job.workspaceId = registerCreatedWorkspace(
        member.repoPath,
        member.path,
        effort.branch,
        workspaceProgress(job),
        effort.name,
      ).id;
      if (paseo && !member.included) {
        ensureSetupRunning(effort);
        copyPaseoIncludes(member.repoPath, member.path, paseo);
        member.included = true;
        checkpoint(effort);
      }
      await commands(
        job.stage,
        nonBlocking ? pipeline.postNonBlocking : pipeline.postBlocking,
        member.path,
      );
      await verifyWorktree(effort, member);
      member.next = 0;
      if (!nonBlocking) member.blockingDone = true;
      member.status =
        nonBlocking || !pipeline.postNonBlocking.length
          ? "complete"
          : "pending";
    });
  } catch (error) {
    member.status =
      member.inFlight || setupStopping.has(effort.id)
        ? "interrupted"
        : "failed";
    member.error = member.inFlight
      ? `Setup command outcome is unknown. Review the checkout before retrying. ${reason(error)}`
      : reason(error);
    throw error;
  } finally {
    if (job.workspaceId)
      updateWorkspaceSetup(job.workspaceId, {
        ...workspaceProgress(job),
        status:
          member.inFlight || setupStopping.has(effort.id)
            ? "interrupted"
            : job.status,
        error: member.error,
      });
    checkpoint(effort);
  }
}
async function setService(
  effort: Effort,
  service: EffortRecord["services"][number],
  operation: "start" | "stop" | "restart",
  runtime: SystemsRuntime,
) {
  try {
    if (
      operation === "start" &&
      service.terminalId &&
      runtime.terminals.isRunning(service.terminalId)
    )
      return;
    if (operation !== "stop") {
      if (
        !effort.members.every((member) => member.blockingDone) ||
        effort.status === "cleaning" ||
        effort.status === "cleanup_failed" ||
        effort.status === "cleaned"
      )
        throw conflict(
          "effort_not_ready",
          "Finish blocking setup before starting services",
        );
      requireDirectory(effort.root, effort.rootIdentity);
      for (const member of effort.members) await verifyWorktree(effort, member);
    }
    if (service.terminalId && runtime.terminals.has(service.terminalId))
      await runtime.terminals.close(service.terminalId);
    delete service.terminalId;
    delete service.error;
    service.status = "stopped";
    if (operation !== "stop") {
      const terminal = await runtime.terminals.startService({
        cwd: effort.root,
        command: service.command,
        env: {
          KEYLIME_SYSTEM_ID: effort.systemId,
          KEYLIME_SYSTEM_NAME: effort.systemName,
          KEYLIME_EFFORT_ID: effort.id,
          KEYLIME_EFFORT_NAME: effort.name,
          KEYLIME_EFFORT_ROOT: effort.root,
          KEYLIME_SERVICE_ID: service.id,
          KEYLIME_SERVICE_NAME: service.name,
        },
      });
      service.terminalId = terminal.id;
      service.status = "running";
    }
  } catch (error) {
    service.error = reason(error);
  } finally {
    checkpoint(effort);
  }
}
function launchSetup(effort: Effort, runtime: SystemsRuntime) {
  effort.status = "creating";
  delete effort.error;
  checkpoint(effort);
  busy.add(effort.id);
  const task = Promise.resolve().then(async () => {
    try {
      ensureSetupRunning(effort);
      publishRoot(effort);
      for (const member of effort.members) {
        ensureSetupRunning(effort);
        if (member.blockingDone) await verifyWorktree(effort, member);
        else {
          try {
            await setupMember(effort, member, false);
          } catch {
            /* Recorded on the member. Other Repos can still make progress. */
          }
        }
      }
      ensureSetupRunning(effort);
      if (
        effort.members.every((member) => member.blockingDone) &&
        !effort.servicesAdmitted
      ) {
        // Never replay auto-start after a daemon restart, even if it stopped mid-launch.
        effort.servicesAdmitted = true;
        checkpoint(effort);
        for (const service of effort.services) {
          ensureSetupRunning(effort);
          await setService(effort, service, "start", runtime);
        }
      }
      for (const member of effort.members) {
        ensureSetupRunning(effort);
        if (member.blockingDone && member.status !== "complete") {
          try {
            await setupMember(effort, member, true);
          } catch {
            /* Recorded on the member. */
          }
        }
      }
      effort.status = effort.members.every(
        (member) => member.status === "complete",
      )
        ? "ready"
        : "failed";
    } catch (error) {
      effort.status = "failed";
      effort.error = reason(error);
    } finally {
      try {
        checkpoint(effort);
      } finally {
        jobs.delete(effort.id);
        busy.delete(effort.id);
        setupStopping.delete(effort.id);
      }
    }
  });
  jobs.set(effort.id, task);
  void task.catch((error) =>
    console.error(`Failed to persist Effort ${effort.id}: ${reason(error)}`),
  );
}
function recover(state: State) {
  let changed = false;
  for (const effort of state.efforts) {
    if (busy.has(effort.id)) continue;
    if (effort.status === "creating") {
      changed = true;
      effort.status = "failed";
      effort.error =
        "Daemon restarted during setup. Review member progress before retrying.";
      for (const member of effort.members)
        if (member.status === "running") {
          member.status = "interrupted";
          member.error = member.inFlight
            ? "Setup command outcome is unknown. Review the checkout before retrying."
            : "Daemon stopped during setup";
        }
    } else if (effort.status === "cleaning") {
      changed = true;
      effort.status = "cleanup_failed";
      effort.error =
        "Daemon restarted during cleanup. Review what remains before resuming.";
    }
  }
  if (changed) save(state);
}
async function dirtyPaths(cwd: string) {
  const entries = (
    await git(cwd, [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      // Git's clean worktree removal can still delete ignored local data.
      "--ignored=matching",
    ])
  )
    .split("\0")
    .filter(Boolean);
  const names = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    names.add(entries[i].slice(3));
    if (/[RC]/.test(entries[i].slice(0, 2)) && entries[i + 1])
      names.add(entries[++i]);
  }
  return { paths: [...names].sort(), entries };
}
async function publication(cwd: string, branch: string, head: string) {
  const remotes = (await git(cwd, ["remote"]))
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!remotes.length) return "No remotes configured";
  const results = await Promise.all(
    remotes.map(async (remote) => {
      const ref = `refs/heads/${branch}`;
      try {
        const advertised = (
          await git(cwd, ["ls-remote", "--heads", "--", remote, ref], 8_000)
        ).trim();
        const found = advertised
          .split("\n")
          .find((entry) => entry.endsWith(`\t${ref}`));
        if (!found) return null;
        return found.startsWith(`${head}\t`)
          ? `Published on ${remote}`
          : `Published on ${remote} (different commit)`;
      } catch {
        return `Publication unavailable on ${remote}`;
      }
    }),
  );
  return (
    results.filter(Boolean).join("; ") || "Not published on configured remotes"
  );
}
async function openPrs(cwd: string, branch: string): Promise<string[]> {
  const repo = await resolveGithubRepo(cwd);
  if (!repo) return [];
  try {
    const { stdout } = await exec(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "url",
      ],
      {
        cwd,
        timeout: 8_000,
        env: createGitEnvironment({ GH_PROMPT_DISABLED: "1" }),
      },
    );
    return (JSON.parse(stdout) as Array<{ url: string }>)
      .map(({ url }) => url)
      .sort();
  } catch {
    return ["Open PR lookup unavailable"];
  }
}
async function cleanupPreview(
  effort: Effort,
  runtime: SystemsRuntime,
): Promise<EffortCleanupPreview> {
  const processes = (await runtime.processes.inspect(effort.root))
    .map(({ id, cwd }) => `${id} (${cwd})`)
    .sort();
  const members = await Promise.all(
    effort.members
      .filter((member) => member.status !== "removed")
      .map(async (member) => {
        const empty = { path: member.path, dirty: [], openPrs: [] };
        if (!lstat(member.path))
          return { report: { ...empty, publication: "Checkout not present" } };
        try {
          const identity = await verifyWorktree(effort, member);
          const [dirty, head] = await Promise.all([
            dirtyPaths(member.path),
            git(member.path, ["rev-parse", "HEAD"]).then((out) => out.trim()),
          ]);
          const [published, prs] = await Promise.all([
            publication(member.path, effort.branch, head),
            openPrs(member.path, effort.branch),
          ]);
          return {
            report: {
              path: member.path,
              dirty: dirty.paths,
              publication: published,
              openPrs: prs,
            },
            identity,
            head,
            index: dirty.entries,
          };
        } catch (error) {
          return { report: { ...empty, publication: reason(error) } };
        }
      }),
  );
  return {
    confirmation: fingerprint([
      effort.id,
      effort.rootIdentity,
      processes,
      members,
    ]),
    processes,
    repos: members.map(({ report }) => report),
  };
}
async function archiveEffortSessions(effort: Effort, runtime: SystemsRuntime) {
  const sessions = await sessionOps.listSessions();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const depth = (id: string) => {
    const seen = new Set<string>();
    let parent = byId.get(id)?.parentSessionId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      parent = byId.get(parent)?.parentSessionId;
    }
    return seen.size;
  };
  const owned = new Set(
    readHierarchy()
      .projects.flatMap((project) => project.workspaces)
      .filter((workspace) => within(effort.root, workspace.path))
      .flatMap((workspace) => workspace.sessionIds),
  );
  const ids = sessions
    .filter(
      (session) =>
        owned.has(session.id) ||
        (path.isAbsolute(session.cwd) &&
          within(effort.root, path.resolve(session.cwd))),
    )
    .map((session) => session.id)
    .sort((a, b) => depth(b) - depth(a));
  for (const id of ids) {
    const archived = await sessionOps.archiveSession(id);
    if (!archived.ok && archived.status !== 404)
      throw new Error(archived.error);
    if (archived.ok) runtime.sessionsChanged();
  }
}
async function removeMember(
  effort: Effort,
  member: Member,
  force: boolean,
  runtime: SystemsRuntime,
) {
  if (member.status === "removed") return;
  if (!lstat(member.path)) {
    if (
      member.checkoutStarted &&
      (!member.removing || (await worktreeFields(member)))
    )
      throw conflict(
        "effort_checkout_changed",
        `Checkout disappeared unexpectedly: ${member.path}`,
      );
    if (member.removing) unregisterDeletedWorkspace(member.path);
  } else if (
    member.checkoutStarted &&
    !member.gitIdentity &&
    !(await worktreeFields(member))
  ) {
    requireDirectory(effort.root, effort.rootIdentity);
    requireDirectory(member.path, member.directoryIdentity);
    if (fs.readdirSync(member.path).length)
      throw conflict(
        "effort_checkout_changed",
        `Unexpected files at ${member.path}`,
      );
    member.removing = true;
    checkpoint(effort);
    fs.rmdirSync(member.path);
  } else {
    member.gitIdentity = await verifyWorktree(effort, member);
    registerCreatedWorkspace(member.repoPath, member.path, effort.branch);
    member.removing = true;
    checkpoint(effort);
    const removed = await removeRegisteredWorktree(
      {
        projectPath: member.repoPath,
        path: member.path,
        stopProcesses: true,
        discardChanges: force,
        keepBranch: true,
      },
      undefined,
      {
        fencedRoot: effort.root,
        processes: runtime.processes,
        verify: async () => {
          await verifyWorktree(effort, member);
          if (!force && (await dirtyPaths(member.path)).paths.length)
            throw conflict(
              "effort_dirty",
              `Worktree has changes or local files: ${member.path}`,
            );
        },
      },
    );
    if (removed.status !== "deleted")
      throw conflict(
        "effort_cleanup_refused",
        `Could not remove ${member.path}: ${removed.status}`,
      );
  }
  member.status = "removed";
  delete member.error;
  checkpoint(effort);
}
function cleanRoot(effort: Effort) {
  if (!lstat(effort.root)) {
    unregisterEffortRoot(effort.root);
    return;
  }
  requireDirectory(effort.root, effort.rootIdentity);
  if (effort.docsWritten)
    for (const [name, expected] of generatedFiles(effort)) {
      const file = path.join(effort.root, name);
      const stat = lstat(file);
      const bytes = Buffer.from(expected);
      if (
        stat?.isFile() &&
        stat.size === BigInt(bytes.length) &&
        fs.readFileSync(file).equals(bytes)
      )
        fs.unlinkSync(file);
    }
  effort.retainedPaths = fs
    .readdirSync(effort.root)
    .sort()
    .map((name) => path.join(effort.root, name));
  if (!effort.retainedPaths.length) fs.rmdirSync(effort.root);
  unregisterEffortRoot(effort.root);
}
async function cleanup(
  effort: Effort,
  input: Extract<SystemsRequest, { action: "cleanup" }>,
  runtime: SystemsRuntime,
) {
  if (effort.status === "cleaned") return;
  if (lstat(effort.root)) requireDirectory(effort.root, effort.rootIdentity);
  const removal = input.mode !== "stop";
  const release = runtime.processes.fence(effort.root);
  try {
    const preview = await cleanupPreview(effort, runtime);
    if (preview.confirmation !== input.confirmation)
      throw conflict(
        "effort_preview_changed",
        "Cleanup information changed. Preview again before continuing.",
      );
    const dirty =
      input.mode === "remove" &&
      preview.repos.find((repo) => repo.dirty.length);
    if (dirty)
      throw conflict(
        "effort_dirty",
        `Worktree has changes or local files: ${dirty.path}`,
      );
    if (removal) {
      effort.status = "cleaning";
      delete effort.error;
      checkpoint(effort);
    }
    await runtime.processes.stop(effort.root);
    for (const service of effort.services) {
      if (service.terminalId && runtime.terminals.has(service.terminalId))
        await runtime.terminals.close(service.terminalId);
      service.status = "stopped";
      delete service.terminalId;
      delete service.error;
    }
    checkpoint(effort);
    if ((await runtime.processes.inspect(effort.root)).length)
      throw conflict(
        "processes_running",
        "Could not stop all Effort processes",
      );
    if (!removal) return;
    if (lstat(effort.root)) requireDirectory(effort.root, effort.rootIdentity);
    for (const member of effort.members) {
      if (member.status === "removed") continue;
      if (!lstat(member.path)) {
        if (
          member.checkoutStarted &&
          (!member.removing || (await worktreeFields(member)))
        )
          throw conflict(
            "effort_checkout_changed",
            `Checkout disappeared unexpectedly: ${member.path}`,
          );
        continue;
      }
      if (
        member.checkoutStarted &&
        !member.gitIdentity &&
        !(await worktreeFields(member))
      ) {
        requireDirectory(member.path, member.directoryIdentity);
        if (fs.readdirSync(member.path).length)
          throw conflict(
            "effort_checkout_changed",
            `Unexpected files at ${member.path}`,
          );
        continue;
      }
      await verifyWorktree(effort, member);
      if (
        input.mode === "remove" &&
        (await dirtyPaths(member.path)).paths.length
      )
        throw conflict(
          "effort_dirty",
          `Worktree has changes or local files: ${member.path}`,
        );
    }
    await archiveEffortSessions(effort, runtime);
    for (const member of effort.members) {
      try {
        await removeMember(effort, member, input.mode === "force", runtime);
      } catch (error) {
        member.error = reason(error);
        throw error;
      }
    }
    cleanRoot(effort);
    effort.status = "cleaned";
    checkpoint(effort);
  } catch (error) {
    if (!removal || effort.status !== "cleaning") throw error;
    effort.status = "cleanup_failed";
    effort.error = reason(error);
    checkpoint(effort);
  } finally {
    release();
  }
}
function result(runtime: SystemsRuntime): SystemsResult {
  const state = load();
  const workspaces = readHierarchy().projects.flatMap(
    (project) => project.workspaces,
  );
  return {
    root: rootOf(state),
    systems: state.systems,
    efforts: state.efforts.map(
      ({
        rootIdentity: _root,
        docsWritten: _docs,
        instructions: _instructions,
        servicesAdmitted: _admitted,
        ...effort
      }) => ({
        ...effort,
        members: effort.members.map(
          ({
            setup: _setup,
            repoIdentity: _repo,
            directoryIdentity: _dir,
            gitIdentity: _git,
            next: _next,
            inFlight: _flight,
            checkoutStarted: _started,
            included: _included,
            blockingDone: _blocking,
            removing: _removing,
            ...member
          }) => member,
        ),
        services: effort.services.map((service) => {
          if (!service.terminalId || !runtime.terminals.has(service.terminalId))
            return {
              ...service,
              terminalId: undefined,
              status: "stopped" as const,
            };
          return {
            ...service,
            status: runtime.terminals.isRunning(service.terminalId)
              ? ("running" as const)
              : ("exited" as const),
          };
        }),
        sessionIds:
          effort.status === "cleaned"
            ? []
            : [
                ...new Set(
                  workspaces
                    .filter((workspace) => within(effort.root, workspace.path))
                    .flatMap((workspace) => workspace.sessionIds),
                ),
              ],
      }),
    ),
  };
}

export async function systemsOperation(
  input: SystemsRequest,
  runtime: SystemsRuntime,
): Promise<SystemsResult> {
  const state = load();
  recover(state);
  switch (input.action) {
    case "list":
      break;
    case "setRoot":
      setRoot(state, input.root);
      break;
    case "saveSystem":
      saveSystem(state, input);
      break;
    case "archiveSystem": {
      systemFor(state, input.id).archived = input.archived;
      save(state);
      break;
    }
    case "preview":
      return {
        ...result(runtime),
        preview: (await prepare(state, input)).preview,
      };
    case "create": {
      const { preview, members, system, configuredRoot } = await prepare(
        state,
        input,
      );
      const current = load();
      if (
        preview.confirmation !== input.confirmation ||
        configuredRoot !== rootOf(current) ||
        fingerprint(systemFor(current, system.id)) !== fingerprint(system)
      )
        throw conflict(
          "effort_preview_changed",
          "System, setup, or starting commits changed. Preview the Effort again.",
        );
      checkTarget(current, preview.root);
      if (
        current.efforts.some(
          (effort) =>
            effort.status !== "cleaned" && effort.branch === preview.branch,
        )
      )
        throw conflict(
          "effort_branch_exists",
          `An Effort already uses branch ${preview.branch}`,
        );
      const effort: Effort = {
        id: randomUUID(),
        systemId: system.id,
        systemName: system.name,
        name: preview.name,
        slug: preview.slug,
        root: preview.root,
        branch: preview.branch,
        status: "creating",
        instructions: system.instructions,
        members: members.map(
          ({
            plan: { branches: _branches, ...plan },
            setup,
            repoIdentity,
          }) => ({ ...plan, setup, repoIdentity, next: 0, status: "pending" }),
        ),
        services: system.services.map((service) => ({
          ...service,
          status: "stopped",
        })),
      };
      launchSetup(effort, runtime);
      return { ...result(runtime), effortId: effort.id };
    }
    case "retry": {
      const effort = effortFor(state, input.effortId);
      if (busy.has(effort.id))
        throw conflict("effort_busy", "An Effort operation is already running");
      if (effort.status !== "failed")
        throw conflict(
          "effort_retry_unavailable",
          "Only an Effort with incomplete setup can retry",
        );
      launchSetup(effort, runtime);
      return { ...result(runtime), effortId: effort.id };
    }
    case "cleanupPreview": {
      const effort = effortFor(state, input.effortId);
      if (busy.has(effort.id))
        throw conflict("effort_busy", "An Effort operation is already running");
      const preview = await cleanupPreview(effort, runtime);
      return { ...result(runtime), cleanup: preview };
    }
    case "renameEffort":
    case "service":
    case "cleanup": {
      const effort = effortFor(state, input.effortId);
      if (busy.has(effort.id))
        throw conflict("effort_busy", "An Effort operation is already running");
      busy.add(effort.id);
      try {
        if (input.action === "renameEffort") {
          const name = nameOf(input.name);
          if (
            effort.rootIdentity &&
            effort.status !== "cleaned" &&
            effort.status !== "cleanup_failed"
          ) {
            requireDirectory(effort.root, effort.rootIdentity);
            registerEffortRoot(effort.root, name);
          }
          effort.name = name;
          checkpoint(effort);
        } else if (input.action === "service") {
          const service = effort.services.find(
            (entry) => entry.id === input.serviceId,
          );
          if (!service)
            throw new HostOpError(
              404,
              "service_not_found",
              "Service not found",
            );
          if (
            input.operation !== "stop" &&
            (!effort.members.every((member) => member.blockingDone) ||
              effort.status === "cleanup_failed" ||
              effort.status === "cleaned")
          )
            throw conflict(
              "effort_not_ready",
              "Finish blocking setup before starting services",
            );
          await setService(effort, service, input.operation, runtime);
        } else await cleanup(effort, input, runtime);
      } finally {
        busy.delete(effort.id);
      }
      break;
    }
  }
  return result(runtime);
}
