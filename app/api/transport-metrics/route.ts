import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import { appendTransportSamples } from "@/lib/transport-metrics";
import { isRecord } from "@/lib/type-guards";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SAMPLES = 1_000;

// GET /api/transport-metrics — the server clock, the SSE transport's clock probe.
/**
 * @apiContract getTransportMetrics
 * @apiUsage Probe the server clock for advisory SSE transport timing estimates.
 * @apiInputs No parameters.
 * @apiInvariants now is server Unix epoch milliseconds at response generation, not a synchronized clock or a guaranteed network latency measurement. The response is no-store.
 * @apiEffects Reads the current process clock only.
 * @apiRecovery Repeat the probe to update an estimate; network delay and clock changes can affect it.
 */
export function GET() {
  return Response.json(
    { now: Date.now() },
    { headers: { "cache-control": "no-store" } },
  );
}

// POST /api/transport-metrics { samples } — appended to <agent dir>/keylime/transport-metrics.jsonl.
/**
 * @apiContract postTransportMetrics
 * @apiUsage Append advisory client transport samples for diagnostics.
 * @apiInputs JSON body up to 256 KiB with samples array of at most 1000 entries. Each retained sample must be an object with a metric string of at most 32 characters and serialized size at most 4096 bytes.
 * @apiInvariants Invalid individual samples are skipped; written counts only retained entries. Server timestamp and truncated user agent replace any same-named sample fields.
 * @apiEffects Appends JSONL under the agent directory, rotating the existing file after it exceeds 20 MiB.
 * @apiRecovery A retry after an uncertain response can append duplicates; these metrics are advisory, not a deduplicated delivery log.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json(
        {
          error: "Transport metrics request is too large",
          code: "request_too_large",
        },
        { status: 413 },
      );
    body = null;
  }
  if (
    !isRecord(body) ||
    !Array.isArray(body.samples) ||
    body.samples.length > MAX_SAMPLES
  ) {
    return Response.json(
      {
        error: "samples must be an array of at most 1000 objects",
        code: "invalid_transport_metrics",
      },
      { status: 400 },
    );
  }
  return Response.json({
    written: appendTransportSamples(
      body.samples,
      req.headers.get("user-agent"),
    ),
  });
}
