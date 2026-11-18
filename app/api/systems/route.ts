import { Value } from "@sinclair/typebox/value";
import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import {
  SystemsHttpPostSchema,
  type SystemsRequest,
} from "@/lib/api-contracts/systems";
import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";

const MAX_BODY_BYTES = 384 * 1024;

async function systems(host: string | undefined, input: SystemsRequest) {
  const resolved = resolveHostOrError(host);
  if ("response" in resolved) return resolved.response;
  const result = await resolved.host.workspaceOps.systems(input);
  return result.ok
    ? Response.json(result.value, { headers: { "cache-control": "no-store" } })
    : opErrorResponse(result);
}

/**
 * @apiContract workspaceSystemsGet
 * @apiUsage List Systems and Efforts on one daemon.
 * @apiInputs Optional host selects a daemon; omit it for the local host.
 * @apiInvariants All returned paths and live terminal IDs belong to that daemon.
 * @apiEffects Returns a no-store snapshot without changing definitions or starting jobs.
 * @apiRecovery Refresh after updates, during setup, or after reconnecting to the host.
 */
export async function GET(request: Request) {
  try {
    const host = new URL(request.url).searchParams.get("host") ?? undefined;
    return await systems(host, { action: "list" });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * @apiContract workspaceSystemsPost
 * @apiUsage Preview, create, update, or clean up Systems and Efforts, or control a saved service.
 * @apiInputs Send optional host and action-specific input as JSON, at most 384 KiB. Creation and cleanup require preview confirmation.
 * @apiInvariants An Effort keeps its captured definitions and paths. Service controls select a saved service by ID; they do not take a command or environment override.
 * @apiEffects Actions may persist definitions, admit setup jobs, start or stop service PTYs, or clean up registered worktrees. Service output uses the existing terminal channel.
 * @apiRecovery List host state after uncertain delivery rather than repeating mutations. Retry setup explicitly and refresh the cleanup preview before resuming removal.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json(
        { error: "Systems request is too large", code: "request_too_large" },
        { status: 413 },
      );
    return Response.json(
      { error: "Invalid JSON request body", code: "invalid_json" },
      { status: 400 },
    );
  }
  if (!Value.Check(SystemsHttpPostSchema, body))
    return Response.json(
      { error: "Invalid Systems request", code: "invalid_request" },
      { status: 400 },
    );
  try {
    return await systems(body.host, body.input);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
