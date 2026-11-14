import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";

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
