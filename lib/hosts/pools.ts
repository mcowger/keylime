import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { comparableProjectPath } from "../comparable-path";
import { cloneDirectoryName } from "../git-clone";
import { getAgentDir } from "../omp/paths";
import {
  isReservedLaunchArg,
  type ProjectRegistryEntry,
} from "../project-registry";
import { isRecord } from "../type-guards";

export interface PoolMember {
  hostId: string;
  projectsRoot: string;
  provisioned: boolean;
  draining: boolean;
}

export interface PoolProject extends Omit<ProjectRegistryEntry, "path"> {
  id: string;
  name: string;
  origin: string;
  defaultRef?: string;
  clonePaths: Record<string, string>;
}

export interface HostPool {
  id: string;
  label: string;
  enabled: boolean;
  members: PoolMember[];
  projects: PoolProject[];
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const safeId = (value: unknown): value is string =>
  typeof value === "string" && SAFE_ID.test(value);
const absoluteRoot = (value: unknown): value is string =>
  typeof value === "string" &&
  !value.includes("\0") &&
  posix.isAbsolute(value) &&
  posix.resolve(value) === value &&
  posix.dirname(value) !== value;

export function isValidPoolOrigin(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !cloneDirectoryName(value)
  )
    return false;
  if (!value.startsWith("https://")) return true;
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

function validLaunchConfig(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    (value.profile === undefined ||
      (typeof value.profile === "string" &&
        value.profile.trim().length > 0 &&
        !value.profile.trim().startsWith("-"))) &&
    (value.advisor === undefined || typeof value.advisor === "boolean") &&
    (value.extraArgs === undefined ||
      (Array.isArray(value.extraArgs) &&
        value.extraArgs.length <= 32 &&
        value.extraArgs.every(
          (arg) =>
            typeof arg === "string" &&
            arg.length > 0 &&
            arg.length <= 256 &&
            !isReservedLaunchArg(arg),
        )))
  );
}

export function validatePools(value: unknown): asserts value is HostPool[] {
  if (!Array.isArray(value)) throw new Error("Invalid pools list");
  const poolIds = new Set<string>();
  for (const pool of value) {
    if (
      !isRecord(pool) ||
      !safeId(pool.id) ||
      poolIds.has(pool.id) ||
      typeof pool.label !== "string" ||
      !pool.label.trim() ||
      typeof pool.enabled !== "boolean" ||
      !Array.isArray(pool.members) ||
      !Array.isArray(pool.projects)
    )
      throw new Error("Invalid pool configuration");
    poolIds.add(pool.id);
    const memberIds = new Set<string>();
    for (const member of pool.members) {
      if (
        !isRecord(member) ||
        !safeId(member.hostId) ||
        memberIds.has(member.hostId) ||
        !absoluteRoot(member.projectsRoot) ||
        typeof member.provisioned !== "boolean" ||
        typeof member.draining !== "boolean"
      ) {
        throw new Error("Invalid pool member configuration");
      }
      memberIds.add(member.hostId);
    }
    const projectIds = new Set<string>();
    for (const project of pool.projects) {
      if (
        !isRecord(project) ||
        !safeId(project.id) ||
        projectIds.has(project.id) ||
        typeof project.name !== "string" ||
        !project.name.trim() ||
        !isValidPoolOrigin(project.origin) ||
        !(
          project.defaultRef === undefined ||
          typeof project.defaultRef === "string"
        ) ||
        !isRecord(project.clonePaths) ||
        typeof project.addedAt !== "string" ||
        typeof project.hidden !== "boolean" ||
        !(project.alias === undefined || typeof project.alias === "string") ||
        !(
          project.sortOrder === undefined ||
          (typeof project.sortOrder === "number" &&
            Number.isFinite(project.sortOrder))
        ) ||
        !(
          project.pinOrder === undefined ||
          (typeof project.pinOrder === "number" &&
            Number.isFinite(project.pinOrder))
        ) ||
        !validLaunchConfig(project.launchConfig)
      )
        throw new Error("Invalid pool project configuration");
      projectIds.add(project.id);
      for (const [hostId, clonePath] of Object.entries(project.clonePaths)) {
        if (!safeId(hostId) || !absoluteRoot(clonePath))
          throw new Error("Invalid pool project clone path");
      }
    }
  }
  poolProjectBindings(value);
}

/** Missing configuration means no pools; damaged configuration never means a local default. */
export function loadPools(): HostPool[] {
  let text: string;
  try {
    text = readFileSync(join(getAgentDir(), "keylime", "pools.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid pool registry JSON");
  }
  if (!isRecord(parsed) || parsed.version !== 1)
    throw new Error("Unsupported pool registry version");
  validatePools(parsed.pools);
  return parsed.pools;
}

export function savePools(pools: HostPool[]): void {
  validatePools(pools);
  const file = join(getAgentDir(), "keylime", "pools.json");
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, pools }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

/** Retained bindings, not current membership, determine an existing session's identity. */
export function poolProjectBindings(
  pools: readonly HostPool[],
): Map<string, Map<string, { pool: HostPool; project: PoolProject }>> {
  const bindings = new Map<
    string,
    Map<string, { pool: HostPool; project: PoolProject }>
  >();
  for (const pool of pools)
    for (const project of pool.projects) {
      for (const [hostId, root] of Object.entries(project.clonePaths)) {
        let roots = bindings.get(hostId);
        if (!roots) bindings.set(hostId, (roots = new Map()));
        const key = comparableProjectPath(root);
        if (roots.has(key))
          throw new Error("Ambiguous pool project clone binding");
        roots.set(key, { pool, project });
      }
    }
  return bindings;
}
