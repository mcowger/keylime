import { searchSessions } from "@/lib/session-content-search";
import { registeredHostSessionIds } from "@/lib/hosts/session-index";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { apiErrorResponse } from "@/lib/api-utils";
import type { TranscriptSearchBatch } from "@/lib/api-contracts/http-sessions";

const MAX_QUERY_LENGTH = 500;

// GET /api/sessions/search?q= — NDJSON, one `{ scores }` line per batch of
// scanned sessions (empty batches too, so the scan keeps reaching the reader).
// Closing the request stops the scan after the batch being read (no resume).
/**
 * @apiContract searchSessions
 * @apiUsage Stream session content search scores as newline-delimited JSON batches.
 * @apiInputs q defaults to empty and is limited to 500 characters; each line contains scores with hostId, sessionId and score.
 * @apiInvariants Scores cover only registered sessions on the web host. Even empty batches are emitted. Local scoring includes submitted skill prompts, not expanded instructions. This is a pull-driven scan, not a resumable cursor or atomic snapshot.
 * @apiEffects Scans session content as the client reads; response is no-store and proxy buffering is disabled.
 * @apiRecovery Closing the stream stops after the current batch; restart the search from the beginning after disconnect and replace accumulated results as appropriate.
 */
export async function GET(
  req: Request,
  { disableIdleTimeout }: { disableIdleTimeout: () => void },
) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY_LENGTH) {
    return Response.json(
      { error: "Query too long", code: "query_too_long" },
      { status: 400 },
    );
  }
  let allowed: Set<string>;
  try {
    allowed = await registeredHostSessionIds(LOCAL_HOST_ID);
  } catch (error) {
    return apiErrorResponse(error);
  }
  const batches = searchSessions(q);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    // Pull-driven: the scan only advances while the client keeps reading.
    async pull(controller) {
      const next = await batches.next();
      if (next.done) {
        controller.close();
        return;
      }
      const batch: TranscriptSearchBatch = { scores: [] };
      for (const [sessionId, score] of Object.entries(next.value)) {
        if (allowed.has(sessionId))
          batch.scores.push({ hostId: LOCAL_HOST_ID, sessionId, score });
      }
      controller.enqueue(encoder.encode(`${JSON.stringify(batch)}\n`));
    },
    async cancel() {
      await batches.return(undefined);
    },
  });
  disableIdleTimeout();
  // X-Accel-Buffering: nginx must pass batches through as they arrive.
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
