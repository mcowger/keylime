import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";

type Context = { params: Promise<{ id: string }> };
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
export async function POST(request: Request, context: Context) {
  try {
    const body = await parseJsonWithinLimit(request, 128 * 1024);
    if (
      !isRecord(body) ||
      typeof body.hostId !== "string" ||
      (body.action !== "input" && body.action !== "resize")
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
    });
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
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
