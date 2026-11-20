import {
  apiErrorResponse,
  opErrorResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { isValidSubagentId } from "@/lib/hosts/session-ops";

/**
 * GET /api/sessions/[id]/subagents/[subagentId]?fromByte=N
 *
 * Default: paged transcript of one subagent, read directly from the parent
 * session's sibling artifacts dir. Mirrors the RPC get_subagent_messages
 * response shape so the dialog can fall back to it when no live RPC process
 * knows the file.
 *
 * ?mode=completion: the subagent's final output (`<id>.md`), without loading
 * the transcript — works even for transcripts beyond the readable size cap.
 */
/**
 * @apiContract getSessionSubagent
 * @apiUsage Read a subagent transcript page or its final completion artifact from the parent host.
 * @apiInputs id and a valid subagentId identify the artifacts; fromByte is a numeric byte offset defaulting to zero. mode=completion selects final output; other values select transcript paging. Optional hostId selects the host; omission selects local.
 * @apiInvariants Completion reads the separate final markdown without loading the transcript and can work when the transcript exceeds its read cap; paging is not a completion signal.
 * @apiEffects Reads persisted sibling artifacts; no agent process is started.
 * @apiRecovery Continue pages using the returned byte position; request completion separately when available, and refresh if an active subagent has not yet written its final artifact.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; subagentId: string }> },
) {
  const { id, subagentId } = await params;
  const hostId = new URL(req.url).searchParams.get("hostId") ?? "local";
  try {
    if (!isValidSubagentId(subagentId)) {
      return Response.json(
        { error: "Invalid subagent id", code: "invalid_subagent_id" },
        { status: 400 },
      );
    }
    const resolved = await resolveSessionHostOr404(id, hostId);
    if ("response" in resolved) return resolved.response;
    const searchParams = new URL(req.url).searchParams;
    const fromByteRaw = searchParams.get("fromByte");
    const result = await resolved.host.sessionOps.readSubagentTranscript(
      id,
      subagentId,
      searchParams.get("mode") === "completion" ? "completion" : "page",
      fromByteRaw !== null ? Number(fromByteRaw) : 0,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
