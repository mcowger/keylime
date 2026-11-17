import {
  apiErrorResponse,
  hostOfflineResponse,
  opErrorResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { forgetSessionReplacementMappings } from "@/lib/message-outbox";
import { invalidateSessionCaches } from "@/lib/session-reader";
import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import {
  clearExitedRpcSession,
  getLiveRpcSessionIds,
  getRpcSession,
  WebRpcError,
} from "@/lib/rpc-manager";

/** Stable, client-safe error body for catch-all handlers: details go to the
 *  server log only, never to the browser. */
function sessionsErrorResponse(error: unknown): Response {
  if (error instanceof WebRpcError && error.code === "session_busy") {
    return Response.json(
      { error: error.message, code: error.code },
      { status: 409 },
    );
  }
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json(
      { error: "Request body is too large", code: "request_too_large" },
      { status: 413 },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json(
      { error: "Invalid JSON request body", code: "invalid_json" },
      { status: 400 },
    );
  }
  // A host link failure keeps its status: 503 offline, 504 timeout.
  if (error instanceof HostOpError) return apiErrorResponse(error);
  console.error("[api/sessions]", error);
  return Response.json(
    { error: "Session request failed", code: "session_request_failed" },
    { status: 500 },
  );
}

/**
 * @apiContract getSession
 * @apiUsage Read a session's persisted transcript from its owning host, optionally with live agent state.
 * @apiInputs id selects the session; deferThinking and deferMedia defer payloads; includeState requests live wrapper state. tail selects the newest 1–200 display entries, and before plus historyRevision selects an exclusive preceding page.
 * @apiInvariants Tail pages are chronological on the active branch, without overlap. Continuations omit session metadata and navigation tree. historyRevision identifies the file generation; a stale revision or missing active cursor returns 409 session_history_changed. Without tail the full transcript is returned. agent is omitted if its live state request fails. Disk and live state are not an atomic snapshot.
 * @apiEffects Reads host session storage and may send get_state to an existing wrapper; it does not start a process.
 * @apiRecovery On session_history_changed discard partial pages and synchronize again. Fetch agent state separately when omitted; retry reads when the host is available.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;

    const searchParams = new URL(req.url).searchParams;
    const includeState = searchParams.has("includeState");
    const tailRaw = searchParams.get("tail");
    const before = searchParams.get("before");
    const historyRevision = searchParams.get("historyRevision");
    if ((tailRaw !== null && (!/^[1-9]\d*$/.test(tailRaw) || Number(tailRaw) > 200)) ||
        (before !== null && (!tailRaw || !historyRevision || before.length === 0 || before.length > 256)) ||
        (historyRevision !== null && (before === null || historyRevision.length === 0 || historyRevision.length > 256))) {
      return Response.json({ code: "invalid_history_page", error: "Invalid session history page parameters" }, { status: 400 });
    }
    const read = await resolved.host.sessionOps.readSession(id, {
      deferThinking: searchParams.has("deferThinking"),
      deferMedia: searchParams.has("deferMedia"),
      ...(tailRaw !== null ? { tail: Number(tailRaw) } : {}),
      ...(before !== null ? { before } : {}),
      ...(historyRevision !== null ? { historyRevision } : {}),
    });
    if (!read.ok) return opErrorResponse(read);

    // ?includeState=1 inlines the wrapper's live agent state (same shape as
    // GET /api/agent/[id]) so the client's post-turn refresh is one request
    // instead of two. On a get_state failure the field is omitted entirely —
    // callers treat a missing `agent` as "fetch it separately".
    let agent: { running: boolean; state?: unknown } | undefined;
    if (includeState) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        try {
          agent = {
            running: true,
            state: await rpc.send({ type: "get_state" }),
          };
        } catch {
          // Leave agent unset; the session payload is still valid without it.
        }
      } else {
        agent = { running: false };
      }
    }

    return Response.json({
      sessionId: id,
      ...read.value,
      hostId: resolved.host.id,
      ...(agent ? { agent } : {}),
    });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
/**
 * @apiContract renameSession
 * @apiUsage Set a session title on its owning process or persisted file.
 * @apiInputs JSON name must be nonblank; surrounding whitespace is removed. The request is limited to 64 KiB.
 * @apiInvariants A live process owns its file; a busy history edit fences fallback file writes. A new live session can be renamed before its file exists.
 * @apiEffects Sends set_session_name to the live process or updates the host file and invalidates session lists.
 * @apiRecovery Wait for a busy edit to finish; after a lost response read the current title before deciding whether to retry.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { name } = await parseJsonWithinLimit<{ name?: string }>(
      req,
      64 * 1024,
    );
    if (typeof name !== "string" || !name.trim()) {
      return Response.json(
        { error: "name is required", code: "session_name_required" },
        { status: 400 },
      );
    }
    // A running omp process owns its session file; route the rename through it
    // so the in-memory title cannot clobber ours on the next flush. This runs
    // before the path check because omp does not create the session file until
    // the history holds an assistant message.
    let renamed = false;
    const rpc = getRpcSession(id);
    if (rpc?.isAlive?.() && typeof rpc.send === "function") {
      try {
        await rpc.send({ type: "set_session_name", name: name.trim() });
        renamed = true;
      } catch (error) {
        if (error instanceof WebRpcError && error.code === "session_busy")
          throw error;
        // Fall back to the on-disk title slot below.
      }
    }
    if (!renamed) {
      const resolved = await resolveSessionHostOr404(id);
      if ("response" in resolved) return resolved.response;
      // Resolution awaited: an Edit may have started on the current wrapper
      // since the failed native rename. Never bypass its fence with a file write.
      if (getRpcSession(id)?.isEditingHistory()) {
        throw new WebRpcError(
          "Wait for the history edit to finish",
          "session_busy",
        );
      }
      const result = await resolved.host.sessionOps.renameSessionFile(
        id,
        name.trim(),
      );
      if (!result.ok) return opErrorResponse(result);
      invalidateHostSessionList(resolved.host.id);
      return Response.json({ ok: true });
    }
    invalidateSessionCaches();
    return Response.json({ ok: true });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// DELETE /api/sessions/[id]
/**
 * @apiContract deleteSession
 * @apiUsage Permanently remove an active session from its owning host.
 * @apiInputs id identifies the session; no body is used.
 * @apiInvariants The host must be online; the live child is stopped and flushed before deletion. Live children are excluded from on-disk reparenting because their processes own their files.
 * @apiEffects Deletes the session, updates eligible child references, clears exited state and invalidates the host list; unpinned replacement metadata is cleaned up best-effort.
 * @apiRecovery A lost response may follow deletion; inspect the owning host before retrying. Offline or failed discovery is not evidence of deletion.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    // Await the child's exit before unlinking: omp flushes session state on
    // shutdown and would recreate the file if it were still running.
    // Disposing a child behind a down link would wait for the link to return.
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    const live = getRpcSession(id);
    if (!live?.hostOwnedLifecycle) await live?.destroyAndWait?.("delete", true);
    // Live children are skipped by the re-parent rewrite: their omp process
    // owns the file and would clobber it on its next flush.
    const result = await resolved.host.sessionOps.deleteSession(
      id,
      getLiveRpcSessionIds(),
    );
    if (!result.ok) return opErrorResponse(result);
    // Upstream retry lineages outlive settled rows to prevent duplicate sends.
    // Once deletion succeeds, discard only this session's unpinned metadata;
    // cleanup failure must not turn a successfully deleted session into an error.
    try {
      forgetSessionReplacementMappings(id);
    } catch (error) {
      console.warn(
        `[api/sessions] could not clear deleted-session retry metadata: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    invalidateHostSessionList(resolved.host.id);
    clearExitedRpcSession(id);
    return Response.json({ ok: true, ...result.value });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}
