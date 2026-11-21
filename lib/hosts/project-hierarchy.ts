import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "../omp/paths";
import { listAllSessions } from "../session-reader";
import { applyProjectPresentation } from "../project-registry";
import { invalidateWorkspaceRoots } from "./workspace-roots";
import type {
  HierarchyProject,
  HierarchyRequest,
  HierarchySnapshot,
  HierarchyWorkspace,
} from "../project-hierarchy-types";
import type { OpResult } from "./session-ops";
import type { SessionInfo } from "../types";
import { isValidSessionId } from "../session-file-references-core";
import { workspaceShipState } from "./workspace-ship";
import { isEffortPath, isEffortRepo } from "./systems";

// Daemon-only metadata. Public hierarchy responses never contain these rows.
export type RegistryProject = HierarchyProject & {
  hidden?: true;
  effortRoot?: true;
};
type RegistrySnapshot = Omit<HierarchySnapshot, "projects"> & {
  projects: RegistryProject[];
};

function file(): string {
  return path.join(getAgentDir(), "hierarchy.json");
}
function canonical(value: string): string {
  const absolute = path.resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
function directory(value: string | undefined): string {
  if (!value || !path.isAbsolute(value))
    throw new Error("An absolute directory path is required");
  const result = realpathSync(value);
  if (!statSync(result).isDirectory())
    throw new Error("Path is not a directory");
  return result;
}
function within(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
const MAX_ICON_BYTES = 256 * 1024;
const MAX_ICON_CANDIDATES = 24;
const MAX_ICON_DEPTH = 5;
const MAX_ICON_ENTRIES = 2000;

function iconMime(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0) return "image/x-icon";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (/<svg(?:\s|\/?>)/i.test(text)) return "image/svg+xml";
  } catch {
    // Non-UTF-8 data is not an SVG image.
  }
  return undefined;
}

function validatedIcon(value: unknown): string {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_ICON_BYTES / 3) * 4 + 64)
    throw new Error("Invalid or oversized project icon");
  const match = /^data:(image\/(?:png|jpeg|gif|webp|x-icon|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error("Invalid project icon data URL");
  const data = Buffer.from(match[2], "base64");
  if (data.length > MAX_ICON_BYTES || data.toString("base64") !== match[2] || iconMime(data) !== match[1])
    throw new Error("Invalid or oversized project icon");
  return value;
}

function projectIcons(project: HierarchyProject): NonNullable<HierarchySnapshot["iconCandidates"]> {
  const root = realpathSync(project.path);
  const candidates: NonNullable<HierarchySnapshot["iconCandidates"]> = [];
  let examined = 0;
  let useGitIgnore = false;
  try {
    useGitIgnore = git(root, "rev-parse", "--is-inside-work-tree") === "true";
  } catch { /* Projects need not be Git repositories. */ }
  function scan(dir: string, depth: number): void {
    if (depth > MAX_ICON_DEPTH || examined >= MAX_ICON_ENTRIES || candidates.length >= MAX_ICON_CANDIDATES) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort().slice(0, MAX_ICON_ENTRIES - examined); } catch { return; }
    let ignored = new Set<string>();
    if (useGitIgnore && entries.length) {
      const paths = entries.map((name) => path.relative(root, path.join(dir, name)));
      try {
        const output = execFileSync("git", ["-C", root, "check-ignore", "-z", "--stdin"], {
          input: `${paths.join("\0")}\0`, encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
        });
        ignored = new Set(output.split("\0").filter(Boolean));
      } catch { /* No ignored paths, or Git is unavailable. */ }
    }
    for (const name of entries) {
      if (++examined > MAX_ICON_ENTRIES || candidates.length >= MAX_ICON_CANDIDATES) return;
      if (name.startsWith(".") || name === "node_modules" || name === "vendor" || name === "dist" || name === "release" || ignored.has(path.relative(root, path.join(dir, name)))) continue;
      const candidate = path.join(dir, name);
      try {
        const info = lstatSync(candidate);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) { scan(candidate, depth + 1); continue; }
        if (!info.isFile() || !/\.(?:png|jpe?g|gif|webp|ico|svg)$/i.test(name) || !/(?:^|[-_.])(?:favicon|icon|logo|apple-touch-icon)(?:$|[-_.])/i.test(name)) continue;
        const resolved = realpathSync(candidate);
        if (!within(root, resolved)) continue;
        const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ICON_BYTES) continue;
          const data = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < data.length) {
            const count = readSync(fd, data, offset, data.length - offset, offset);
            if (!count) break;
            offset += count;
          }
          if (offset !== data.length) continue;
          const mime = iconMime(data);
          if (mime) candidates.push({ path: path.relative(root, resolved), icon: `data:${mime};base64,${data.toString("base64")}` });
        } finally { closeSync(fd); }
      } catch { /* Files can disappear or be inaccessible during discovery. */ }
    }
  }
  scan(root, 0);
  return candidates;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const gitAsync = promisify(execFile);

function orderedRemotes(output: string): string[] {
  const remotes = output.trim().split("\n").filter(Boolean);
  return remotes.includes("origin")
    ? ["origin", ...remotes.filter((remote) => remote !== "origin")]
    : remotes;
}

export function defaultGitBranch(cwd: string): string | undefined {
  try {
    for (const remote of orderedRemotes(git(cwd, "remote"))) {
      try {
        const ref = git(
          cwd,
          "symbolic-ref",
          "--quiet",
          `refs/remotes/${remote}/HEAD`,
        );
        const prefix = `refs/remotes/${remote}/`;
        if (ref.startsWith(prefix) && ref.length > prefix.length)
          return ref.slice(prefix.length);
      } catch {
        // The remote may not have a cached symbolic HEAD.
      }
    }
  } catch {
    // Repositories can disappear or lose Git metadata between hierarchy loads.
  }
  return undefined;
}

export async function asyncDefaultGitBranch(
  cwd: string,
): Promise<string | undefined> {
  const options = { timeout: 10000 };
  try {
    const { stdout } = await gitAsync("git", ["-C", cwd, "remote"], options);
    for (const remote of orderedRemotes(stdout)) {
      try {
        const { stdout: ref } = await gitAsync(
          "git",
          ["-C", cwd, "symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
          options,
        );
        const prefix = `refs/remotes/${remote}/`;
        const branch = ref.trim();
        if (branch.startsWith(prefix) && branch.length > prefix.length)
          return branch.slice(prefix.length);
      } catch {
        // The remote may not have a cached symbolic HEAD.
      }
    }
  } catch {
    // Repositories can disappear or lose Git metadata between hierarchy loads.
  }
  return undefined;
}
function worktrees(
  project: HierarchyProject,
): { path: string; name: string; branch?: string; isDefault: boolean }[] {
  if (project.kind !== "git") return [];
  return gitWorktrees(project.path)
    .map((lines) => {
      const raw = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      if (!raw || isEffortPath(raw)) return null;
      const p = canonical(raw);
      const branch = lines
        .find((line) => line.startsWith("branch refs/heads/"))
        ?.slice(18);
      return {
        path: p,
        name: path.basename(p),
        branch,
        isDefault: p === project.path,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function gitWorktrees(cwd: string, limit?: number): string[][] {
  return git(cwd, "worktree", "list", "--porcelain", "-z")
    .split("\0\0", limit)
    .map((block) => block.split("\0"));
}

function primaryCheckout(cwd: string): string | undefined {
  const [primary] = gitWorktrees(cwd, 1);
  const location = primary?.[0];
  if (!location?.startsWith("worktree ") || primary.includes("bare"))
    return undefined;
  return location.slice(9);
}

function assertStandalonePath(value: string): void {
  if (isEffortPath(value))
    throw new Error("Effort paths cannot be registered in standalone Repos");
}

/** Resolve a System member selection without changing the registry. */
export function canonicalRepoPath(value: string): string {
  assertStandalonePath(value);
  const requested = directory(value);
  let primary: string | undefined;
  try {
    primary = primaryCheckout(requested);
  } catch {
    // A non-Git directory cannot be a System member.
  }
  if (!primary)
    throw new Error("A Git checkout with a primary worktree is required");
  assertStandalonePath(primary);
  return directory(primary);
}

export function readHierarchy(): RegistrySnapshot {
  try {
    const data = JSON.parse(readFileSync(file(), "utf8"));
    if (!data || !Array.isArray(data.projects))
      throw new Error("Invalid hierarchy registry");
    return { projects: data.projects };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { projects: [] };
    throw error;
  }
}
function save(snapshot: RegistrySnapshot): void {
  const target = file();
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ projects: snapshot.projects }), {
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  invalidateWorkspaceRoots();
}

function isStandaloneProject(project: RegistryProject): boolean {
  return !project.hidden && !isEffortPath(project.path);
}

function addProject(
  snapshot: RegistrySnapshot,
  root: string,
  kind: HierarchyProject["kind"],
  name = path.basename(root),
): RegistryProject {
  if (snapshot.projects.some((p) => p.workspaces.some((w) => w.path === root)))
    throw new Error("Path is already registered as a workspace");
  const id = randomUUID();
  const project: RegistryProject = {
    id,
    path: root,
    name,
    kind,
    addedAt: new Date().toISOString(),
    workspaces: [
      {
        id: randomUUID(),
        projectId: id,
        path: root,
        name,
        isDefault: true,
        sessionIds: [],
      },
    ],
  };
  snapshot.projects.push(project);
  return project;
}

export function registerSystemRepo(value: string): HierarchyProject {
  const root = canonicalRepoPath(value);
  const snapshot = readHierarchy();
  const existing = snapshot.projects.find((project) => project.path === root);
  if (existing) {
    if (existing.effortRoot)
      throw new Error("Path is registered as an Effort root");
    if (existing.kind !== "git") {
      existing.kind = "git";
      save(snapshot);
    }
    return existing;
  }
  const project = addProject(snapshot, root, "git");
  project.hidden = true;
  save(snapshot);
  return project;
}

export function registerEffortRoot(
  value: string,
  name: string,
): HierarchyWorkspace {
  const root = directory(value);
  const snapshot = readHierarchy();
  const existing = snapshot.projects.find((project) => project.path === root);
  if (existing) {
    if (!existing.effortRoot)
      throw new Error("Path is already registered as a Repo");
    const workspace = existing.workspaces[0];
    if (existing.name !== name || workspace.name !== name) {
      existing.name = name;
      workspace.name = name;
      save(snapshot);
    }
    return workspace;
  }
  const project = addProject(snapshot, root, "directory", name);
  project.hidden = true;
  project.effortRoot = true;
  save(snapshot);
  return project.workspaces[0];
}

export function unregisterEffortRoot(value: string): void {
  const root = canonical(value);
  const snapshot = readHierarchy();
  const index = snapshot.projects.findIndex(
    (project) => project.effortRoot && project.path === root,
  );
  if (index === -1) return;
  snapshot.projects.splice(index, 1);
  save(snapshot);
}

function projectById(
  snapshot: RegistrySnapshot,
  id?: string,
): RegistryProject {
  const project = snapshot.projects.find((p) => p.id === id);
  if (!project || !isStandaloneProject(project))
    throw new Error("Project not registered");
  return project;
}
function workspaceById(
  snapshot: RegistrySnapshot,
  id?: string,
): HierarchyWorkspace {
  const project = snapshot.projects.find((p) =>
    p.workspaces.some((w) => w.id === id),
  );
  const workspace = project?.workspaces.find((w) => w.id === id);
  if (
    !project ||
    !isStandaloneProject(project) ||
    !workspace ||
    isEffortPath(workspace.path)
  )
    throw new Error("Workspace not registered");
  return workspace;
}
function matchingWorkspace(
  snapshot: HierarchySnapshot,
  cwd: string,
): HierarchyWorkspace | undefined {
  const p = canonical(cwd);
  return snapshot.projects
    .flatMap((project) => project.workspaces)
    .filter((w) => within(w.path, p))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
function attach(
  snapshot: HierarchySnapshot,
  workspace: HierarchyWorkspace,
  id: string,
): void {
  if (!isValidSessionId(id)) throw new Error("Invalid session ID");
  for (const project of snapshot.projects)
    for (const other of project.workspaces)
      if (other.id !== workspace.id && other.sessionIds.includes(id))
        throw new Error("Session is already registered to another workspace");
  if (!workspace.sessionIds.includes(id)) workspace.sessionIds.push(id);
}
function addWorkspace(
  snapshot: HierarchySnapshot,
  project: HierarchyProject,
  value: string,
  branch?: string,
  setup?: HierarchyWorkspace["setup"],
): HierarchyWorkspace {
  const p = canonical(value);
  for (const other of snapshot.projects) {
    const found = other.workspaces.find((w) => w.path === p);
    if (found) {
      if (other.id !== project.id)
        throw new Error("Workspace belongs to another project");
      return found;
    }
  }
  if (project.kind !== "git")
    throw new Error("A directory project has exactly one workspace");
  const workspace: HierarchyWorkspace = {
    id: randomUUID(),
    projectId: project.id,
    path: p,
    name: path.basename(p),
    isDefault: false,
    branch,
    sessionIds: [],
    setup,
  };
  project.workspaces.push(workspace);
  return workspace;
}
export function registerCreatedWorkspace(
  projectPath: string,
  workspacePath: string,
  branch?: string,
  setup?: HierarchyWorkspace["setup"],
  name?: string,
): HierarchyWorkspace {
  const snapshot = readHierarchy();
  const project = snapshot.projects.find(
    (p) => p.path === canonical(projectPath),
  );
  if (!project) throw new Error("Project not registered");
  const workspace = addWorkspace(
    snapshot,
    project,
    directory(workspacePath),
    branch,
    setup,
  );
  if (name?.trim()) workspace.name = name.trim();
  save(snapshot);
  return workspace;
}
export function updateWorkspaceSetup(
  workspaceId: string,
  setup: HierarchyWorkspace["setup"],
): void {
  const snapshot = readHierarchy();
  const workspace = snapshot.projects
    .flatMap((project) => project.workspaces)
    .find((workspace) => workspace.id === workspaceId);
  if (workspace) {
    workspace.setup = setup;
    save(snapshot);
  }
}
export function unregisterDeletedWorkspace(value: string): void {
  const snapshot = readHierarchy();
  for (const project of snapshot.projects) {
    const workspace = project.workspaces.find(
      (w) => w.path === canonical(value),
    );
    if (workspace?.isDefault)
      throw new Error("Cannot unregister the default workspace");
    project.workspaces = project.workspaces.filter((w) => w !== workspace);
  }
  save(snapshot);
}
export function registerCreatedSession(cwd: string, id: string): void {
  const snapshot = readHierarchy();
  const workspace = matchingWorkspace(snapshot, cwd);
  if (!workspace)
    throw new Error("No registered workspace contains session cwd");
  attach(snapshot, workspace, id);
  save(snapshot);
}
export function moveRegisteredSession(from: string, to: string): void {
  if (from === to) return;
  const snapshot = readHierarchy();
  const workspace = snapshot.projects
    .flatMap((p) => p.workspaces)
    .find((w) => w.sessionIds.includes(from));
  if (!workspace) throw new Error("Session not registered");
  attach(snapshot, workspace, to);
  workspace.sessionIds = workspace.sessionIds.filter((id) => id !== from);
  save(snapshot);
}
export async function hierarchyOperation(
  input: HierarchyRequest,
): Promise<OpResult<HierarchySnapshot>> {
  try {
    if (!input || typeof input !== "object")
      throw new Error("Invalid hierarchy request");
    let sessions: SessionInfo[] = [];
    if (
      [
        "discoverSessions",
        "importSessions",
        "registerSession",
        "moveSession",
      ].includes(input.action)
    )
      sessions = await listAllSessions();
    const snapshot = readHierarchy();
    switch (input.action) {
      case "list":
        // Add Ship status to the public projection below.
        break;
      case "registerProject": {
        const value = input.path ?? input.cwd;
        if (value) assertStandalonePath(value);
        const requested = directory(value);
        let root = requested;
        let kind: HierarchyProject["kind"] = "directory";
        try {
          const primary = primaryCheckout(requested);
          if (primary) {
            root = primary;
            kind = "git";
          }
        } catch {
          /* not a git checkout */
        }
        assertStandalonePath(root);
        root = canonical(root);
        const existing = snapshot.projects.find((p) => p.path === root);
        if (existing) {
          if (existing.effortRoot)
            throw new Error("Path is registered as an Effort root");
          if (existing.hidden || (kind === "git" && existing.kind !== "git")) {
            delete existing.hidden;
            if (kind === "git") existing.kind = kind;
            save(snapshot);
          }
          snapshot.selectedProjectId = existing.id;
          break;
        }
        const project = addProject(snapshot, root, kind);
        snapshot.selectedProjectId = project.id;
        save(snapshot);
        break;
      }
      case "unregisterProject": {
        const project = projectById(snapshot, input.projectId);
        if (isEffortRepo(project.path)) project.hidden = true;
        else snapshot.projects = snapshot.projects.filter((p) => p !== project);
        save(snapshot);
        break;
      }
      case "updateProject": {
        const project = projectById(snapshot, input.projectId);
        Object.assign(project, applyProjectPresentation(project, input));
        for (const key of [
          "alias",
          "sortOrder",
          "pinOrder",
          "launchConfig",
        ] as const)
          if (input[key] === null) delete project[key];
        save(snapshot);
        break;
      }
      case "setProjectIcon": {
        const project = projectById(snapshot, input.projectId);
        if (input.icon === null) delete project.icon;
        else project.icon = validatedIcon(input.icon);
        save(snapshot);
        break;
      }
      case "listProjectIcons": {
        snapshot.iconCandidates = projectIcons(projectById(snapshot, input.projectId));
        break;
      }
      case "discoverWorkspaces": {
        const project = projectById(snapshot, input.projectId);
        snapshot.workspaceCandidates = worktrees(project).filter(
          (w) =>
            !snapshot.projects.some((p) =>
              p.workspaces.some((registered) => registered.path === w.path),
            ),
        );
        break;
      }
      case "importWorkspaces": {
        const project = projectById(snapshot, input.projectId);
        const candidates = worktrees(project);
        if (!Array.isArray(input.paths))
          throw new Error("Workspace paths required");
        for (const value of input.paths) {
          assertStandalonePath(value);
          const p = directory(value);
          const candidate = candidates.find((w) => w.path === p);
          if (!candidate)
            throw new Error("Path is not a worktree of this project");
          addWorkspace(snapshot, project, p, candidate.branch);
        }
        save(snapshot);
        break;
      }
      case "discoverSessions": {
        const workspace = workspaceById(snapshot, input.workspaceId);
        const registered = new Set(
          snapshot.projects.flatMap((p) =>
            p.workspaces.flatMap((w) => w.sessionIds),
          ),
        );
        snapshot.sessionCandidates = sessions.filter(
          (s) =>
            !registered.has(s.id) &&
            !isEffortPath(s.cwd) &&
            matchingWorkspace(snapshot, s.cwd)?.id === workspace.id,
        );
        break;
      }
      case "importSessions":
      case "registerSession": {
        const workspace = workspaceById(snapshot, input.workspaceId);
        const ids =
          input.action === "registerSession"
            ? [input.sessionId]
            : input.sessionIds;
        if (!Array.isArray(ids)) throw new Error("Session IDs required");
        for (const id of ids) {
          const session = sessions.find((s) => s.id === id);
          if (
            !session ||
            isEffortPath(session.cwd) ||
            matchingWorkspace(snapshot, session.cwd)?.id !== workspace.id
          )
            throw new Error("Session cwd does not belong to workspace");
          attach(snapshot, workspace, session.id);
        }
        save(snapshot);
        break;
      }
      case "unregisterSession": {
        const workspace = workspaceById(snapshot, input.workspaceId);
        workspace.sessionIds = workspace.sessionIds.filter(
          (id) => id !== input.sessionId,
        );
        save(snapshot);
        break;
      }
      case "moveSession": {
        if (!input.from || !input.to) throw new Error("Session IDs required");
        const workspace = snapshot.projects
          .flatMap((p) => p.workspaces)
          .find((w) => w.sessionIds.includes(input.from!));
        if (!workspace) throw new Error("Session not registered");
        workspaceById(snapshot, workspace.id);
        const session = sessions.find((s) => s.id === input.to);
        if (
          !session ||
          isEffortPath(session.cwd) ||
          matchingWorkspace(snapshot, session.cwd)?.id !== workspace.id
        )
          throw new Error("Session cwd does not belong to workspace");
        if (input.from !== input.to) {
          attach(snapshot, workspace, input.to);
          workspace.sessionIds = workspace.sessionIds.filter(
            (id) => id !== input.from,
          );
          save(snapshot);
        }
        break;
      }
      default:
        throw new Error("Unknown hierarchy action");
    }
    snapshot.projects = snapshot.projects.filter(isStandaloneProject);
    for (const project of snapshot.projects) {
      delete project.defaultBranch;
      if (project.kind === "git") {
        const branch = defaultGitBranch(project.path);
        if (branch) project.defaultBranch = branch;
      }
      project.workspaces = project.workspaces.filter((w) => !isEffortPath(w.path));
      for (const workspace of project.workspaces) {
        if (input.action === "list") {
          const ship = workspaceShipState(workspace.path);
          if (ship) workspace.ship = ship;
        }
        if (project.kind === "directory" && workspace.isDefault)
          workspace.name = "default";
        if (project.kind === "git") delete workspace.branch;
        try {
          if (project.kind === "git") {
            const branch = git(workspace.path, "branch", "--show-current");
            if (workspace.isDefault) workspace.name = branch || "Detached HEAD";
            if (branch) workspace.branch = branch;
          }
          workspace.unavailable = !statSync(workspace.path).isDirectory();
        } catch {
          workspace.unavailable = true;
        }
      }
    }
    return { ok: true, value: snapshot };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      code: "hierarchy_error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
