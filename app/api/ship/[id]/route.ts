import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";

/**
 * @apiContract workspaceShipStatus
 * @apiUsage Inspect a ship job.
 * @apiInputs Provide job id and optional host.
 * @apiInvariants The job belongs to the selected host; a status response is not itself completion.
 * @apiEffects Reads the current job snapshot.
 * @apiRecovery Poll until a terminal state; handle a missing job or unavailable host explicitly.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = resolveHostOrError(
      new URL(request.url).searchParams.get("host") ?? undefined,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.shipStatus(
      (await context.params).id,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
