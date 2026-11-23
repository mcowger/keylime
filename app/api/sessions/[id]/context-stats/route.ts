import {
  apiErrorResponse,
  opErrorResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";

/**
 * @apiContract getSessionContextStats
 * @apiUsage Read metadata-only context statistics for the current display branch.
 * @apiInputs id identifies the session; optional hostId selects the owning host, defaulting to local.
 * @apiInvariants Counts and usage follow the active branch and compaction boundary. Up to 32 plausible timestamp-derived speed samples are returned; no transcript bodies cross the host link or HTTP response. A changing file generation is rejected.
 * @apiEffects Reads the session file on its owning host without spawning a runner. The response is not cached.
 * @apiRecovery Retry after session_history_changed; upgrade the owning host daemon if it does not support context statistics.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const hostId = new URL(req.url).searchParams.get("hostId") ?? "local";
  try {
    const resolved = await resolveSessionHostOr404(id, hostId);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.readContextStats(id);
    if (!result.ok) return opErrorResponse(result);
    return Response.json(result.value, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
