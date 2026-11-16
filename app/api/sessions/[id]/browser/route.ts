import { apiErrorResponse, hostOfflineResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { hostBrowserList } from "@/lib/hosts/hub";
import { isValidSessionId } from "@/lib/session-file-references-core";

/**
 * @apiContract listSessionBrowserTabs
 * @apiUsage Discover browser tabs belonging to an already-live session.
 * @apiInputs id identifies the owning session.
 * @apiInvariants Discovery never starts a runner or browser, and never exposes a CDP endpoint.
 * @apiEffects Queries the owning host's existing runner and returns its current tabs.
 * @apiRecovery Retry after a host reconnect or session change.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidSessionId(id)) return Response.json({ error: "Invalid session id", code: "invalid_request" }, { status: 400 });
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    const result = await hostBrowserList(resolved.host.id, id);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
