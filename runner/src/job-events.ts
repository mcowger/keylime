import { watch, type FSWatcher } from "node:fs";
import {
  canonicalProjectDir,
  daemonClient,
} from "@oh-my-pi/pi-coding-agent/daemon/client";
import { unitLogDir } from "@oh-my-pi/pi-coding-agent/daemon/paths";
import {
  projectScope,
  type UnitSnapshot,
} from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface JobEvents {
  startServices(): Promise<void>;
  dispose(): void;
}

const observers = new WeakMap<AgentSession, JobEvents>();

/** Subscribe to native job changes. Service observation starts with the first jobs request. */
export function subscribeJobEvents(
  session: AgentSession,
  send: () => void,
): () => void {
  let disposed = false;
  let pending: NodeJS.Timeout | undefined;
  const changed = () => {
    if (disposed || pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (!disposed) send();
    }, 50);
    pending.unref();
  };
  const unsubscribeJobs = session.asyncJobManager?.onJobsChanged(changed);
  const watches = new Map<string, FSWatcher>();
  let unsubscribeUnits: (() => void) | undefined;
  let unsubscribeReconnect: (() => void) | undefined;
  let starting: Promise<void> | undefined;
  let started = false;
  const closeWatch = (id: string) => {
    watches.get(id)?.close();
    watches.delete(id);
  };
  const watchUnit = (unit: UnitSnapshot) => {
    if (disposed || watches.has(unit.id)) return;
    try {
      const watcher = watch(unitLogDir(unit.id), (_event, name) => {
        if (!name || name === "output.log" || name === "output.previous.log")
          changed();
      });
      watcher.on("error", () => {
        closeWatch(unit.id);
        changed();
      });
      watcher.unref();
      watches.set(unit.id, watcher);
    } catch {
      // A unit may disappear between its board event and opening its log directory.
    }
  };
  const startServices = (): Promise<void> => {
    if (disposed || started) return Promise.resolve();
    if (starting) return starting;
    starting = (async () => {
      const scope = projectScope(
        await canonicalProjectDir(session.sessionManager.getCwd()),
      );
      const client = await daemonClient();
      if (disposed) return;
      const matches = (unit: UnitSnapshot) =>
        unit.kind === "proc" &&
        unit.scope.kind === "project" &&
        scope.kind === "project" &&
        unit.scope.dir === scope.dir;
      const load = async () => {
        const { units } = await client.request({
          op: "list",
          scope,
          kind: "proc",
        });
        if (!disposed) for (const unit of units) watchUnit(unit);
      };
      unsubscribeUnits = client.onUnit(({ unit, removed }) => {
        if (!matches(unit)) return;
        if (removed) closeWatch(unit.id);
        else watchUnit(unit);
        changed();
      });
      unsubscribeReconnect = client.onReconnect(() => {
        changed();
        void load().catch(() => {});
      });
      try {
        await load();
        started = true;
      } catch (error) {
        unsubscribeUnits?.();
        unsubscribeReconnect?.();
        unsubscribeUnits = undefined;
        for (const id of watches.keys()) closeWatch(id);
        unsubscribeReconnect = undefined;
        throw error;
      }
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  };
  const observer: JobEvents = {
    startServices,
    dispose() {
      disposed = true;
      clearTimeout(pending);
      unsubscribeJobs?.();
      unsubscribeUnits?.();
      unsubscribeReconnect?.();
      for (const id of watches.keys()) closeWatch(id);
      if (observers.get(session) === observer) observers.delete(session);
    },
  };
  observers.set(session, observer);
  return () => observer.dispose();
}

/** Ensure service output and lifecycle changes are observed before returning a snapshot. */
export async function observeJobServices(session: AgentSession): Promise<void> {
  await observers.get(session)?.startServices();
}
