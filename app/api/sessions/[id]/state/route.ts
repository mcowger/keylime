import {
  getExitedRpcSession,
  getRpcSession,
  WebRpcError,
} from "@/lib/rpc-manager";
import {
  apiErrorResponse,
  opErrorResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";
import { outboxScope, outboxSnapshot } from "@/lib/message-outbox";

/** Every answer, an offline host's 503 included, carries the session's held messages (`outbox`): a tab opening a
 * session with no omp running learns from it that there is an outbox to subscribe to. */
/**
 * @apiContract getSessionState
 * @apiUsage Reconcile live, exited or host session state together with the web outbox snapshot.
 * @apiInputs id identifies the session; optional hostId selects the host, defaulting to local.
 * @apiInvariants Outbox entries, scope and settlement identifiers accompany every response, including errors and offline hosts. A live wrapper is queried first, then exited state or host state; these are not one atomic snapshot.
 * @apiEffects Reads outbox state and may send get_state to a running wrapper; it does not start an agent.
 * @apiRecovery Treat queued acceptance and settled IDs according to their reported status, not as proof of delivery; reconcile uncertain message IDs before resending and refresh after reconnect.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const hostId = new URL(req.url).searchParams.get("hostId") ?? "local";
  const response = await sessionState(id, hostId);
  const { entries, settledIds, ...settlements } = outboxSnapshot(id, hostId);
  return Response.json(
    {
      ...((await response.json()) as object),
      outbox: entries,
      outboxScope: outboxScope(),
      outboxSettledIds: settledIds,
      ...settlements,
    },
    { status: response.status },
  );
}

async function sessionState(id: string, hostId: string): Promise<Response> {
  try {
    // A live process proves the session exists: omp does not create the session
    // file until the history holds an assistant message, so the path check
    // below would 404 a brand-new running session.
    const rpc = getRpcSession(id, hostId);
    if (rpc?.isAlive()) {
      try {
        const state = await rpc.send({ type: "get_state" });
        return Response.json({ running: true, state });
      } catch (error) {
        if (
          error instanceof WebRpcError &&
          error.code === "session_unresponsive"
        ) {
          return Response.json({ running: false, recovered: true });
        }
        throw error;
      }
    }

    const exited = getExitedRpcSession(id, hostId);
    if (exited) return Response.json({ running: false, exited });

    const resolved = await resolveSessionHostOr404(id, hostId);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.readSessionState(id);
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
