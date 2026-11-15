import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import { parseResultLimit } from "@/lib/file-fuzzy";

/**
 * @apiContract workspaceFileIndex
 * @apiUsage Search a workspace file index.
 * @apiInputs cwd, q, limit, kind and refresh select a host index; refresh=1 requests a rebuild.
 * @apiInvariants A session selects its authoritative host and cwd, overriding the supplied cwd.
 * @apiEffects Returns an index snapshot; the host may cache it until refreshed.
 * @apiRecovery Refresh or repeat the search when paths may have changed.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      params.get("sessionId"),
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.fileIndex(
      resolved.cwd ?? params.get("cwd")?.trim() ?? "",
      params.get("q") ?? "",
      parseResultLimit(params.get("limit")),
      params.get("kind") === "file" ? "file" : "all",
      params.get("refresh") === "1",
      resolved.owner,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
