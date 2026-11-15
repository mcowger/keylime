import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";

type Context = { params: Promise<{ id: string }> };
/**
 * @apiContract workspaceTerminalGet
 * @apiUsage Read a terminal snapshot.
 * @apiInputs Use terminal id and optional hostId; the host returns its current snapshot.
 * @apiInvariants The id refers to a terminal on the selected host.
 * @apiEffects Reads terminal state; it does not close the terminal.
 * @apiRecovery Read again for newer output or after reconnecting.
 */
export async function GET(request: Request, context: Context) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      null,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.terminals("snapshot", {
      id: (await context.params).id,
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
 * @apiContract workspaceTerminalPost
 * @apiUsage Send input or update terminal state.
 * @apiInputs Use terminal id, hostId and the action-specific body fields.
 * @apiInvariants The selected host owns the terminal and validates the requested operation.
 * @apiEffects Input and resize/focus updates affect the running terminal.
 * @apiRecovery After an uncertain response do not blindly resend input; inspect terminal state first.
 */
export async function POST(request: Request, context: Context) {
  try {
    const body = await parseJsonWithinLimit(request, 128 * 1024);
    if (
      !isRecord(body) ||
      typeof body.hostId !== "string" ||
      (body.action !== "input" &&
        body.action !== "resize" &&
        body.action !== "focus")
    )
      return Response.json(
        { error: "Invalid request", code: "invalid_request" },
        { status: 400 },
      );
    const resolved = await resolveWorkspaceHost(body.hostId, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.terminals(body.action, {
      id: (await context.params).id,
      data: body.data,
      cols: body.cols,
      rows: body.rows,
      viewer: body.viewer,
      focused: body.focused,
    });
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
/**
 * @apiContract workspaceTerminalDelete
 * @apiUsage Close a host terminal.
 * @apiInputs Use terminal id and optional hostId.
 * @apiInvariants Closing a terminal is different from merely disconnecting a viewer.
 * @apiEffects Requests closure of the terminal process.
 * @apiRecovery List terminals after an uncertain response before issuing another close.
 */
export async function DELETE(request: Request, context: Context) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      null,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.terminals("close", {
      id: (await context.params).id,
    });
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
