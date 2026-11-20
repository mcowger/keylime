// Sessions and projects across hosts (spec "Routing", "Data flow"): this
// machine's lists (from its daemon) plus each linked host's, cached per host.
// No `next/*` or `@/` imports.
import type { HierarchySnapshot } from "../project-hierarchy-types";
import { isValidSessionId } from "../session-file-references-core";
import type { ManagedProject, SessionInfo } from "../types";
import { isLinkUp, type Host } from "./host";
import { HostOpError } from "./link-protocol";
import { getHost, listHosts, onHostHello } from "./hub";
import { LOCAL_HOST_ID } from "./registry";
import { getRpcSession } from "../rpc-manager";

/** Same TTL as the daemon's own session-list cache. */
const LIST_TTL_MS = 30_000;

interface HostLists {
  sessions: SessionInfo[];
  fetchedAt: number;
  /** Bumped by invalidation: a load that started before it must not refresh `fetchedAt`. */
  generation: number;
  loading: { generation: number; promise: Promise<SessionInfo[]> } | null;
  /** Last registry the host returned, shown while it is unreachable. */
  hierarchy: HierarchySnapshot;
  /** The latest requested list in this invalidation generation succeeded; cached entries survive failures. */
  loaded: boolean;
}

declare global {
  var __ompHostLists: Map<string, HostLists> | undefined;
}

// globalThis, like the hub: survives a `bun --hot` re-evaluation.
function hostLists(hostId: string): HostLists {
  if (!globalThis.__ompHostLists) {
    globalThis.__ompHostLists = new Map();
    // A host that links again may have changed its sessions while away.
    onHostHello((id) => invalidateHostSessionList(id));
  }
  let lists = globalThis.__ompHostLists.get(hostId);
  if (!lists) {
    lists = {
      sessions: [],
      fetchedAt: 0,
      generation: 0,
      loading: null,
      hierarchy: { projects: [] },
      loaded: false,
    };
    globalThis.__ompHostLists.set(hostId, lists);
  }
  return lists;
}

/** Host ids in sidebar order: this machine, then linked hosts by label, case-insensitive. */
function hostIds(): string[] {
  const remote = listHosts().sort(
    (a, b) =>
      a.label.toLowerCase().localeCompare(b.label.toLowerCase()) ||
      a.id.localeCompare(b.id),
  );
  return [LOCAL_HOST_ID, ...remote.map((host) => host.id)];
}

/** One host's sessions, cached for LIST_TTL_MS. An unreachable or failing host keeps its last list. */
export async function hostSessions(
  hostId: string,
  refresh = false,
): Promise<SessionInfo[]> {
  const lists = hostLists(hostId);
  if (!refresh && Date.now() - lists.fetchedAt < LIST_TTL_MS)
    return lists.sessions;
  const host = getHost(hostId);
  if (!host || !isLinkUp(host.status())) {
    lists.loaded = false;
    return lists.sessions;
  }
  if (lists.loading?.generation !== lists.generation) {
    const generation = lists.generation;
    const promise: Promise<SessionInfo[]> = host.sessionOps
      .listSessions()
      .then(
        (sessions) => {
          const tagged = sessions.map((session) => ({ ...session, hostId }));
          if (lists.generation === generation) {
            lists.loaded = true;
            lists.sessions = tagged;
            lists.fetchedAt = Date.now();
          }
          return tagged;
        },
        () => {
          if (lists.generation === generation) lists.loaded = false;
          return lists.sessions;
        },
      )
      .finally(() => {
        if (lists.loading?.promise === promise) lists.loading = null;
      });
    lists.loading = { generation, promise };
  }
  return lists.loading!.promise;
}

/** A host's registered sessions, including live sessions not yet written to disk. */
export async function listRegisteredHostSessions(
  hostId: string,
): Promise<SessionInfo[]> {
  const [hierarchy, sessions] = await Promise.all([
    hostHierarchy(hostId),
    hostSessions(hostId),
  ]);
  const registered = new Set(
    hierarchy.projects.flatMap((project) =>
      project.workspaces.flatMap((workspace) => workspace.sessionIds),
    ),
  );
  const visible = sessions.filter((session) => registered.has(session.id));
  const seen = new Set(visible.map((session) => session.id));
  for (const project of hierarchy.projects)
    for (const workspace of project.workspaces)
      for (const id of workspace.sessionIds) {
        if (seen.has(id)) continue;
        const live = getRpcSession(id, hostId);
        if (!live?.isAlive()) continue;
        seen.add(id);
        visible.push({
          id,
          path: live.sessionFile,
          cwd: workspace.path,
          projectRoot: project.path,
          hostId,
          created: "",
          modified: "",
          messageCount: 0,
          firstMessage: "New session",
        });
      }
  return visible;
}

/** Combined discovery does not choose an owner for duplicate IDs. */
export async function listSessionsAllHosts(): Promise<SessionInfo[]> {
  return (await Promise.all(hostIds().map(listRegisteredHostSessions))).flat();
}

/** Look for a session only on the selected host. */
export async function hostForSessionId(
  id: string,
  hostId = LOCAL_HOST_ID,
): Promise<Host | null> {
  if (!isValidSessionId(id)) return null;
  const host = getHost(hostId);
  if (!host) return null;
  const requireOnline = () => {
    if (!isLinkUp(host.status()))
      throw new HostOpError(503, "host_offline", `${host.label} is offline`);
  };
  requireOnline();
  for (const refresh of [false, true]) {
    const sessions = await hostSessions(hostId, refresh);
    requireOnline();
    if (sessions.some((session) => session.id === id)) return host;
  }
  if (!hostLists(hostId).loaded)
    throw new HostOpError(
      503,
      "host_sessions_unavailable",
      `${host.label}'s sessions are unavailable`,
    );
  return null;
}

/** Where a session's file is and which cwd to start it in, on `host`; null when the host has no such session. */
export async function sessionSpawnTarget(
  id: string,
  host: Host,
): Promise<{
  sessionFile: string;
  cwd: string;
  recordedCwd: string | undefined;
} | null> {
  // The host's own list entry carries its file path and recorded cwd; the
  // host resolves a missing cwd on its machine when it spawns.
  const find = async (refresh: boolean) =>
    (await hostSessions(host.id, refresh)).find((session) => session.id === id);
  const info = (await find(false)) ?? (await find(true));
  return info
    ? { sessionFile: info.path, cwd: info.cwd, recordedCwd: info.cwd }
    : null;
}

/** Drop one host's cached session list; it is kept as the fallback while the host is unreachable. */
export function invalidateHostSessionList(hostId: string): void {
  const lists = globalThis.__ompHostLists?.get(hostId);
  if (!lists) return;
  lists.fetchedAt = 0;
  lists.generation += 1;
  lists.loaded = false;
}

/** This machine's session files changed outside any host op (a terminal omp, an import, an archive restore): its daemon and main drop their lists. */
export function invalidateLocalSessionLists(sessionFile?: string): void {
  getHost(LOCAL_HOST_ID).invalidateSessionLists(sessionFile);
  invalidateHostSessionList(LOCAL_HOST_ID);
}

/** Registry IDs used to admit local transcript scores; never reads linked hosts. */
export async function registeredHostSessionIds(
  hostId: string,
): Promise<Set<string>> {
  const host = getHost(hostId);
  if (!host || !isLinkUp(host.status()))
    throw new HostOpError(
      503,
      "host_offline",
      `${host?.label ?? "Host"} is offline`,
    );
  const result = await host.workspaceOps.hierarchy({ action: "list" });
  if (!result.ok)
    throw new HostOpError(result.status, result.code, result.error);
  return new Set(
    result.value.projects.flatMap((project) =>
      project.workspaces.flatMap((workspace) => workspace.sessionIds),
    ),
  );
}

async function hostHierarchy(id: string): Promise<HierarchySnapshot> {
  const lists = hostLists(id);
  const host = getHost(id);
  if (host && isLinkUp(host.status())) {
    try {
      const result = await host.workspaceOps.hierarchy({ action: "list" });
      if (result.ok) lists.hierarchy = result.value;
    } catch {
      // Keep the last hierarchy when the host is unavailable.
    }
  }
  return lists.hierarchy;
}

/** Explicitly registered projects, this machine first, tagged with their host. */
export async function listProjectsAllHosts(): Promise<ManagedProject[]> {
  const ids = hostIds();
  const snapshots = await Promise.all(ids.map(hostHierarchy));
  return snapshots.flatMap((snapshot, index) =>
    snapshot.projects.map((project) => ({
      path: project.path,
      addedAt: project.addedAt,
      alias: project.alias,
      sortOrder: project.sortOrder,
      pinOrder: project.pinOrder,
      launchConfig: project.launchConfig,
      hostId: ids[index],
    })),
  );
}
