import { useEffect, useState } from "react";
import type { BrowserLink } from "./browser-link";
import type { paths } from "./generated/web-http";
import type { HomeSession } from "./HomeScreen";
import { getHosts, KeylimeHttpError, requestJson } from "./keylime-http";

type Collection<
  Route extends "/api/sessions" | "/api/hierarchy" | "/api/systems",
> = paths[Route]["get"]["responses"][200]["content"]["application/json"];
type Sessions = Collection<"/api/sessions">;
type Host =
  paths["/api/hosts"]["get"]["responses"][200]["content"]["application/json"]["hosts"][number];
type Places = Array<{ path: string; label: string }>;
type Running = Sessions["runningSessions"];

export function useHomeInventory(
  origin: string,
  link: BrowserLink,
  onUnauthorized: () => void,
) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [sessions, setSessions] = useState<Sessions["sessions"] | null>(null);
  const [running, setRunning] = useState<Running>([]);
  const [places, setPlaces] = useState<Record<string, Places>>({});
  const [error, setError] = useState(false);

  useEffect(() => {
    let disposed = false;
    let runningReceived = false;
    let sessionsGeneration = 0;
    let hostsGeneration = 0;
    let placesGeneration = 0;
    function failed(cause: unknown) {
      if (disposed) return;
      if (cause instanceof KeylimeHttpError && cause.kind === "unauthorized")
        onUnauthorized();
      else setError(true);
    }

    async function refreshSessions() {
      const generation = ++sessionsGeneration;
      try {
        const result = await requestJson<Sessions>(origin, "/api/sessions");
        if (disposed || generation !== sessionsGeneration) return;
        setSessions(result.sessions);
        if (!runningReceived) setRunning(result.runningSessions);
        setError(false);
      } catch (cause) {
        if (generation === sessionsGeneration) failed(cause);
      }
    }

    async function refreshPlaces(rows: Host[]) {
      const generation = ++placesGeneration;
      const entries = await Promise.all(
        rows.map(async ({ id }) => {
          const host = encodeURIComponent(id);
          const [hierarchy, systems] = await Promise.allSettled([
            requestJson<Collection<"/api/hierarchy">>(
              origin,
              `/api/hierarchy?host=${host}`,
            ),
            requestJson<Collection<"/api/systems">>(
              origin,
              `/api/systems?host=${host}`,
            ),
          ]);
          const locations: Places = [];
          if (systems.status === "fulfilled") {
            for (const effort of systems.value.efforts ?? []) {
              if (effort.root)
                locations.push({ path: effort.root, label: effort.name });
            }
          }
          if (hierarchy.status === "fulfilled") {
            for (const repo of hierarchy.value.projects) {
              for (const workspace of repo.workspaces) {
                locations.push({
                  path: workspace.path,
                  label: workspace.isDefault
                    ? `${repo.name} / ${workspace.name}`
                    : workspace.name,
                });
              }
            }
          }
          locations.sort((a, b) => b.path.length - a.path.length);
          return [id, locations] as const;
        }),
      );
      if (!disposed && generation === placesGeneration)
        setPlaces(Object.fromEntries(entries));
    }

    function applyHosts(rows: Host[]) {
      setHosts(rows);
      void refreshPlaces(rows);
    }

    const releaseHosts = link.subscribe(
      { kind: "hosts" },
      {
        onEvent(data) {
          const event = data as { hosts?: Host[] } | null;
          if (disposed || !Array.isArray(event?.hosts)) return;
          ++hostsGeneration;
          applyHosts(event.hosts);
        },
      },
    );
    const releaseRunning = link.subscribe(
      { kind: "running" },
      {
        onOpen() {
          void refreshSessions();
        },
        onEvent(data) {
          const event = data as {
            type?: string;
            runningSessions?: Running;
            refreshSessionList?: boolean;
          } | null;
          if (disposed || !event) return;
          if (
            event.type === "running" &&
            Array.isArray(event.runningSessions)
          ) {
            runningReceived = true;
            setRunning(event.runningSessions);
          }
          if (event.refreshSessionList) void refreshSessions();
        },
      },
    );
    const generation = ++hostsGeneration;
    void getHosts(origin)
      .then(({ hosts }) => {
        if (!disposed && generation === hostsGeneration) applyHosts(hosts);
      })
      .catch((cause) => {
        if (generation === hostsGeneration) failed(cause);
      });
    void refreshSessions();
    return () => {
      disposed = true;
      releaseRunning();
      releaseHosts();
    };
  }, [link, onUnauthorized, origin]);

  const statusBySession = new Map(
    running.map((row) => [`${row.hostId}:${row.id}`, row]),
  );
  const hostNames = new Map(hosts.map((row) => [row.id, row.label]));
  const active: HomeSession[] = [];
  const recent: HomeSession[] = [];
  for (const session of [...(sessions ?? [])].sort(
    (a, b) => Date.parse(b.modified) - Date.parse(a.modified),
  )) {
    const host = session.hostId ?? "local";
    const live = statusBySession.get(`${host}:${session.id}`);
    const cwd = live?.cwd ?? session.cwd;
    const place = places[host]?.find(
      ({ path }) =>
        cwd === path || cwd.startsWith(path.endsWith("/") ? path : `${path}/`),
    );
    const row: HomeSession = {
      session,
      status: live
        ? live.awaitingInput
          ? "Awaiting input"
          : "Running"
        : "Not running",
      hostName:
        hostNames.get(host) || (host === "local" ? "This machine" : host),
      ...(place ? { place: place.label } : {}),
    };
    (live ? active : recent).push(row);
  }
  active.sort(
    (a, b) =>
      Number(b.status === "Awaiting input") -
      Number(a.status === "Awaiting input"),
  );
  return { hosts, sessions, active, recent: recent.slice(0, 5), error };
}
