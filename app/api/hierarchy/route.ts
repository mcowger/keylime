import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import type { HierarchyRequest } from "@/lib/project-hierarchy-types";

/**
 * @apiContract workspaceHierarchyGet
 * @apiUsage List the selected host’s project hierarchy.
 * @apiInputs Optional host selects the daemon.
 * @apiInvariants The result describes registered hierarchy, not every discoverable directory.
 * @apiEffects Returns a hierarchy snapshot without changing registrations.
 * @apiRecovery Refresh after mutations or host reconnection.
 */
export async function GET(request: Request) {
  try {
    const resolved = resolveHostOrError(
      new URL(request.url).searchParams.get("host") ?? undefined,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.hierarchy({
      action: "list",
    });
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
/**
 * @apiContract workspaceHierarchyPost
 * @apiUsage Apply a hierarchy action on a host.
 * @apiInputs Send host and an input object with an action and its action-specific fields; JSON is limited to 384 KiB.
 * @apiInvariants Registration and discovery are distinct; the host validates action preconditions. listProjectIcons scans at most five directory levels and 2,000 entries, returning at most 24 icons of at most 256 KiB. It skips hidden names, symlinks, node_modules, vendor, dist and release, and applies Git ignore rules when available. Results are best-effort.
 * @apiEffects Actions can change project or workspace registration and presentation.
 * @apiRecovery After an uncertain mutation, fetch the hierarchy before deciding whether to repeat it.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 384 * 1024);
    if (
      !isRecord(body) ||
      !isRecord(body.input) ||
      typeof body.input.action !== "string" ||
      (body.host !== undefined && typeof body.host !== "string")
    )
      return Response.json(
        { error: "Invalid hierarchy request", code: "invalid_request" },
        { status: 400 },
      );
    const resolved = resolveHostOrError(body.host);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.hierarchy(
      body.input as unknown as HierarchyRequest,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
