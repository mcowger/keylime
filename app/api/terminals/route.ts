import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";

/**
 * @apiContract workspaceTerminalsGet
 * @apiUsage List terminals on a host.
 * @apiInputs Optional hostId selects the host and cwd filters its terminals.
 * @apiInvariants cwd is a daemon-machine path.
 * @apiEffects Returns a no-store snapshot; listing does not close terminals.
 * @apiRecovery Refresh the list after terminal state changes.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      null,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.terminals("list", {
      cwd: params.get("cwd"),
    });
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
 * @apiContract workspaceTerminalsPost
 * @apiUsage Create a host terminal.
 * @apiInputs Send hostId, cwd and optional cols and rows.
 * @apiInvariants The terminal belongs to the selected host; dimensions are terminal cells.
 * @apiEffects Starts a terminal process, which is distinct from a client connection.
 * @apiRecovery After a lost response list terminals before retrying to avoid creating another process.
 */
export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit(request, 65536);
    if (!isRecord(body) || typeof body.hostId !== "string")
      return Response.json(
        { error: "Invalid request", code: "invalid_request" },
        { status: 400 },
      );
    const resolved = await resolveWorkspaceHost(body.hostId, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.terminals("create", {
      cwd: body.cwd,
      cols: body.cols,
      rows: body.rows,
    });
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
