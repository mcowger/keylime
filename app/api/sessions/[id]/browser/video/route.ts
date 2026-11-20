import { Value } from "@sinclair/typebox/value";
import {
  BrowserVideoNextResultSchema,
  BrowserVideoRequestSchema,
} from "@/lib/api-contracts/runner-lifecycle";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import {
  apiErrorResponse,
  hostOfflineResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";
import { hostBrowserVideo } from "@/lib/hosts/hub";
import { isValidSessionId } from "@/lib/session-file-references-core";

// Process-wide, rate-limited totals avoid logging stream identifiers or packet contents.
const videoStats = {
  starts: 0,
  next: 0,
  stops: 0,
  empty: 0,
  packets: 0,
  failures: 0,
  status: 0,
};
let lastVideoReport = 0;
function reportVideoStats() {
  const now = Date.now();
  if (lastVideoReport && now - lastVideoReport < 30_000) return;
  lastVideoReport = now;
  console.info("[browser-video route]", { ...videoStats });
}
let lastVideoFailureReport = 0;
function reportVideoFailure() {
  const now = Date.now();
  if (lastVideoFailureReport && now - lastVideoFailureReport < 30_000) return;
  lastVideoFailureReport = now;
  console.warn("[browser-video route failure]", { ...videoStats });
}

/**
 * @apiContract sessionBrowserVideo
 * @apiUsage Start, pull, or stop ephemeral encoded video from a session-owned browser tab.
 * @apiInputs id identifies the live session; the body identifies the exact tab and stream. Optional hostId selects the host; omission selects local.
 * @apiInvariants The host and runner recheck ownership; video packets are bounded and never cached.
 * @apiEffects Starts or releases capture, or consumes queued encoded packets.
 * @apiRecovery Stop when hidden; start a fresh stream after disconnect or decoder failure.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const hostId = new URL(req.url).searchParams.get("hostId") ?? "local";
  if (!isValidSessionId(id))
    return Response.json(
      { error: "Invalid browser request", code: "invalid_request" },
      { status: 400 },
    );
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(req, 8192);
  } catch {
    return Response.json(
      { error: "Invalid browser request", code: "invalid_request" },
      { status: 400 },
    );
  }
  if (!Value.Check(BrowserVideoRequestSchema, body))
    return Response.json(
      { error: "Invalid browser request", code: "invalid_request" },
      { status: 400 },
    );
  if (body.op === "start") videoStats.starts++;
  else if (body.op === "next") videoStats.next++;
  else videoStats.stops++;
  reportVideoStats();
  try {
    const resolved = await resolveSessionHostOr404(id, hostId);
    if ("response" in resolved) {
      videoStats.failures++;
      videoStats.status = resolved.response.status;
      reportVideoFailure();
      return resolved.response;
    }
    const offline = hostOfflineResponse(resolved.host);
    if (offline) {
      videoStats.failures++;
      videoStats.status = offline.status;
      reportVideoFailure();
      return offline;
    }
    const result = await hostBrowserVideo(resolved.host.id, id, body);
    videoStats.status = 200;
    if (
      body.op === "next" &&
      Value.Check(BrowserVideoNextResultSchema, result)
    ) {
      videoStats.packets += result.packets.length;
      if (!result.packets.length) videoStats.empty++;
    }
    reportVideoStats();
    return Response.json(result, {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const response = apiErrorResponse(error);
    videoStats.failures++;
    videoStats.status = response.status;
    reportVideoFailure();
    return response;
  }
}
