import { readBodyWithinLimit } from "@/lib/bounded-form-data";
import {
  abortUpload,
  putUploadChunk,
  uploadErrorResponse,
} from "@/lib/uploads";
import { requestOwner } from "@/lib/web-auth";

type Params = { params: Promise<{ id: string }> };

/** Largest PUT body: cut into pieceBytes frames and answered once the host acked its end (spec U4). */
const MAX_CHUNK_BYTES = 1024 * 1024;

/** PUT /api/uploads/<id>?offset=N → {received, done}: the next bytes of the upload, at the host's offset (else 409
 * upload_offset with `received`). */
/**
 * @apiContract workspaceUploadChunk
 * @apiUsage Append the next binary chunk to a staged upload.
 * @apiInputs The id identifies an upload owned by the current web session; offset is a nonnegative safe-integer byte count and the raw body is at most 1 MiB.
 * @apiInvariants The offset must equal the host’s received byte count; a mismatch returns 409 with received.
 * @apiEffects Advances staged data and returns done and, on completion, a proof for later claiming.
 * @apiRecovery On offset conflict resume from received. After an uncertain response replay upload start with the same id, name, type and size to obtain the host's acknowledged offset before resending bytes.
 */
export async function PUT(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const raw = new URL(req.url).searchParams.get("offset") ?? "";
    const offset = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(offset))
      return Response.json(
        { error: "offset must be a byte offset", code: "invalid_request" },
        { status: 400 },
      );
    const body = await readBodyWithinLimit(req, MAX_CHUNK_BYTES);
    return Response.json(
      await putUploadChunk(id, requestOwner(req), offset, body),
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

/** DELETE /api/uploads/<id>?host=<hostId>: cancel the upload and delete its staged file, now or on the host's next hello.
 * `host` reaches an upload this server no longer registers. */
/**
 * @apiContract workspaceUploadDelete
 * @apiUsage Abort a staged upload.
 * @apiInputs Use the upload id and optional registered owning host id when this web server no longer has the upload's in-memory registration.
 * @apiInvariants The request is scoped to the upload owner.
 * @apiEffects Deletes staged data immediately or queues cleanup for the host’s next hello.
 * @apiRecovery A 204 does not imply an offline host has already deleted its staged file.
 */
export async function DELETE(req: Request, { params }: Params) {
  const host = new URL(req.url).searchParams.get("host");
  await abortUpload(
    (await params).id,
    requestOwner(req),
    host && host.length <= 128 ? host : undefined,
  );
  return new Response(null, { status: 204 });
}
