import { apiErrorResponse, resolveHostOrError } from "@/lib/api-utils";

/**
 * @apiContract getModels
 * @apiUsage Read the selected daemon's model catalog and Claude slow-mode setting.
 * @apiInputs Optional hostId selects the daemon; omission selects the local daemon.
 * @apiInvariants The catalog is cached on its daemon for 60 seconds and never falls back across hosts. Token limits are in tokens.
 * @apiEffects Queries the daemon's OMP registry on cache misses; runner failures produce a safe empty catalog with an error marker.
 * @apiRecovery Reconnect the selected daemon or check its provider configuration before retrying.
 */
export async function GET(req: Request) {
  const target = resolveHostOrError(
    new URL(req.url).searchParams.get("hostId") ?? undefined,
  );
  if ("response" in target) return target.response;
  try {
    return Response.json(await target.host.listModels(false));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * @apiContract refreshModels
 * @apiUsage Refresh models from providers configured on the selected daemon.
 * @apiInputs Optional hostId selects the daemon; omission selects the local daemon. No request body.
 * @apiInvariants Bypasses the daemon catalog cache and OMP discovery cache without stopping active sessions.
 * @apiEffects Runs online discovery on the selected daemon and caches the refreshed catalog on success.
 * @apiRecovery On a 503, reconnect the selected daemon or check its provider configuration before retrying.
 */
export async function POST(req: Request) {
  const target = resolveHostOrError(
    new URL(req.url).searchParams.get("hostId") ?? undefined,
  );
  if ("response" in target) return target.response;
  try {
    return Response.json(await target.host.listModels(true));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
