import { useCallback, useEffect, useRef, useState } from "react";
import type { paths } from "./generated/web-http";
import { KeylimeHttpError, requestJson } from "./keylime-http";

export type HierarchySnapshot =
  paths["/api/hierarchy"]["get"]["responses"][200]["content"]["application/json"];
export type SystemsSnapshot =
  paths["/api/systems"]["get"]["responses"][200]["content"]["application/json"];
export type InventoryHost =
  paths["/api/hosts"]["get"]["responses"][200]["content"]["application/json"]["hosts"][number];
export type InventoryProject = HierarchySnapshot["projects"][number];
export type InventoryWorkspace = InventoryProject["workspaces"][number];
export type InventoryEffort = SystemsSnapshot["efforts"][number];

export type HostInventory = {
  hierarchy?: HierarchySnapshot;
  systems?: SystemsSnapshot;
  hierarchyError?: string;
  systemsError?: string;
  loadingHierarchy?: boolean;
  loadingSystems?: boolean;
  /** A stale snapshot may still be displayed when the host is unavailable. */
  unavailable: boolean;
};
export type WorkspaceInventory = Record<string, HostInventory>;

function linkUp(host: InventoryHost): boolean {
  return host.status === "online" || host.status === "omp-missing";
}

/** Host paths are opaque strings; never interpret them as iPhone filesystem paths. */
function comparablePath(path: string): string {
  return (
    path.replace(/\/{2,}/g, "/").replace(/\/+$/, "") ||
    (path.startsWith("/") ? "/" : "")
  );
}

export function pathContains(root: string, path: string): boolean {
  if (!root || !path) return false;
  const base = comparablePath(root);
  const child = comparablePath(path);
  return child === base || child.startsWith(base === "/" ? "/" : `${base}/`);
}

export type WorkspaceOwner = {
  hostId: string;
  project: InventoryProject;
  workspace: InventoryWorkspace;
  available: boolean;
};
export type EffortOwner = {
  hostId: string;
  effort: InventoryEffort;
  available: boolean;
};

/** Match the nearest registered workspace, even if that workspace is unavailable. */
export function workspaceForPath(
  inventory: WorkspaceInventory,
  hostId: string,
  path: string,
): WorkspaceOwner | undefined {
  const host = inventory[hostId];
  let result: WorkspaceOwner | undefined;
  let longest = -1;
  for (const project of host?.hierarchy?.projects ?? []) {
    for (const workspace of project.workspaces) {
      const length = comparablePath(workspace.path).length;
      if (length > longest && pathContains(workspace.path, path)) {
        longest = length;
        result = {
          hostId,
          project,
          workspace,
          available:
            !host?.unavailable &&
            !host?.hierarchyError &&
            !workspace.unavailable,
        };
      }
    }
  }
  return result;
}

/** Match the PWA's preference for non-cleaned efforts, then the nearest root. */
export function effortForPath(
  inventory: WorkspaceInventory,
  hostId: string,
  path: string,
): EffortOwner | undefined {
  const host = inventory[hostId];
  let result: EffortOwner | undefined;
  for (const effort of host?.systems?.efforts ?? []) {
    if (!pathContains(effort.root, path)) continue;
    if (result) {
      const currentCleaned = result.effort.status === "cleaned";
      const candidateCleaned = effort.status === "cleaned";
      if (
        (!currentCleaned && candidateCleaned) ||
        (currentCleaned === candidateCleaned &&
          comparablePath(result.effort.root).length >=
            comparablePath(effort.root).length)
      )
        continue;
    }
    result = {
      hostId,
      effort,
      available:
        !host?.unavailable && !host?.systemsError && effort.status === "ready",
    };
  }
  return result;
}

/** Keep host identity in the result; a path alone is not a cross-host selection. */
export function locationForPath(
  inventory: WorkspaceInventory,
  hostId: string,
  path: string,
) {
  const effort = effortForPath(inventory, hostId, path);
  if (effort) return { kind: "effort" as const, ...effort };
  const workspace = workspaceForPath(inventory, hostId, path);
  if (workspace) return { kind: "workspace" as const, ...workspace };
  return { kind: "path" as const, hostId, path, available: false };
}

/** A chat belongs only to its nearest workspace, or its own cwd if unregistered. */
export function isInWorkspace(
  inventory: WorkspaceInventory,
  hostId: string,
  cwd: string,
  workspaceHostId: string,
  workspacePath: string,
): boolean {
  if (hostId !== workspaceHostId) return false;
  const owner = workspaceForPath(inventory, hostId, cwd);
  return (
    comparablePath(owner?.workspace.path ?? cwd) ===
    comparablePath(workspacePath)
  );
}

/**
 * Holds actual per-host snapshots. Host changes and explicit invalidations fetch only
 * affected hosts; retained snapshots are never mistaken for a successful empty list.
 */
export function useWorkspaceInventory(
  origin: string,
  hosts: readonly InventoryHost[],
  onUnauthorized: () => void,
) {
  const [state, setState] = useState<{
    origin: string;
    byHost: WorkspaceInventory;
  }>({ origin, byHost: {} });
  const context = useRef({
    origin,
    active: false,
    hosts: new Map<string, InventoryHost>(),
    generations: new Map<string, number>(),
  });
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  const refresh = useCallback(
    async (hostId: string) => {
      const current = context.current;
      const host = current.hosts.get(hostId);
      if (
        !current.active ||
        current.origin !== origin ||
        !host ||
        !linkUp(host)
      )
        return;
      const generation = (current.generations.get(hostId) ?? 0) + 1;
      current.generations.set(hostId, generation);
      const valid = () =>
        current.active &&
        context.current === current &&
        current.generations.get(hostId) === generation;
      setState((previous) => {
        if (!valid()) return previous;
        return {
          origin,
          byHost: {
            ...(previous.origin === origin ? previous.byHost : {}),
            [hostId]: {
              ...(previous.origin === origin
                ? previous.byHost[hostId]
                : undefined),
              unavailable: false,
              loadingHierarchy: true,
              loadingSystems: true,
            },
          },
        };
      });
      const encoded = encodeURIComponent(hostId);
      const load = async (kind: "hierarchy" | "systems") => {
        try {
          const result =
            kind === "hierarchy"
              ? await requestJson<HierarchySnapshot>(
                  origin,
                  `/api/hierarchy?host=${encoded}`,
                )
              : await requestJson<SystemsSnapshot>(
                  origin,
                  `/api/systems?host=${encoded}`,
                );
          if (!valid()) return;
          setState((previous) => {
            if (!valid() || previous.origin !== origin) return previous;
            const existing = previous.byHost[hostId];
            if (!existing) return previous;
            const next =
              kind === "hierarchy"
                ? {
                    ...existing,
                    hierarchy: result as HierarchySnapshot,
                    hierarchyError: undefined,
                    loadingHierarchy: false,
                  }
                : {
                    ...existing,
                    systems: result as SystemsSnapshot,
                    systemsError: undefined,
                    loadingSystems: false,
                  };
            return {
              ...previous,
              byHost: { ...previous.byHost, [hostId]: next },
            };
          });
        } catch (error) {
          if (!valid()) return;
          if (
            error instanceof KeylimeHttpError &&
            error.kind === "unauthorized"
          )
            unauthorized.current();
          const message =
            error instanceof Error ? error.message : String(error);
          setState((previous) => {
            if (!valid() || previous.origin !== origin) return previous;
            const existing = previous.byHost[hostId];
            if (!existing) return previous;
            const next =
              kind === "hierarchy"
                ? {
                    ...existing,
                    hierarchyError: message,
                    loadingHierarchy: false,
                  }
                : { ...existing, systemsError: message, loadingSystems: false };
            return {
              ...previous,
              byHost: { ...previous.byHost, [hostId]: next },
            };
          });
        }
      };
      await Promise.all([load("hierarchy"), load("systems")]);
    },
    [origin],
  );

  useEffect(() => {
    const current = {
      origin,
      active: true,
      hosts: new Map<string, InventoryHost>(),
      generations: new Map<string, number>(),
    };
    context.current = current;
    setState({ origin, byHost: {} });
    return () => {
      current.active = false;
    };
  }, [origin]);

  // Host objects are frequently replaced by link events; status and connection
  // identity, rather than object identity, determine which inventories changed.
  const hostKey = JSON.stringify(
    hosts.map((host) => [
      host.id,
      host.status,
      "connectionId" in host ? host.connectionId : null,
    ]),
  );
  useEffect(() => {
    const current = context.current;
    if (!current.active || current.origin !== origin) return;
    const previousHosts = current.hosts;
    const nextHosts = new Map(hosts.map((host) => [host.id, host]));
    current.hosts = nextHosts;
    for (const id of previousHosts.keys()) {
      const next = nextHosts.get(id);
      if (!next || !linkUp(next))
        current.generations.set(id, (current.generations.get(id) ?? 0) + 1);
    }
    setState((previous) => {
      const old = previous.origin === origin ? previous.byHost : {};
      const byHost: WorkspaceInventory = {};
      for (const [id, host] of nextHosts) {
        byHost[id] = {
          ...old[id],
          unavailable: !linkUp(host),
          ...(!linkUp(host)
            ? { loadingHierarchy: false, loadingSystems: false }
            : {}),
        };
      }
      return { origin, byHost };
    });
    for (const [id, host] of nextHosts) {
      const old = previousHosts.get(id);
      const oldConnection =
        old && "connectionId" in old ? old.connectionId : null;
      const connection = "connectionId" in host ? host.connectionId : null;
      if (
        linkUp(host) &&
        (!old || !linkUp(old) || oldConnection !== connection)
      )
        void refresh(id);
    }
    // hostKey captures the host fields relevant to loading.
  }, [hostKey, origin, refresh]);

  return { byHost: state.origin === origin ? state.byHost : {}, refresh };
}
