import {
  apiErrorResponse,
  opErrorResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";
import { listSessionMatches } from "@/lib/session-match-listing";
import {
  MAX_SEARCH_MATCHES,
  SEARCH_MATCH_PAGE_SIZE,
} from "@/lib/session-search-matches";
import type { SessionContext } from "@/lib/types";

const MAX_QUERY_LENGTH = 500;

// GET /api/sessions/[id]/matches?q=&limit= — the query's best `limit` hits in the
// session's active conversation (what the chat shows), best match first. "Load more"
// asks for a longer prefix rather than the next offset: a running session re-ranks
// between requests, and an offset would then repeat or skip hits.
// shortcut: re-reads and re-ranks the whole session per request; cache per (session, query) if that gets slow.
/**
 * @apiContract getSessionMatches
 * @apiUsage Find the best-ranked matches in the active conversation of one session.
 * @apiInputs q defaults to empty and is limited to 500 characters; limit is a positive bounded decimal and defaults to the search page size.
 * @apiInvariants Every request rereads and reranks the active context; results are a best-first prefix, not an offset page, and may change as the session changes. Pre-compaction entries are excluded.
 * @apiEffects Reads host history with thinking and media deferred; no-store response and no agent spawn.
 * @apiRecovery To load more request a larger prefix and replace the old results rather than concatenating offset pages; refresh after history changes.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY_LENGTH) {
    return Response.json(
      { error: "Query too long", code: "query_too_long" },
      { status: 400 },
    );
  }
  const rawLimit =
    url.searchParams.get("limit") ?? String(SEARCH_MATCH_PAGE_SIZE);
  const limit = Number(rawLimit);
  if (!/^[1-9]\d{0,3}$/.test(rawLimit) || limit > MAX_SEARCH_MATCHES) {
    return Response.json(
      { error: "Invalid limit", code: "invalid_limit" },
      { status: 400 },
    );
  }
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.readContext(id, undefined, {
      deferThinking: true,
      deferMedia: true,
      includePreCompaction: false,
      boundary: false,
      sync: null,
    });
    if (!result.ok) return opErrorResponse(result);
    const { context } = result.value as { context: SessionContext };
    return Response.json(
      listSessionMatches(context.messages, context.entryIds, q, limit),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
