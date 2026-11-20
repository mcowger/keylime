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
 * On-disk subagent roster for a session, recovered from the parent file's task
 * toolResults (works without a live RPC process — survives page reloads).
 */
/**
 * @apiContract listSessionSubagents
 * @apiUsage Recover the on-disk subagent roster from the parent session's task results.
 * @apiInputs id identifies the parent session; optional hostId selects the host, defaulting to local.
 * @apiInvariants This is persisted history, not a live process roster. A live new session whose file has not appeared returns an empty roster.
 * @apiEffects Reads the owning host's session artifacts without starting a process; persisted results survive page reloads.
 * @apiRecovery Refresh after task results are committed; an empty roster before the session file lands does not prove no task is running.
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
