import { isValidNotificationId } from "@/lib/notification-events";
import { reportPresence } from "@/lib/notification-hub";
import { isRecord } from "@/lib/type-guards";

/** POST /api/notifications/presence { clientId, deviceId, visible, hostId, sessionId, seq } — which conversation this tab shows. */
/**
 * @apiContract postNotificationsPresence
 * @apiUsage Report tab activity and the conversation currently on screen; refresh while present and on visibility or session changes.
 * @apiInputs JSON clientId and deviceId (8–64 ASCII letters, digits, underscores or hyphens), boolean visible, safe-integer seq, and optional hostId and sessionId.
 * @apiInvariants Missing, empty or non-string hostId or sessionId means no visible conversation. Sequence numbers order reports per client: strictly older reports are ignored, while equal numbers replace the report. Presence expires after 60 seconds.
 * @apiEffects Updates in-memory routing presence and returns 204, including for an ignored older report.
 * @apiRecovery On 400 invalid_presence correct the report; send a newer sequence on subsequent updates or refreshes.
 */
export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (
    !isRecord(body) ||
    !isValidNotificationId(body.clientId) ||
    !isValidNotificationId(body.deviceId) ||
    typeof body.visible !== "boolean" ||
    !Number.isSafeInteger(body.seq)
  ) {
    return Response.json(
      { error: "Invalid presence report", code: "invalid_presence" },
      { status: 400 },
    );
  }
  const hostId =
    typeof body.hostId === "string" && body.hostId ? body.hostId : null;
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId
      ? body.sessionId
      : null;
  reportPresence({
    clientId: body.clientId,
    deviceId: body.deviceId,
    visible: body.visible,
    hostId: sessionId ? hostId : null,
    sessionId: hostId ? sessionId : null,
    seq: Number(body.seq),
  });
  return new Response(null, { status: 204 });
}
