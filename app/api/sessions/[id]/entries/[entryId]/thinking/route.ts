import {
  apiErrorResponse,
  opErrorResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";

/**
 * @apiContract getSessionThinking
 * @apiUsage Fetch a deferred thinking block from persisted session history.
 * @apiInputs id and entryId identify the session and entry; blockIndex is a required nonnegative safe integer identifying its content block.
 * @apiInvariants The owning host reads the requested block; this is not a live stream or an independent session authorization.
 * @apiEffects Reads stored content without starting an agent process.
 * @apiRecovery If the entry or block is no longer available, refresh the selected history before requesting it again.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  const blockIndexParam = new URL(req.url).searchParams.get("blockIndex");
  const blockIndex =
    blockIndexParam === null ? Number.NaN : Number(blockIndexParam);
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    return Response.json(
      { error: "Valid blockIndex is required", code: "invalid_block_index" },
      { status: 400 },
    );
  }

  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.readThinking(
      id,
      entryId,
      blockIndex,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
