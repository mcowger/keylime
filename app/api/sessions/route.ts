import { createHash } from "crypto";
import {
  listRegisteredHostSessions,
  listSessionsAllHosts,
} from "@/lib/hosts/session-index";
import { getRunningRpcSessions } from "@/lib/rpc-manager";
import { sessionKey } from "@/lib/session-identity";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

/**
 * @apiContract listSessions
 * @apiUsage Poll the cross-host session inventory together with currently running registered wrappers.
 * @apiInputs Optional hostId selects one host; id filters sessions and defaults its host to local. An unfiltered request may supply If-None-Match.
 * @apiInvariants Host inventories can be cached internally; running wrappers are sampled at request time. Unfiltered responses have an ETag and may return 304; filtered responses do not.
 * @apiEffects Read-only inventory and live-wrapper lookup; responses prohibit browser and proxy storage.
 * @apiRecovery Re-poll for changes and retain the previous unfiltered body on 304; a partial host inventory is not proof a session is absent everywhere.
 */
export async function GET(req: Request) {
  try {
    const query = new URL(req.url).searchParams;
    const filterId = query.get("id");
    const hostId = query.get("hostId") ?? (filterId !== null ? "local" : null);

    const sessions =
      hostId === null
        ? await listSessionsAllHosts()
        : await listRegisteredHostSessions(hostId);
    const registered = new Set(sessions.map((s) => sessionKey(s.id, s.hostId)));
    const runningSessions = getRunningRpcSessions().filter((s) =>
      registered.has(sessionKey(s.id, s.hostId)),
    );
    const runningSessionIds = runningSessions
      .filter((s) => s.hostId === (hostId ?? "local"))
      .map((s) => s.id);

    if (hostId !== null) {
      const matched =
        filterId !== null
          ? sessions.filter((s) => s.id === filterId)
          : sessions;
      const body = { sessions: matched, runningSessionIds, runningSessions };
      const bodyJson = JSON.stringify(body);
      return new Response(bodyJson, {
        headers: {
          "Content-Type": "application/json",
          ...SESSION_LIST_HEADERS,
        },
      });
    }

    const body = { sessions, runningSessionIds, runningSessions };
    const bodyJson = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;

    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, ...SESSION_LIST_HEADERS },
      });
    }
    return new Response(bodyJson, {
      headers: {
        ETag: etag,
        "Content-Type": "application/json",
        ...SESSION_LIST_HEADERS,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "internal_error",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
