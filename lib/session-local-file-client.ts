import type { SessionLocalFile } from "./api-contracts/http-sessions";
import { sessionUrl } from "./session-identity";

export type SessionLocalFileResult =
  ({ ok: true } & SessionLocalFile) | { ok: false; error: string };

/** Bound the lookup even if the host never answers. */
export const LOCAL_FILE_LOOKUP_TIMEOUT_MS = 30_000;

/** Resolve against the session's owning host, not the browser or workspace cwd. */
export async function resolveSessionLocalFile(
  sessionId: string,
  uri: string,
  signal?: AbortSignal,
  hostId = "local",
): Promise<SessionLocalFileResult> {
  const unanswered = {
    ok: false as const,
    error: `Could not open ${uri}: the server did not answer`,
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, LOCAL_FILE_LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(
      sessionUrl(
        `/api/sessions/${encodeURIComponent(sessionId)}/local-file?uri=${encodeURIComponent(uri)}`,
        hostId,
      ),
      { signal: controller.signal },
    );
    const body: unknown = await response.json().catch(() => null);
    if (controller.signal.aborted) return unanswered;
    if (body && typeof body === "object") {
      if (
        response.ok &&
        "path" in body &&
        typeof body.path === "string" &&
        "sessionId" in body &&
        typeof body.sessionId === "string"
      )
        return { ok: true, path: body.path, sessionId: body.sessionId };
      if ("error" in body && typeof body.error === "string")
        return { ok: false, error: body.error };
    }
    return {
      ok: false,
      error: `Could not open ${uri} (HTTP ${response.status})`,
    };
  } catch {
    return unanswered;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
