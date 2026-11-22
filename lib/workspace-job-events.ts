import type {
  DaemonWorkspaceJobScope,
  WorkspaceJobsChanged,
} from "./api-contracts/workspace-job-events";

type Listener = (event: WorkspaceJobsChanged) => void;
declare global {
  var __keylimeWorkspaceJobListeners: Map<string, Set<Listener>> | undefined;
}
const listeners = (globalThis.__keylimeWorkspaceJobListeners ??= new Map());

export function onWorkspaceJobChange(hostId: string, listener: Listener) {
  let bucket = listeners.get(hostId);
  if (!bucket) listeners.set(hostId, (bucket = new Set()));
  bucket.add(listener);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) listeners.delete(hostId);
  };
}

export function publishWorkspaceJobChange(
  hostId: string,
  scope: DaemonWorkspaceJobScope,
): void;
export function publishWorkspaceJobChange(
  hostId: string,
  scope: "runner",
  sessionId: string,
): void;
export function publishWorkspaceJobChange(
  hostId: string,
  scope: DaemonWorkspaceJobScope | "runner",
  sessionId?: string,
) {
  const bucket = listeners.get(hostId);
  if (!bucket) return;
  const type = "workspace_jobs_changed" as const;
  const event: WorkspaceJobsChanged =
    scope === "runner"
      ? { type, scope, sessionId: sessionId! }
      : { type, scope };
  for (const listener of bucket) listener(event);
}
