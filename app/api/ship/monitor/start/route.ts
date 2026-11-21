import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  ShipPrMonitorSchema,
  ShipStartMonitorHttpRequestSchema,
} from "@/lib/api-contracts/workspace-models";
import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { getShipHostCredential } from "@/lib/hosts/hub";
import { HostOpError } from "@/lib/hosts/link-protocol";
import {
  insertShipMonitorGrant,
  revokeShipMonitorGrant,
} from "@/lib/message-outbox";

/**
 * @apiContract workspaceShipMonitorStart
 * @apiUsage Start PR feedback monitoring for an already recorded open PR.
 * @apiInputs Send host, projectPath, path, the expected canonical prUrl and a sessionId for an active chat in the workspace.
 * @apiInvariants The host must support start and status. The recorded PR must belong to the current workspace ID; the host checks the chat and never replaces an existing watch. The server pins the grant to the authenticated host, workspace, chat and exact PR URL.
 * @apiEffects Starts a watch that sends feedback links to the chat without running Ship or changing the PR or its merge settings.
 * @apiRecovery Refresh the workspace hierarchy before retrying after an uncertain response. The watch may be active even if the start response was lost.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (
      !Value.Check(ShipStartMonitorHttpRequestSchema, body) ||
      body.prUrl.trim() !== body.prUrl ||
      !Number.isSafeInteger(
        Number(body.prUrl.slice(body.prUrl.lastIndexOf("/") + 1)),
      )
    )
      return Response.json(
        { error: "Invalid start monitoring request", code: "invalid_request" },
        { status: 400 },
      );

    const resolved = resolveHostOrError(body.host);
    if ("response" in resolved) return resolved.response;
    const { host } = resolved;
    if (
      !host.supportsWorkspaceOp("startShipMonitor") ||
      !host.supportsWorkspaceOp("shipMonitorStatus")
    )
      return Response.json(
        {
          error: "This host doesn't support starting PR monitoring",
          code: "unsupported_operation",
        },
        { status: 501 },
      );

    const credential = getShipHostCredential(host.id);
    if (!credential)
      throw new HostOpError(503, "host_offline", "No authenticated host link");
    const { projectPath, path, prUrl, sessionId } = body;
    const monitorId = randomUUID();
    const grant = {
      monitorId,
      hostId: host.id,
      credential,
      projectPath,
      path,
      sessionId,
    };
    insertShipMonitorGrant(grant, prUrl);

    let result;
    try {
      result = await host.workspaceOps.startShipMonitor({
        projectPath,
        path,
        prUrl,
        sessionId,
        monitorId,
      });
    } catch (error) {
      // Revoke only for known pre-execution refusals. host_offline can also
      // mean the link dropped after the request reached the daemon.
      if (
        error instanceof HostOpError &&
        (error.code === "workspace_unsupported" ||
          error.code === "host_request_too_large" ||
          error.code === "server_stopping" ||
          error.code === "unknown_op" ||
          error.code === "host_stopping" ||
          error.code === "host_drained" ||
          error.code === "link_not_authenticated")
      )
        revokeShipMonitorGrant(grant);
      throw error;
    }
    if (!result.ok) {
      // A structured client error is a refusal from the workspace operation.
      // Keep the grant on server errors: the watch may already be active.
      if (result.status >= 400 && result.status < 500)
        revokeShipMonitorGrant(grant);
      return opErrorResponse(result);
    }
    if (
      !Value.Check(ShipPrMonitorSchema, result.value) ||
      result.value.id !== monitorId
    )
      throw new HostOpError(
        502,
        "host_bad_result",
        "Invalid PR monitor result",
      );
    return Response.json(result.value);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
