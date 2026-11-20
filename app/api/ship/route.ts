import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import type { ShipRequest } from "@/lib/workspace-ship-types";

/**
 * @apiContract workspaceShipGet
 * @apiUsage Preview a ship operation.
 * @apiInputs Provide host, projectPath and path on the daemon machine.
 * @apiInvariants The host reports an existing open pull request when found; lookup failure is distinct from absence and does not block local shipping.
 * @apiEffects Returns a preview snapshot; it does not start shipping.
 * @apiRecovery Refresh the preview if repository state changes.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = resolveHostOrError(params.get("host") ?? undefined);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.shipPreview({
      projectPath: params.get("projectPath") ?? "",
      path: params.get("path") ?? "",
    });
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
/**
 * @apiContract workspaceShipPost
 * @apiUsage Start a ship job.
 * @apiInputs Send host and the ship input object. In PR modes, optionally send monitorSessionId for a chat in the same workspace.
 * @apiInvariants The host validates ship preconditions and chat ownership. The authenticated daemon link selects the server for notifications. A failed post-push lookup retains the job preview's PR, while a successful empty lookup does not. Job acceptance does not mean shipping is complete or monitoring has started.
 * @apiEffects Starts a host job that may mutate Git and remote state. Opted-in monitoring sends feedback links to chat without gating merges.
 * @apiRecovery Poll job status and inspect repository state after an uncertain response before starting another job.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (
      !isRecord(body) ||
      !isRecord(body.input) ||
      (body.host !== undefined && typeof body.host !== "string")
    )
      return Response.json(
        { error: "Invalid ship request", code: "invalid_request" },
        { status: 400 },
      );
    const resolved = resolveHostOrError(body.host);
    if ("response" in resolved) return resolved.response;
    if (
      body.input.monitorSessionId !== undefined &&
      !resolved.host.supportsWorkspaceOp("stopShipMonitor")
    )
      return Response.json(
        {
          error: "This host doesn't support PR monitoring",
          code: "unsupported_operation",
        },
        { status: 501 },
      );
    const result = await resolved.host.workspaceOps.startShip(
      body.input as unknown as ShipRequest,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
