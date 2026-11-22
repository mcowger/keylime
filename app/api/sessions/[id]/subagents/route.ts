import {
  apiErrorResponse,
  opErrorResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { getRpcSession } from "@/lib/rpc-manager";

/**
 * GET /api/sessions/[id]/subagents
 *
 * Persisted subagent roster and reported costs from the owning host's full
 * session file, including all branches and independent of transcript paging.
 */
/**
 * @apiContract listSessionSubagents
 * @apiUsage Recover the persisted subagent roster and reported USD costs from one full parent session file snapshot.
 * @apiInputs id identifies the parent session; optional hostId selects the host, defaulting to local.
 * @apiInvariants The snapshot includes all branches, independent of the selected branch or transcript page, and is not a live process roster. Costs may be omitted by older daemons or when unavailable; a live new session whose file has not appeared returns an empty roster without costs.
 * @apiEffects Reads the owning host's session artifacts without starting a process; persisted results survive page reloads.
 * @apiRecovery Refresh after assistant usage or task results are committed; an empty roster before the session file lands does not prove no task is running.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const hostId = new URL(req.url).searchParams.get("hostId") ?? "local";
  try {
    const resolved = await resolveSessionHostOr404(id, hostId);
    if ("response" in resolved) {
      // A brand-new session's file can land just after the prompt
      // acknowledgement; while its RPC wrapper is alive that is "no on-disk
      // history yet", not "unknown session". The client treats an empty
      // roster the same as a 404, so answer 200 to keep the console clean.
      if (getRpcSession(id, hostId)?.isAlive()) {
        return Response.json({ subagents: [] });
      }
      return resolved.response;
    }
    const result = await resolved.host.sessionOps.readSubagentHistory(id);
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
