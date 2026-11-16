import { Value } from "@sinclair/typebox/value";
import { BrowserControlArgsSchema } from "@/lib/api-contracts/runner-lifecycle";
import { apiErrorResponse, hostOfflineResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { hostBrowserControl } from "@/lib/hosts/hub";
import { isValidSessionId } from "@/lib/session-file-references-core";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";

/**
 * @apiContract controlSessionBrowserTab
 * @apiUsage Send an ordered batch of navigation or input actions to a session-owned browser tab.
 * @apiInputs id identifies the session; the body supplies the exact tab and 1–64 actions in order, within 1 MiB of UTF-8 JSON.
 * @apiInvariants The whole batch is validated before effects; the runner rechecks ownership before each action without starting a runner or exposing CDP.
 * @apiEffects Applies actions sequentially; other viewers and the agent remain able to interact. Failure stops the batch and may leave an applied prefix.
 * @apiRecovery Never automatically retry a failed batch or its remaining actions: partial delivery may be uncertain.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidSessionId(id)) return Response.json({ error: "Invalid browser request", code: "invalid_request" }, { status: 400 });
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(req, 1024 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json({ error: "Browser input batch exceeds 1 MiB", code: "request_too_large" }, { status: 413 });
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
