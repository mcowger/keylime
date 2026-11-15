import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";

/**
 * @apiContract workspaceHome
 * @apiUsage Get the selected host’s home directory.
 * @apiInputs hostId is optional and selects the daemon machine.
 * @apiInvariants The returned path belongs to that host.
 * @apiEffects Reads the host home path without granting access to its files.
 * @apiRecovery Check host availability before repeating a failed request.
 */
export async function GET(request: Request) {
  try {
    const resolved = await resolveWorkspaceHost(
      new URL(request.url).searchParams.get("hostId") ?? undefined,
      null,
    );
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.home();
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
