import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import {
  EventStreamConnection,
  getEventStreamConnection,
} from "@/lib/event-stream-hub";
import {
  parseEventStreamRequest,
  UNKNOWN_CONNECTION_CODE,
} from "@/lib/event-stream-protocol";

const MAX_REQUEST_BYTES = 16 * 1024;

// GET /api/events — the browser's single multiplexed live-event stream.
// Subscriptions are attached with POST (see lib/event-stream-protocol.ts).
/**
 * @apiContract getEvents
 * @apiUsage Open the shared worker's multiplexed SSE stream for browser tabs; attach channels separately with POST.
 * @apiInputs Request abort signal owns the stream lifetime; no channel is selected by this GET.
 * @apiInvariants A mux hello supplies connectionId, serverId and transport; channel events use subscription IDs as event names. Subscribing to a session observes an existing wrapper and does not spawn one.
 * @apiEffects Registers a process-local connection, disables idle timeout and sends heartbeats; abort or stream closure releases its subscriptions.
 * @apiRecovery Reconnect after closure and resubscribe using the new hello connectionId; serverId changes on restart.
 */
export function GET(
  req: Request,
  { disableIdleTimeout }: { disableIdleTimeout: () => void },
) {
  disableIdleTimeout();
  const connection = new EventStreamConnection(req.signal);
  return new Response(connection.stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// POST /api/events — { connectionId, subscribe: { id, channel } } | { connectionId, unsubscribe }
/**
 * @apiContract postEvents
 * @apiUsage Add or remove a channel subscription on the SSE connection announced by its mux hello.
 * @apiInputs JSON up to 16 KiB contains connectionId and either subscribe with id and channel or unsubscribe id; subscription IDs match s followed by 1 to 15 digits.
 * @apiInvariants Subscriptions belong to that process-local connection, not individual HTTP requests; session channels observe existing managed sessions or held outbox work and never spawn a process.
 * @apiEffects Opens or releases the requested channel and returns ok on success.
 * @apiRecovery Malformed requests return 400 or 413; unknown connections return 404 unknown_connection, requiring a fresh stream and resubscription. Channel-specific errors retain their status and code.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(req, MAX_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return Response.json(
      {
        error: "Invalid event stream request",
        code: "invalid_event_stream_request",
      },
      { status },
    );
  }
  const request = parseEventStreamRequest(body);
  if (!request) {
    return Response.json(
      {
        error: "Invalid event stream request",
        code: "invalid_event_stream_request",
      },
      { status: 400 },
    );
  }
  const connection = getEventStreamConnection(request.connectionId);
  if (!connection) {
    return Response.json(
      {
        error: "Unknown event stream connection",
        code: UNKNOWN_CONNECTION_CODE,
      },
      { status: 404 },
    );
  }
  if ("unsubscribe" in request) {
    connection.unsubscribe(request.unsubscribe);
    return Response.json({ ok: true });
  }
  const result = await connection.subscribe(
    request.subscribe.id,
    request.subscribe.channel,
  );
  return result.ok
    ? Response.json({ ok: true })
    : Response.json(
        { error: result.error, code: result.code },
        { status: result.status },
      );
}
