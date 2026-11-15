import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";

/**
 * @apiContract workspaceGitDiff
 * @apiUsage Read the Git diff for one workspace path.
 * @apiInputs Provide cwd and path on the selected host, optionally bound to sessionId.
 * @apiInvariants A session determines the authoritative host and cwd.
 * @apiEffects Reads a current Git snapshot; repository changes can change the result.
 * @apiRecovery Retry a failed read after checking host and repository availability.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      params.get("sessionId"),
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.gitDiff(
      resolved.cwd ?? params.get("cwd")?.trim() ?? "",
      params.get("path")?.trim() ?? "",
      resolved.owner,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
