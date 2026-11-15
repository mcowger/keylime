import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";

/**
 * @apiContract workspaceGithubRepo
 * @apiUsage Resolve GitHub repository information for a directory.
 * @apiInputs cwd is a path on the selected host, not the browser machine.
 * @apiInvariants The selected host performs repository lookup.
 * @apiEffects Reads repository information without registering a project.
 * @apiRecovery Check the host and repository configuration if lookup fails.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      null,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.githubRepo(
      params.get("cwd")?.trim() ?? "",
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
