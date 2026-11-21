import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";

/**
 * @apiContract workspaceShipFinish
 * @apiUsage Finish the ship workflow for a workspace.
 * @apiInputs Send host, projectPath and path as daemon-machine paths.
 * @apiInvariants Cleanup requires a merged PR recorded for this exact registered workspace ID; path reuse and records without an ID are refused.
 * @apiEffects Requests the host finish operation, which can change workspace state.
 * @apiRecovery Inspect workspace and ship state after uncertainty before repeating the request.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (
      !isRecord(body) ||
      typeof body.projectPath !== "string" ||
      typeof body.path !== "string" ||
      (body.host !== undefined && typeof body.host !== "string")
    )
      return Response.json(
        { error: "Invalid ship request", code: "invalid_request" },
        { status: 400 },
      );
    const resolved = resolveHostOrError(body.host);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.shipFinish({
      projectPath: body.projectPath,
      path: body.path,
    });
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
