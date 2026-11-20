import { randomUUID } from "node:crypto";
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
import { isValidSessionId } from "@/lib/session-file-references-core";
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
 * @apiInvariants Monitoring requires host shipMonitorStatus support. The server issues the monitor grant; the host validates ship preconditions and chat ownership. Job acceptance does not mean shipping is complete or monitoring has started.
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
    const { host } = resolved;
    const {
      projectPath,
      path,
      mode,
      rebase,
      cleanup,
      pr,
      mergeMethod,
      monitorSessionId,
    } = body.input;
    // Only pass public Ship fields through; the grant ID is never client input.
    const input = {
      projectPath,
      path,
      mode,
      rebase,
      cleanup,
      pr,
      mergeMethod,
      monitorSessionId,
    } as ShipRequest;
    if (monitorSessionId === undefined) {
      const result = await host.workspaceOps.startShip(input);
      return result.ok ? Response.json(result.value) : opErrorResponse(result);
    }
    if (!host.supportsWorkspaceOp("shipMonitorStatus"))
      return Response.json(
        {
          error: "This host doesn't support PR monitoring",
          code: "unsupported_operation",
        },
        { status: 501 },
      );
    if (
      (mode !== "pr" && mode !== "pr-auto") ||
      typeof monitorSessionId !== "string" ||
      !isValidSessionId(monitorSessionId) ||
      typeof projectPath !== "string" ||
      !projectPath ||
      typeof path !== "string" ||
      !path
    )
      return Response.json(
        { error: "Invalid ship monitoring request", code: "invalid_request" },
        { status: 400 },
      );
    const credential = getShipHostCredential(host.id);
    if (!credential)
      throw new HostOpError(503, "host_offline", "No authenticated host link");
    const monitorId = randomUUID();
    const grant = {
      monitorId,
      hostId: host.id,
      credential,
      projectPath,
      path,
      sessionId: monitorSessionId,
    };
    insertShipMonitorGrant(grant);
    let result;
    try {
      result = await host.workspaceOps.startShip({
        ...input,
        monitorGrantId: monitorId,
      });
    } catch (error) {
      // A timeout, disconnect, or malformed reply doesn't prove the job failed to start.
      if (
        error instanceof HostOpError &&
        ((error.status >= 400 && error.status < 500) ||
          error.code === "workspace_unsupported")
      )
        revokeShipMonitorGrant(grant);
      throw error;
    }
    // A structured start rejection comes from the host operation, not the link.
    if (!result.ok) revokeShipMonitorGrant(grant);
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
