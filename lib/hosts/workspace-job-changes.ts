type WorkspaceJobScope = "setup" | "effort" | "ship";
type Listener = (scope: WorkspaceJobScope) => void;

const listeners = new Set<Listener>();
const pending = new Set<WorkspaceJobScope>();
let timer: NodeJS.Timeout | undefined;

export function subscribeWorkspaceJobChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
    }
  };
}

/** Called after a job's authoritative state has been persisted. */
export function publishWorkspaceJobChange(scope: WorkspaceJobScope): void {
  if (!listeners.size) return;
  pending.add(scope);
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    const scopes = [...pending];
    pending.clear();
    for (const scope of scopes) {
      for (const listener of listeners) {
        try {
          listener(scope);
        } catch (error) {
          console.error("Workspace job change listener failed", error);
        }
      }
    }
  }, 50);
  timer.unref();
}
