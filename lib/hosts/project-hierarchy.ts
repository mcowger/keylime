import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { getAgentDir } from "../omp/paths";
import { listAllSessions } from "../session-reader";
import { applyProjectPresentation } from "../project-registry";
import {
  grantWorkspaceRoot,
  invalidateWorkspaceRoots,
} from "./workspace-roots";
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
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function worktrees(
  project: HierarchyProject,
): { path: string; name: string; branch?: string; isDefault: boolean }[] {
  if (project.kind !== "git") return [];
  const output = git(project.path, "worktree", "list", "--porcelain");
  return output
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n");
      const raw = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      if (!raw) return null;
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
export function readHierarchy(): HierarchySnapshot {
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
function save(snapshot: HierarchySnapshot): void {
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
function projectById(
  snapshot: HierarchySnapshot,
  id?: string,
): HierarchyProject {
  const project = snapshot.projects.find((p) => p.id === id);
  if (!project) throw new Error("Project not registered");
  return project;
}
function workspaceById(
  snapshot: HierarchySnapshot,
  id?: string,
): HierarchyWorkspace {
  const workspace = snapshot.projects
    .flatMap((p) => p.workspaces)
    .find((w) => w.id === id);
  if (!workspace) throw new Error("Workspace not registered");
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
  grantWorkspaceRoot(p);
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
        for (const project of snapshot.projects)
          for (const workspace of project.workspaces) {
            const ship = workspaceShipState(workspace.path);
            if (ship) workspace.ship = ship;
          }
        break;
      case "registerProject": {
        const requested = directory(input.path ?? input.cwd);
        let root = requested;
        let kind: HierarchyProject["kind"] = "directory";
        try {
          const common = git(
            requested,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          );
          root = canonical(path.dirname(common));
          kind = "git";
        } catch {
          /* not a git checkout */
        }
        const existing = snapshot.projects.find((p) => p.path === root);
        if (existing) {
          snapshot.selectedProjectId = existing.id;
          break;
        }
        if (
          snapshot.projects.some((p) =>
            p.workspaces.some((w) => w.path === root),
          )
        )
          throw new Error("Path is already registered as a workspace");
        const id = randomUUID();
        const project: HierarchyProject = {
          id,
          path: root,
          name: path.basename(root),
          kind,
          addedAt: new Date().toISOString(),
          workspaces: [],
        };
        project.workspaces.push({
          id: randomUUID(),
          projectId: id,
          path: root,
          name: path.basename(root),
          isDefault: true,
          sessionIds: [],
        });
        snapshot.selectedProjectId = id;
        snapshot.projects.push(project);
        grantWorkspaceRoot(root);
        save(snapshot);
        break;
      }
      case "unregisterProject": {
        const project = projectById(snapshot, input.projectId);
        snapshot.projects = snapshot.projects.filter((p) => p !== project);
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
        const session = sessions.find((s) => s.id === input.to);
        if (
          !session ||
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
    for (const project of snapshot.projects)
      for (const workspace of project.workspaces) {
        if (project.kind === "directory" && workspace.isDefault)
          workspace.name = "default";
        try {
          if (project.kind === "git" && workspace.isDefault) {
            const branch = git(workspace.path, "branch", "--show-current");
            workspace.name = branch || "Detached HEAD";
            workspace.branch = branch || undefined;
          }
          workspace.unavailable = !statSync(workspace.path).isDirectory();
        } catch {
          workspace.unavailable = true;
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
