import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import {
  clearHistory,
  listHistory,
  markHistoryRead,
  removeHistory,
} from "@/lib/notification-store";
import { isRecord } from "@/lib/type-guards";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_IDS = 100;
const MAX_ID_LENGTH = 256;

const invalid = () =>
  Response.json(
    { error: "Invalid history request", code: "invalid_history_request" },
    { status: 400 },
  );
const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH;

/** GET /api/notifications/history — every entry, newest first. */
/**
 * @apiContract getNotificationsHistory
 * @apiUsage Load the persistent notification center history.
 * @apiInputs No parameters.
 * @apiInvariants Entries are newest first, limited to the latest 100; events requested by at least one enabled device are recorded even if undelivered. Old entries without a host remain readable and have no session link.
 * @apiEffects Returns entries without marking them read.
 * @apiRecovery Reload history to reconcile the client mirror after a failed mutation.
 */
export async function GET() {
  return Response.json({ entries: listHistory() });
}

/** PATCH /api/notifications/history { ids } — mark entries read. A client marks what it shows, never entries it has not seen. */
/**
 * @apiContract patchNotificationsHistory
 * @apiUsage Mark only entries the client has shown as read.
 * @apiInputs JSON ids array of at most 100 nonempty strings, each at most 256 characters; body limit 32 KiB.
 * @apiInvariants Unknown IDs and an empty array are harmless; replacing a host/session/type entry later creates a new notification with its own read state.
 * @apiEffects Marks matching stored entries read and returns ok.
 * @apiRecovery Correct malformed requests after 400 invalid_history_request or reduce the body after 413 request_too_large.
 */
export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json(
        { error: "History request is too large", code: "request_too_large" },
        { status: 413 },
      );
    return invalid();
  }
  if (
    !isRecord(body) ||
    !Array.isArray(body.ids) ||
    body.ids.length > MAX_IDS ||
    !body.ids.every(isId)
  )
    return invalid();
  markHistoryRead(body.ids);
  return Response.json({ ok: true });
}

/**
 * DELETE /api/notifications/history?id=<id> removes one entry; ?all=1 clears the history.
 * Never a body: proxies may drop one, and a lost id must not become "clear everything".
 */
/**
 * @apiContract deleteNotificationsHistory
 * @apiUsage Remove one history entry by id or explicitly clear all history.
 * @apiInputs Query id is a nonempty string up to 256 characters; alternatively use all=1 with no id. No body is read.
 * @apiInvariants A valid id takes precedence over all; an invalid present id never clears history. Unknown IDs are harmless.
 * @apiEffects Deletes the selected entry or all entries and returns ok.
 * @apiRecovery On 400 invalid_history_request, supply a valid id or omit id and explicitly set all=1.
 */
export async function DELETE(req: Request) {
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  if (isId(id)) removeHistory(id);
  else if (id === null && params.get("all") === "1") clearHistory();
  else return invalid();
  return Response.json({ ok: true });
}
