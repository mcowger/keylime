import {
  admitLinkedHost,
  configErrorResponse,
  configFail,
  currentClusterConfig,
} from "@/lib/hosts/cluster-config-server";

// One file of the current manifest by content hash; a hash of an older configuration is 404.
/**
 * @apiContract hostClusterFile
 * @apiUsage Download a file belonging to the web server's current mirrored configuration.
 * @apiInputs Authenticate with a linked host's bearer token and supply the lowercase 64-character content hash in the path.
 * @apiInvariants The token is checked again after building the configuration; hashes absent from the current manifest, including older versions, return 404.
 * @apiEffects Returns raw application/octet-stream bytes with no-store; it does not apply configuration.
 * @apiRecovery Fetch a fresh manifest if the hash is gone, or re-enroll a revoked host before retrying.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const host = admitLinkedHost(request);
  if (host instanceof Response) return host;
  const { hash } = await params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return configFail("Not found", 404);
  try {
    const current = await currentClusterConfig();
    // The host may have been revoked while the configuration was built.
    const again = admitLinkedHost(request);
    if (again instanceof Response) return again;
    const bytes = current.content(hash);
    if (!bytes) return configFail("Not found", 404);
    // buildManifest's bytes are Buffers (never SharedArrayBuffer-backed), which BodyInit accepts.
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return configErrorResponse(host.id, error);
  }
}
