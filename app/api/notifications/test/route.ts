import { isValidNotificationId } from "@/lib/notification-events";
import { sendTestPush } from "@/lib/notification-hub";
import { isRecord } from "@/lib/type-guards";

/** POST /api/notifications/test { deviceId } — one push to this device; 502 when the push service refuses it. */
/**
 * @apiContract postNotificationsTest
 * @apiUsage Send a test push to the specified device and report whether the push service accepted it.
 * @apiInputs JSON deviceId of 8–64 ASCII letters, digits, underscores or hyphens.
 * @apiInvariants This is one push attempt, not a delivery receipt; test events do not enter normal notification history.
 * @apiEffects Sends a test push and returns 204 on acceptance; a rejected subscription may be removed.
 * @apiRecovery Correct a 400 invalid_device; for 502 push_failed, inspect the error and restore the device subscription or push service before retrying.
 */
export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!isRecord(body) || !isValidNotificationId(body.deviceId)) {
    return Response.json(
      { error: "deviceId is required", code: "invalid_device" },
      { status: 400 },
    );
  }
  const result = await sendTestPush(body.deviceId);
  return result.ok
    ? new Response(null, { status: 204 })
    : Response.json(
        { error: result.error, code: "push_failed" },
        { status: 502 },
      );
}
