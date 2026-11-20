import {
  apiErrorResponse,
  hostOfflineResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";
import { hostBrowserCapture } from "@/lib/hosts/hub";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { isValidSessionId } from "@/lib/session-file-references-core";

/**
 * @apiContract captureSessionBrowserFrame
 * @apiUsage Capture a read-only JPEG frame of a session-owned browser tab.
 * @apiInputs id identifies the live session and tabId identifies a tab returned by discovery. Optional hostId selects the host; omission selects local.
 * @apiInvariants The host and runner recheck ownership; callers cannot supply a CDP endpoint or browser input.
 * @apiEffects Captures one frame and reports its CSS viewport dimensions in response headers without managing a browser.
 * @apiRecovery Rediscover tabs after session or tab changes, or retry when the host reconnects.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const hostId = new URL(req.url).searchParams.get("hostId") ?? "local";
  const tabId = new URL(req.url).searchParams.get("tabId");
  if (!isValidSessionId(id) || !tabId || tabId.length > 1024)
    return Response.json(
      { error: "Invalid browser request", code: "invalid_request" },
      { status: 400 },
    );
  try {
    const resolved = await resolveSessionHostOr404(id, hostId);
    if ("response" in resolved) return resolved.response;
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    const frame = await hostBrowserCapture(resolved.host.id, id, tabId);
    if (
      !Number.isFinite(frame.width) ||
      frame.width <= 0 ||
      !Number.isFinite(frame.height) ||
      frame.height <= 0
    )
      throw new HostOpError(
        502,
        "invalid_browser_result",
        "Invalid browser viewport from host",
      );
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        frame.data,
      )
    )
      throw new HostOpError(
        502,
        "invalid_browser_result",
        "Invalid browser frame from host",
      );
    const bytes = Buffer.from(frame.data, "base64");
    if (
      bytes.length < 3 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    )
      throw new HostOpError(
        502,
        "invalid_browser_result",
        "Invalid browser frame from host",
      );
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Browser-Viewport-Width": String(frame.width),
        "X-Browser-Viewport-Height": String(frame.height),
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
