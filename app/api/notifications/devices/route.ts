import {
  isValidNotificationId,
  parseNotificationPrefs,
} from "@/lib/notification-events";
import { getVapidPublicKey } from "@/lib/notification-hub";
import {
  getDevice,
  parsePushSubscription,
  saveDevice,
} from "@/lib/notification-store";
import { isRecord } from "@/lib/type-guards";

/** GET /api/notifications/devices?deviceId= — VAPID public key and whether this device has a push subscription. */
/**
 * @apiContract getNotificationsDevices
 * @apiUsage Fetch the VAPID public key and this browser device's push status before subscribing.
 * @apiInputs Optional deviceId query parameter: 8–64 ASCII letters, digits, underscores or hyphens.
 * @apiInvariants Missing or invalid deviceId is treated as an unknown device, not an error.
 * @apiEffects Returns publicKey and subscribed; obtaining the key can generate and persist VAPID keys.
 * @apiRecovery If unsubscribed, register a browser push subscription and save it with PUT.
 */
export async function GET(req: Request) {
  const deviceId = new URL(req.url).searchParams.get("deviceId");
  const device = isValidNotificationId(deviceId)
    ? getDevice(deviceId)
    : undefined;
  return Response.json({
    publicKey: getVapidPublicKey(),
    subscribed: Boolean(device?.subscription),
  });
}

/** PUT /api/notifications/devices { deviceId, prefs, subscription? } — an omitted subscription keeps the stored one. */
/**
 * @apiContract putNotificationsDevices
 * @apiUsage Synchronize this device's notification preferences and optionally its push subscription.
 * @apiInputs JSON deviceId (8–64 ASCII letters, digits, underscores or hyphens), prefs and optional subscription with HTTPS endpoint and push keys.
 * @apiInvariants Omitted subscription preserves the stored one; invalid or missing preference fields use defaults, rather than preserving previous preferences. A push endpoint belongs to one device.
 * @apiEffects Persists the device, may evict another device with the same endpoint, and returns subscribed.
 * @apiRecovery On 400 invalid_device or invalid_subscription, correct the submitted device ID or subscription and retry.
 */
export async function PUT(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!isRecord(body) || !isValidNotificationId(body.deviceId)) {
    return Response.json(
      { error: "deviceId is required", code: "invalid_device" },
      { status: 400 },
    );
  }
  const subscription =
    body.subscription === undefined
      ? undefined
      : parsePushSubscription(body.subscription);
  if (subscription === null)
    return Response.json(
      { error: "Invalid push subscription", code: "invalid_subscription" },
      { status: 400 },
    );
  const device = saveDevice(
    body.deviceId,
    parseNotificationPrefs(body.prefs),
    subscription,
  );
  return Response.json({ subscribed: Boolean(device.subscription) });
}
