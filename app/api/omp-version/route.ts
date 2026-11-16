import { getOmpVersion } from "@/lib/omp/omp-cli";

/** Runtime probe of the installed omp binary ("omp/17.1.3"), separate from the
 * build-time keylime version — the two can legitimately drift. */
/**
 * @apiContract getOmpVersion
 * @apiUsage Inspect the installed omp runner version, which may differ from the web build version.
 * @apiInputs No parameters.
 * @apiInvariants The result may be null when the binary is missing or its probe fails; successful probes are cached with file-fingerprint invalidation and expiry, and misses have a short backoff.
 * @apiEffects May probe the installed executable; does not change it.
 * @apiRecovery Retry after the probe backoff if the binary was installed or repaired; a cached result may persist until invalidated or expired.
 */
export async function GET() {
  const version = await getOmpVersion();
  return Response.json({ version });
}
