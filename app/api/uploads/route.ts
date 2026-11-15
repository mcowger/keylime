import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import { startUpload, uploadErrorResponse } from "@/lib/uploads";
import { requestOwner } from "@/lib/web-auth";

/** The HTTP form waits on each chunk's ack in its PUT: a start has no one to tell. */
const NO_SINK = { ack() {}, error() {} };

/** POST /api/uploads {id, host, name, size, type} → {received}: open, or resume, an upload on `host` (spec U4, the
 * HTTP form of `up_start`). */
/**
 * @apiContract workspaceUploadStart
 * @apiUsage Open or resume an owner-bound staged upload.
 * @apiInputs Send id, host, name, size in bytes and type.
 * @apiInvariants The upload id is bound to its owner and host; matching generation metadata matters when resuming.
 * @apiEffects Creates or resumes staged host data and returns received bytes and possibly a completion proof.
 * @apiRecovery Use the returned offset to resume; do not assume a lost response means nothing was staged.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<unknown>(req, 16 * 1024);
    if (!isRecord(body))
      return Response.json(
        { error: "Invalid upload", code: "invalid_request" },
        { status: 400 },
      );
    const { id, host, name, size, type } = body;
    // startUpload checks every field's type.
    return Response.json(
      await startUpload({
        id,
        hostId: host,
        owner: requestOwner(req),
        name,
        size,
        type,
        sink: NO_SINK,
      } as Parameters<typeof startUpload>[0]),
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
