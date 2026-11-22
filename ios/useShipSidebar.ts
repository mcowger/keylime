import { useEffect, useMemo, useState } from "react";
import type { BrowserChannel, BrowserLink } from "./browser-link";
import type { HomeSession } from "./HomeScreen";
import { KeylimeHttpError, requestJson } from "./keylime-http";
import type { HierarchySnapshot, InventoryHost } from "./useWorkspaceInventory";

type Session = HomeSession["session"];
type ShipState = "ship" | "busy" | "finish";

export function useShipSidebar(
  origin: string,
  link: BrowserLink,
  hosts: InventoryHost[],
  sessions: Session[] | null,
  active: HomeSession[],
  onUnauthorized: () => void,
) {
  const [state, setState] = useState<{
    origin: string;
    snapshots: Record<string, HierarchySnapshot>;
  }>({ origin, snapshots: {} });
  const hostIds = JSON.stringify(
    hosts
      .filter(
        (host) => host.status === "online" || host.status === "omp-missing",
      )
      .map((host) => host.id)
      .sort(),
  );
  useEffect(() => {
    let disposed = false;
    const versions = new Map<string, number>();
    async function refresh(hostId: string) {
      const version = (versions.get(hostId) ?? 0) + 1;
      versions.set(hostId, version);
      try {
        const value = await requestJson<HierarchySnapshot>(
          origin,
          `/api/hierarchy?host=${encodeURIComponent(hostId)}`,
        );
        if (!disposed && versions.get(hostId) === version)
          setState((old) => ({
            origin,
            snapshots: {
              ...(old.origin === origin ? old.snapshots : {}),
              [hostId]: value,
            },
          }));
      } catch (cause) {
        if (disposed || versions.get(hostId) !== version) return;
        if (cause instanceof KeylimeHttpError && cause.kind === "unauthorized")
          onUnauthorized();
        setState((old) => {
          const next = { ...(old.origin === origin ? old.snapshots : {}) };
          delete next[hostId];
          return { origin, snapshots: next };
        });
      }
    }
    const releases = (JSON.parse(hostIds) as string[]).map((hostId) =>
      link.subscribe({ kind: "workspace-jobs", hostId } as BrowserChannel, {
        onOpen: () => void refresh(hostId),
        onEvent: (event) => {
          if (
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "workspace_jobs_changed" &&
            "scope" in event &&
            event.scope === "ship"
          )
            void refresh(hostId);
        },
      }),
    );
    return () => {
      disposed = true;
      for (const release of releases) release();
    };
  }, [origin, link, hostIds, onUnauthorized]);
  return useMemo(() => {
    const states: Record<string, ShipState> = {};
    const latest: Record<string, Session> = {};
    const connected = new Set(JSON.parse(hostIds) as string[]);
    for (const [hostId, snapshot] of Object.entries(
      state.origin === origin ? state.snapshots : {},
    )) {
      if (!connected.has(hostId)) continue;
      for (const project of snapshot.projects)
        for (const workspace of project.workspaces) {
          if (
            workspace.isDefault ||
            project.kind !== "git" ||
            workspace.unavailable
          )
            continue;
          const key = JSON.stringify([hostId, workspace.id]);
          const session = (sessions ?? [])
            .filter(
              (item) =>
                (item.hostId ?? "local") === hostId &&
                workspace.sessionIds.includes(item.id),
            )
            .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))[0];
          if (session) latest[key] = session;
          const running =
            session &&
            active.some(
              (item) =>
                (item.session.hostId ?? "local") === hostId &&
                item.session.id === session.id &&
                item.status === "Running",
            );
          states[key] =
            workspace.ship?.job?.status === "running"
              ? "busy"
              : workspace.ship?.pr?.state === "merged"
                ? "finish"
                : !session || running
                  ? "busy"
                  : "ship";
        }
    }
    return { states, latest };
  }, [state, origin, hostIds, sessions, active]);
}
