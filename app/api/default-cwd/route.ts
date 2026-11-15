import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";

/**
 * @apiContract workspaceDefaultCwd
 * @apiUsage Get the selected host’s default workspace directory.
 * @apiInputs hostId is optional and selects the daemon machine.
 * @apiInvariants The returned path is host-local, not a browser filesystem path.
 * @apiEffects Reads the host default without selecting or registering a project.
 * @apiRecovery Request it again if host configuration changes.
 */
export async function POST(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      null,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.defaultCwd();
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
