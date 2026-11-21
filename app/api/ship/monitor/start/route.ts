import { Value } from "@sinclair/typebox/value";
import { ShipStartMonitorHttpRequestSchema } from "@/lib/api-contracts/workspace-models";
import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { startShipMonitorForHost } from "@/lib/ship-monitor-start";

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
    const { projectPath, path, prUrl, sessionId } = body;
    const result = await startShipMonitorForHost(host, {
      projectPath,
      path,
      prUrl,
      sessionId,
    });
    if (!result.ok) return opErrorResponse(result);
    return Response.json(result.value);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
