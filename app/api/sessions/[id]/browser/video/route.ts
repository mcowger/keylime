import { Value } from "@sinclair/typebox/value";
import { BrowserVideoRequestSchema } from "@/lib/api-contracts/runner-lifecycle";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { apiErrorResponse, hostOfflineResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { hostBrowserVideo } from "@/lib/hosts/hub";
import { isValidSessionId } from "@/lib/session-file-references-core";

/**
 * @apiContract sessionBrowserVideo
 * @apiUsage Start, pull, or stop ephemeral encoded video from a session-owned browser tab.
 * @apiInputs id identifies the live session; the body identifies the exact tab and stream.
 * @apiInvariants The host and runner recheck ownership; video packets are bounded and never cached.
 * @apiEffects Starts or releases capture, or consumes queued encoded packets.
 * @apiRecovery Stop when hidden; start a fresh stream after disconnect or decoder failure.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidSessionId(id)) return Response.json({ error: "Invalid browser request", code: "invalid_request" }, { status: 400 });
  let body: unknown;
  try { body = await parseJsonWithinLimit<unknown>(req, 8192); } catch {
    return Response.json({ error: "Invalid browser request", code: "invalid_request" }, { status: 400 });
  }
  if (!Value.Check(BrowserVideoRequestSchema, body))
    return Response.json({ error: "Invalid browser request", code: "invalid_request" }, { status: 400 });
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    const result = await hostBrowserVideo(resolved.host.id, id, body);
    return Response.json(result, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return apiErrorResponse(error); }
}
