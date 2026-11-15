import {
  apiErrorResponse,
  hostOfflineResponse,
  opErrorResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { clearExitedRpcSession, getRpcSession } from "@/lib/rpc-manager";

/** POST /api/sessions/[id]/archive — stop the live child, then archive the
 * native OMP JSONL and its sibling artifacts using OMP's gc layout. */
/**
 * @apiContract archiveSession
 * @apiUsage Move a session and its sibling artifacts into its host's native archive.
 * @apiInputs id selects the active session; no body is used.
 * @apiInvariants Archive child sessions first: a parent with active children is rejected. The host must be online and a live child must flush before the move.
 * @apiEffects Stops the session process as needed, archives its files, clears exited state and invalidates the host inventory.
 * @apiRecovery After an uncertain response inspect both active and archive inventories on the owning host; an unavailable host's omission is not proof of absence.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const { sessionOps } = resolved.host;
    // Parent-session paths are native branch metadata. Moving only a parent
    // would leave active children pointing at a path that no longer exists,
    // flattening their tree in the sidebar. Archive leaves first instead.
    const hasChildren = (await sessionOps.listSessions()).some(
      (session) => session.parentSessionId === id,
    );
    if (hasChildren) {
      return Response.json(
        {
          error: "Archive child sessions before archiving this session",
          code: "session_has_children",
        },
        { status: 409 },
      );
    }

    // OMP owns writes while a child is live; wait for its final flush before
    // moving the file so the archive contains the complete native transcript.
    // Disposing a child behind a down link would wait for the link to return.
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    const live = getRpcSession(id);
    if (!live?.hostOwnedLifecycle)
      await live?.destroyAndWait?.("archive", true);
    const result = await sessionOps.archiveSession(id);
    if (!result.ok) return opErrorResponse(result);
    invalidateHostSessionList(resolved.host.id);
    clearExitedRpcSession(id);
    return Response.json({
      ok: true,
      archived: true,
      archivedPath: result.value.archivedPath,
    });
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: message, code: "session_archive_failed" },
      { status: 500 },
    );
  }
}
