import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { loadHosts, LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { revokeShipMonitorGrant } from "@/lib/message-outbox";
import { isRecord } from "@/lib/type-guards";

/**
 * @apiContract workspaceShipMonitorStop
 * @apiUsage Stop PR feedback monitoring for a workspace.
 * @apiInputs Send host, projectPath, path and the monitorId from the workspace PR state.
 * @apiInvariants Only the initiating server link can stop the monitor; a stale id cannot stop a replacement.
 * @apiEffects Revokes the scoped server grant before attempting to stop the daemon watch, even if the host is offline. Does not change the PR or its merge settings.
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
    const hostId = body.host ?? LOCAL_HOST_ID;
    const credential = loadHosts().find(
      (host) => host.id === hostId,
    )?.tokenHash;
    const scope = {
      projectPath: body.projectPath,
      path: body.path,
      monitorId: body.monitorId,
    };
    if (credential) revokeShipMonitorGrant({ ...scope, hostId, credential });
    const resolved = resolveHostOrError(hostId);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.stopShipMonitor(scope);
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
