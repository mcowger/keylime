import {
  admitLinkedHost,
  configErrorResponse,
  currentClusterConfig,
} from "@/lib/hosts/cluster-config-server";

// The master's mirrored configuration for a cluster member: bearer-authenticated, outside the password gate (proxy.ts `UNGATED`).
/**
 * @apiContract hostClusterManifest
 * @apiUsage Fetch the web server's current mirrored configuration manifest.
 * @apiInputs Authenticate with a linked host's bearer token.
 * @apiInvariants The token is checked both before and after building the current configuration; HTTP clients do not cache the response.
 * @apiEffects Reads the current configuration and returns JSON; it does not apply it to the daemon.
 * @apiRecovery Re-enroll a revoked host or fix server configuration errors before retrying.
 */
export async function GET(request: Request) {
  const host = admitLinkedHost(request);
  if (host instanceof Response) return host;
  try {
    const current = await currentClusterConfig();
    // The host may have been revoked while the configuration was built.
    const again = admitLinkedHost(request);
    if (again instanceof Response) return again;
    return Response.json(current.manifest, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return configErrorResponse(host.id, error);
  }
}
