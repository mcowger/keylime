import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";

/**
 * @apiContract workspaceBrowseCwd
 * @apiUsage Browse directories before choosing a workspace.
 * @apiInputs path and hostId refer to the selected daemon machine; an omitted path is passed through.
 * @apiInvariants Browsing is not a session file-access grant or project registration.
 * @apiEffects Returns a directory listing snapshot without selecting a workspace.
 * @apiRecovery Browse again if the directory or host changes.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      null,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.browseDirectories(
      params.get("path"),
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
