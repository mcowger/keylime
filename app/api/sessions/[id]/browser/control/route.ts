import { Value } from "@sinclair/typebox/value";
import { BrowserControlArgsSchema } from "@/lib/api-contracts/runner-lifecycle";
import { apiErrorResponse, hostOfflineResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { hostBrowserControl } from "@/lib/hosts/hub";
import { isValidSessionId } from "@/lib/session-file-references-core";

/**
 * @apiContract controlSessionBrowserTab
 * @apiUsage Send one navigation or input action to a session-owned browser tab.
 * @apiInputs id identifies the session; the body identifies a discovered tab and a typed action.
 * @apiInvariants The host and runner recheck ownership without starting a runner or exposing CDP.
 * @apiEffects Applies one browser action; other viewers and the agent remain able to interact.
 * @apiRecovery An error may mean the action was applied; do not automatically retry it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidSessionId(id)) return Response.json({ error: "Invalid browser request", code: "invalid_request" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid browser request", code: "invalid_request" }, { status: 400 });
  }
  if (!Value.Check(BrowserControlArgsSchema, body))
    return Response.json({ error: "Invalid browser request", code: "invalid_request" }, { status: 400 });
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    const result = await hostBrowserControl(resolved.host.id, id, body);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
