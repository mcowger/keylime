import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";

/**
 * @apiContract workspaceShipMonitorStop
 * @apiUsage Stop PR feedback monitoring for a workspace.
 * @apiInputs Send host, projectPath, path and the monitorId from the workspace PR state.
 * @apiInvariants Only the initiating server link can stop the monitor; a stale id cannot stop a replacement.
 * @apiEffects Stops feedback notifications without changing the PR or its merge settings.
 * @apiRecovery Refresh workspace state before retrying after an uncertain response.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (
      !isRecord(body) ||
      typeof body.projectPath !== "string" ||
      typeof body.path !== "string" ||
      typeof body.monitorId !== "string" ||
      !body.monitorId ||
      (body.host !== undefined && typeof body.host !== "string")
    )
      return Response.json(
        { error: "Invalid stop monitoring request", code: "invalid_request" },
        { status: 400 },
      );
    const resolved = resolveHostOrError(body.host);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.stopShipMonitor({
      projectPath: body.projectPath,
      path: body.path,
      monitorId: body.monitorId,
    });
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
