import { hostPtySessions } from "@/lib/hosts/hub";
import { HostOpError } from "@/lib/hosts/link-protocol";

/**
 * @apiContract getHostsIdTerminalSessions
 * @apiUsage List live session terminals on a connected host, including idle sessions.
 * @apiInputs The path identifies the owning host.
 * @apiInvariants Only sessions with a live bound PTY are returned.
 * @apiEffects This read does not start or attach to a session.
 * @apiRecovery An offline host returns an error; retry after it reconnects.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return Response.json({ sessionIds: await hostPtySessions(id) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof HostOpError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
}
