import {
  admitClusterMember,
  configErrorResponse,
  currentClusterConfig,
} from "@/lib/hosts/cluster-config-server";

// The master's mirrored configuration for a cluster member: bearer-authenticated, outside the password gate (proxy.ts `UNGATED`).
/**
 * @apiContract hostClusterManifest
 * @apiUsage Fetch the master's current mirrored configuration manifest.
 * @apiInputs Authenticate with a cluster member's host bearer token.
 * @apiInvariants Membership is checked both before and after building the current configuration; the response is not cached by HTTP clients.
 * @apiEffects Reads the current configuration and returns JSON; it does not apply it to the daemon.
 * @apiRecovery On revoked membership or unavailable configuration, restore admission or configuration availability before retrying.
 */
export async function GET(request: Request) {
  const host = admitClusterMember(request);
  if (host instanceof Response) return host;
  try {
    const current = await currentClusterConfig();
    // Admitted again: the host may have been revoked or left the cluster while the configuration was built.
    const again = admitClusterMember(request);
    if (again instanceof Response) return again;
    return Response.json(current.manifest, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return configErrorResponse(host.id, error);
  }
}
