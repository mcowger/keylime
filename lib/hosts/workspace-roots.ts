import { realpathSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getConfigAgentRoots, isFilePathAllowed } from "../file-access";
import { authorizeFileAccess } from "../file-authorization";
import { filePathApiSegments } from "../file-paths";
import { loadProjectRegistry } from "../project-registry";
import {
  listAllSessions,
  readSessionHeader,
  resolveSessionPath,
} from "../session-reader";
import { HostOpError } from "./link-protocol";
import type { WorkspaceOwner } from "../workspace-types";
import { resolveProject } from "../worktree";
import { isValidSessionId } from "../session-file-references-core";
import { readHierarchy } from "./project-hierarchy";

const grants = new Set<string>();
let cached: { roots: Set<string>; until: number } | null = null;

function addTemporaryRoots(roots: Set<string>): void {
  for (const root of [
    tmpdir(),
    "/tmp",
    "/var/tmp",
  ]) {
    try {
      const canonical = realpathSync(root);
      if (canonical === "/") continue;
      roots.add(canonical);
      roots.add(resolve(root));
    } catch {
      /* An unavailable temporary directory grants nothing. */
    }
  }
}

export function invalidateWorkspaceRoots(): void {
  cached = null;
}

export function grantWorkspaceRoot(path: string): void {
  grants.add(realpathSync(path));
  grants.add(resolve(path));
  invalidateWorkspaceRoots();
}

export async function getWorkspaceRoots(
  owner?: WorkspaceOwner,
): Promise<Set<string>> {
  if (owner !== undefined) {
    if (
      !owner ||
      !isValidSessionId(owner.sessionId) ||
      typeof owner.cwd !== "string" ||
      owner.cwd.includes("\0") ||
      !isAbsolute(owner.cwd)
    ) {
      throw new HostOpError(400, "invalid_request", "Invalid workspace owner");
    }
    const file = await resolveSessionPath(owner.sessionId);
    const cwd = (file ? readSessionHeader(file)?.cwd : undefined) || owner.cwd;
    if (!isAbsolute(cwd) || cwd.includes("\0"))
      throw new HostOpError(
        400,
        "invalid_request",
        "Invalid native session workspace",
      );
    const roots = new Set([cwd, (await resolveProject(cwd)).projectRoot]);
    addTemporaryRoots(roots);
    for (const root of getConfigAgentRoots()) roots.add(root);
    return roots;
  }
  if (cached && cached.until > Date.now()) return cached.roots;
  const roots = new Set<string>();
  for (const session of await listAllSessions()) {
    if (session.cwd) roots.add(session.cwd);
    if (session.projectRoot) roots.add(session.projectRoot);
  }
  for (const project of loadProjectRegistry().projects) {
    if (!project.hidden) roots.add(project.path);
  }
  for (const project of readHierarchy().projects)
    for (const workspace of project.workspaces) roots.add(workspace.path);
  for (const grant of grants) roots.add(grant);
  addTemporaryRoots(roots);
  try {
    for (const entry of readdirSync(homedir(), { withFileTypes: true })) {
      if (entry.isDirectory() && /^omp-cwd-\d{8}$/.test(entry.name))
        roots.add(join(homedir(), entry.name));
    }
  } catch {
    /* A missing home does not authorize any scratch directory. */
  }
  for (const root of getConfigAgentRoots()) roots.add(root);
  cached = { roots, until: Date.now() + 5_000 };
  return roots;
}

/** Writes require an explicit absolute directory, never read-path root fanout. */
export async function authorizeWorkspaceDirectory(
  directory: string,
  owner?: WorkspaceOwner,
): Promise<string> {
  if (typeof directory !== "string" || !isAbsolute(directory))
    throw new HostOpError(
      400,
      "invalid_request",
      "An absolute directory is required",
    );
  const roots = await getWorkspaceRoots(owner);
  if (!isFilePathAllowed(directory, roots))
    throw new HostOpError(403, "access_denied", "Access denied");
  const checked = await authorizeFileAccess(
    filePathApiSegments(directory),
    null,
    false,
    roots,
  );
  if (!checked.ok)
    throw new HostOpError(checked.status, checked.code, checked.error);
  if (!checked.stat.isDirectory())
    throw new HostOpError(
      400,
      "not_a_directory",
      "The destination is not a directory",
    );
  return realpathSync(checked.filePath);
}
