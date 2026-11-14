import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = resolveHostOrError(
      new URL(request.url).searchParams.get("host") ?? undefined,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.shipStatus(
      (await context.params).id,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
