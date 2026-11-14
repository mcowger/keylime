import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import type { ShipRequest } from "@/lib/workspace-ship-types";

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
    const result = await resolved.host.workspaceOps.startShip(
      body.input as unknown as ShipRequest,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
