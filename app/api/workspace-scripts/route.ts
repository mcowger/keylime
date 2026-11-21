import { Value } from "@sinclair/typebox/value";
import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import {
  WorkspaceScriptListRequestSchema,
  WorkspaceScriptsHttpPostSchema,
} from "@/lib/api-contracts/workspace-models";
import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * @apiContract workspaceScriptsGet
 * @apiUsage List named Paseo scripts and their retained runs for a workspace.
 * @apiInputs Optional hostId selects the owning host; cwd identifies the workspace on that host.
 * @apiInvariants Running indicates a live process, not service readiness. Unconfigured retained runs remain visible.
 * @apiEffects Returns a no-store snapshot without starting or stopping processes.
 * @apiRecovery Refresh after state changes or an uncertain mutation.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const input = { action: "list" as const, cwd: params.get("cwd") };
    if (!Value.Check(WorkspaceScriptListRequestSchema, input))
      return Response.json(
        { error: "Invalid workspace scripts request", code: "invalid_request" },
        { status: 400 },
      );
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      null,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.workspaceScripts(input);
    return result.ok
      ? Response.json(result.value, {
          headers: { "cache-control": "no-store" },
        })
      : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * @apiContract workspaceScriptsPost
 * @apiUsage Launch a named Paseo script or stop a retained run.
 * @apiInputs Send hostId, cwd and either a launch action with name or a stop action with terminalId, as at most 64 KiB of JSON.
 * @apiInvariants Commands are selected by exact recipe name on the owning host; requests do not supply shell text. A successful launch does not imply readiness.
 * @apiEffects Launch starts a host terminal; stop ends the run while retaining its screen.
 * @apiRecovery List runs after an uncertain response before retrying a mutation.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json(
        {
          error: "Workspace scripts request is too large",
          code: "request_too_large",
        },
        { status: 413 },
      );
    return Response.json(
      { error: "Invalid JSON request body", code: "invalid_json" },
      { status: 400 },
    );
  }
  if (!Value.Check(WorkspaceScriptsHttpPostSchema, body))
    return Response.json(
      { error: "Invalid workspace scripts request", code: "invalid_request" },
      { status: 400 },
    );
  try {
    const { hostId, ...input } = body;
    const resolved = await resolveWorkspaceHost(hostId, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.workspaceScripts(input);
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
