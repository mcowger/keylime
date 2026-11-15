import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";

/**
 * @apiContract workspaceGitStatus
 * @apiUsage Read Git status for a workspace.
 * @apiInputs Provide cwd on the selected host, optionally bound to sessionId.
 * @apiInvariants A session determines the authoritative host and cwd.
 * @apiEffects Reads a current Git snapshot rather than changing the repository.
 * @apiRecovery Repeat the read to observe later repository changes.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      params.get("sessionId"),
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.gitStatus(
      resolved.cwd ?? params.get("cwd")?.trim() ?? "",
      resolved.owner,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
