import { getRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { commandErrorResponse, runAgentCommand } from "@/lib/agent-command";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { requestOwner } from "@/lib/web-auth";

/** Stamp when the handler had the request and when it answered, so the browser
 * can split network time from server time. */
function timed(receivedAt: number, res: Response): Response {
  res.headers.set("x-omp-received-at", String(receivedAt));
  res.headers.set("x-omp-replied-at", String(Date.now()));
  return res;
}

// POST /api/agent/[id] - Send a command to an existing session
/**
 * @apiContract sendAgentCommand
 * @apiUsage Send an RPC command or manage held messages for an existing session.
 * @apiInputs The bounded JSON body needs a nonempty type; advisor=1 selects the advisor spawn flag. The optional hostId query selects the host, defaulting to local. Upload proofs belong to the caller's web session and are attached before sending.
 * @apiInvariants Outbox commands are handled by the web outbox, not directly by omp: acceptance is not delivery. Status reconciliation accepts 1 to 32 unique client message IDs. Some background commands do not spawn a process.
 * @apiEffects Commands may start or replace an idle RPC process, mutate session state, attach files, or queue and dispatch messages; response timing headers are milliseconds since epoch.
 * @apiRecovery On uncertain delivery reconcile client message IDs and inspect session/outbox state before resending; a transport failure does not prove the command was not executed.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Once the body is in, as a socket's ack is stamped after its whole frame: proxies stream uploads through, so the
  // handler starts before a large body has arrived. A body that fails to read is stamped when it failed.
  let receivedAt: number | undefined;

  try {
    const body = await parseJsonWithinLimit<unknown>(
      req,
      MAX_AGENT_COMMAND_REQUEST_BYTES,
    );
    receivedAt = Date.now();
    // The per-chat advisor choice rides on the query string (never the RPC
    // body, which is forwarded to omp verbatim) and only matters when this
    // request spawns or replaces the session's omp process.
    const query = new URL(req.url).searchParams;
    const advisor = query.get("advisor") === "1";
    const hostId = query.get("hostId") ?? "local";
    return timed(
      receivedAt,
      await runAgentCommand(id, body, advisor, requestOwner(req), undefined, {
        hostId,
      }),
    );
  } catch (error) {
    return timed(receivedAt ?? Date.now(), commandErrorResponse(error));
  }
}

// GET /api/agent/[id] - Get current agent state
/**
 * @apiContract getAgentState
 * @apiUsage Inspect the current web-owned RPC wrapper, not a durable session inventory.
 * @apiInputs id identifies the session; optional hostId selects the host, defaulting to local.
 * @apiInvariants A missing or dead wrapper returns running false; an unresponsive wrapper returns recovered true. This live request is not a cached transcript read.
 * @apiEffects A running wrapper receives get_state; no new process is spawned.
 * @apiRecovery For durable or exited state and held messages use session state; retry a read after connectivity or responsiveness recovers.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const hostId = new URL(req.url).searchParams.get("hostId") ?? "local";
    const session = getRpcSession(id, hostId);
    if (!session || !session.isAlive()) {
      return Response.json({ running: false });
    }
    try {
      const state = await session.send({ type: "get_state" });
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
  } catch (error) {
    return commandErrorResponse(error);
  }
}
