import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import {
  listArchivedSessionInfos,
  restoreArchivedSession,
  restoreFailureStatus,
} from "@/lib/omp/archive";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { getHost, listHosts } from "@/lib/hosts/hub";
import { isLinkUp, type Host } from "@/lib/hosts/host";
import {
  invalidateHostSessionList,
  invalidateLocalSessionLists,
} from "@/lib/hosts/session-index";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { pumpOutbox } from "@/lib/message-outbox";
import { invalidateSessionListCache } from "@/lib/session-reader";
import type { ArchivedSessionInfo } from "@/lib/types";
import { isValidSessionId } from "@/lib/session-file-references-core";
import {
  withArchiveRestoreLock,
  type HeldRestore,
} from "@/lib/archive-restore-lock";

/** The target host lost its link during the strict inventory check. */
class RestoreHostOfflineError extends HostOpError {
  constructor(readonly host: string) {
    super(
      503,
      "host_offline",
      `${host} is offline; the archive was not restored`,
    );
  }
}

/** Resolves only once the daemon process that reserved an earlier restore of this session has fenced it (it can no longer
 * start, whenever its request arrives) and reports none running: until then it may still publish the session. A different
 * process answering (the daemon was replaced or restarted) proves nothing about the first, which may be alive, shared with
 * another server, and still running the restore; the claim then stays held. */
async function confirmRestoreStopped(held: HeldRestore): Promise<void> {
  const host = getHost(held.hostId);
  const sent = `sent to ${host?.label ?? `host ${held.hostId}`} (last seen alive ${new Date(held.since).toISOString()})`;
  const blocked = (why: string) =>
    new HostOpError(
      409,
      "archive_restore_unconfirmed",
      `Session ${held.sessionId} cannot be restored yet: an earlier restore of it was ${sent}, and its outcome was never learned. ${why} There is no automatic recovery; see AGENTS.md, "Session archive is per host".`,
    );
  // Fails closed, with no timeout and no clearing: unregistering a host does not stop its daemon, which may still run or be sent
  // the restore, and nothing here can ask it. The claim stays until an operator who verified the daemon is stopped removes its row.
  if (!host)
    throw blocked(
      "That host is no longer registered, and unregistering does not stop its daemon, so the session stays blocked.",
    );
  let reason: string | null;
  try {
    const fence = await host.sessionOps.restoreFence(held.claim);
    if (!fence.ok) reason = fence.error;
    else if (fence.value.instance !== held.instance)
      reason =
        "The daemon linked now is not the process that took the restore (it was replaced or restarted), so it cannot revoke that restore, which may still be running there.";
    else reason = fence.value.running ? "The restore is still running." : null;
  } catch (error) {
    reason = `The host could not confirm it: ${error instanceof Error ? error.message : String(error)}.`;
  }
  if (reason) throw blocked(reason);
}

async function targetHasActiveSession(
  host: Host,
  sessionId: string,
): Promise<boolean> {
  const ensureLinked = () => {
    if (!isLinkUp(host.status())) throw new RestoreHostOfflineError(host.label);
  };
  ensureLinked();
  let sessions: string[];
  try {
    // The sidebar's best-effort lists and caches are not absence evidence.
    sessions = await host.sessionOps.listSessionIdsForRestore();
  } catch {
    ensureLinked();
    throw new HostOpError(
      503,
      "host_sessions_unavailable",
      "Could not read the target host's active sessions; the archive was not restored",
    );
  }
  ensureLinked();
  return sessions.includes(sessionId);
}

/** Each linked host's archive; a host that is offline or cannot answer (an older daemon) is listed in `unavailableHosts`. */
async function linkedHostArchives(hostId: string | null): Promise<{
  archives: ArchivedSessionInfo[];
  unavailableHosts: { id: string; label: string }[];
}> {
  const results = await Promise.all(
    listHosts()
      .filter((row) => hostId === null || row.id === hostId)
      .map(async (row) => {
        const host = isLinkUp(row.status) ? getHost(row.id) : null;
        if (!host)
          return {
            archives: [],
            unavailable: { id: row.id, label: row.label },
          };
        try {
          const archives = await host.sessionOps.listArchives();
          return {
            archives: archives.map((archive) => ({
              ...archive,
              hostId: row.id,
            })),
            unavailable: null,
          };
        } catch {
          return {
            archives: [],
            unavailable: { id: row.id, label: row.label },
          };
        }
      }),
  );
  return {
    archives: results.flatMap((result) => result.archives),
    unavailableHosts: results.flatMap((result) =>
      result.unavailable ? [result.unavailable] : [],
    ),
  };
}

/**
 * @apiContract listSessionArchives
 * @apiUsage Discover archives across the local and registered linked hosts.
 * @apiInputs Optional hostId limits discovery to one host.
 * @apiInvariants Results are sorted newest archivedAt first and tagged with hostId; unavailableHosts identifies hosts whose archives could not be listed. Pending restores remain discovery evidence, not restore targets.
 * @apiEffects Reads archive inventories without starting sessions; the response is no-store.
 * @apiRecovery An absent archive on an unavailable host is not proven absent; reconnect or repair that host and list again before acting on absence.
 */
export async function GET(request?: Request) {
  try {
    const hostId = request
      ? new URL(request.url).searchParams.get("hostId")
      : null;
    const [local, linked] = await Promise.allSettled([
      hostId === null || hostId === LOCAL_HOST_ID
        ? listArchivedSessionInfos()
        : Promise.resolve([]),
      linkedHostArchives(hostId),
    ]);
    if (linked.status === "rejected") throw linked.reason;
    // Local corruption/unreadability is one host's failure, just like a linked daemon that cannot list its archive. Keep the
    // healthy hosts visible; direct archive discovery still throws, so outbox callers cannot mistake this for proven absence.
    const archives = [
      ...(local.status === "fulfilled"
        ? local.value.map((archive) => ({ ...archive, hostId: LOCAL_HOST_ID }))
        : []),
      ...linked.value.archives,
    ].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    const unavailableHosts = [
      ...(local.status === "rejected"
        ? [{ id: LOCAL_HOST_ID, label: getHost(LOCAL_HOST_ID).label }]
        : []),
      ...linked.value.unavailableHosts,
    ];
    return Response.json(
      { archives, unavailableHosts },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * @apiContract restoreSessionArchive
 * @apiUsage Restore a discovered archive to its original owning host.
 * @apiInputs JSON key identifies an archive on hostId; omitted hostId selects the local host, while blank or null host IDs are invalid.
 * @apiInvariants Pending archives cannot be restored. Claims are scoped to hostId and session UUID. A fresh inventory must show no active copy on the target; other hosts are not checked. An uncertain remote claim remains held until the daemon process that reserved it fences it and confirms it stopped.
 * @apiEffects Restores the native session and artifacts, invalidates session lists and pumps held outbox messages on the target. A remote restore can continue after a lost connection or server restart.
 * @apiRecovery Do not assume a timeout or replacement daemon proves failure. Resolve archive_restore_unconfirmed before retrying. If the original daemon cannot be fenced, operator recovery is required. If the target inventory is unavailable, reconnect or repair the target.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { key?: unknown; hostId?: unknown };
    if (typeof body.key !== "string" || !body.key.trim()) {
      return Response.json(
        { error: "Archive key is required", code: "archive_key_required" },
        { status: 400 },
      );
    }
    if (
      body.hostId !== undefined &&
      (typeof body.hostId !== "string" || !body.hostId.trim())
    ) {
      return Response.json(
        { error: "Host ID must be a nonempty string", code: "invalid_host_id" },
        { status: 400 },
      );
    }
    const hostId =
      body.hostId === undefined ? LOCAL_HOST_ID : (body.hostId as string);
    const resolved =
      hostId === LOCAL_HOST_ID ? null : resolveHostOrError(hostId);
    if (resolved && "response" in resolved) return resolved.response;
    const host = resolved?.host;
    const archives = host
      ? await host.sessionOps.listArchives()
      : await listArchivedSessionInfos();
    const archive = archives.find((entry) => entry.key === body.key);
    if (!archive)
      return Response.json(
        { error: "Archive not found", code: "archive_not_found" },
        { status: 404 },
      );
    if (archive.restorePending)
      return Response.json(
        {
          error:
            "This archive is captured by an in-progress or interrupted restore; it is discovery evidence, not a restore target. Inspect the owning restore before manual recovery.",
          code: "archive_restore_unconfirmed",
        },
        { status: 409 },
      );
    if (!isValidSessionId(archive.id)) {
      return Response.json(
        {
          error: "Invalid archived session ID",
          code: "archive_session_invalid",
        },
        { status: 400 },
      );
    }
    return await withArchiveRestoreLock(
      hostId,
      archive.id,
      async (claim) => {
        if (
          await targetHasActiveSession(
            host ?? getHost(LOCAL_HOST_ID),
            archive.id,
          )
        ) {
          return Response.json(
            {
              error: `Session ${archive.id} is already active on this host; the archive was not restored`,
              code: "archive_restore_failed",
            },
            { status: 409 },
          );
        }
        if (host) {
          // A daemon starts a restore only under a token it reserved, and a fence revokes it. So a request this process sends
          // late (suspended after the hold) is refused once another request took the claim over, however late it arrives.
          const reserved = await host.sessionOps.restoreReserve(claim.token);
          if (!reserved.ok) return opErrorResponse(reserved);
          // Held before the restore leaves: the claim must outlive a timeout, a lost link and this process, as the daemon keeps restoring.
          claim.hold(reserved.value.instance);
          let result;
          try {
            result = await host.sessionOps.restoreArchive(
              body.key as string,
              claim.token,
            );
          } catch (error) {
            // No answer, or one that is not a result: the restore may be running or still arrive, whatever the error says (it
            // cannot tell an op that never left from one that did), so the claim stays held.
            const cause =
              error instanceof Error ? error.message : String(error);
            throw new HostOpError(
              error instanceof HostOpError ? error.status : 502,
              "archive_restore_unconfirmed",
              `${cause}; the restore may still be running there, so this session stays blocked until ${host.label} confirms it stopped`,
            );
          }
          // Only the process that took this claim's token answers with a result: it ran (or finished) the restore, so it is over.
          // A refusal to admit it (not `archive_restore_failed`) may come from another process, e.g. a replacement daemon asked to
          // run a request the original never saw: the original may be running it still, so the claim stays held.
          if (!result.ok && result.code !== "archive_restore_failed") {
            throw new HostOpError(
              409,
              "archive_restore_unconfirmed",
              `${result.error}; ${host.label} did not run this restore, but nothing proves the daemon that reserved it is not still running it, so this session stays blocked until ${host.label} confirms it stopped`,
            );
          }
          claim.release();
          if (!result.ok) return opErrorResponse(result);
          invalidateHostSessionList(hostId);
          pumpOutbox(result.value.sessionId, hostId);
          return Response.json({ ok: true, sessionId: result.value.sessionId });
        }
        const sessionId = await restoreArchivedSession(
          body.key as string,
          undefined,
          undefined,
          claim.publish,
        );
        invalidateSessionListCache();
        invalidateLocalSessionLists();
        // Messages held while it was archived go now (spec O6).
        pumpOutbox(sessionId, hostId);
        return Response.json({ ok: true, sessionId });
      },
      confirmRestoreStopped,
    );
  } catch (error) {
    if (error instanceof RestoreHostOfflineError) {
      return Response.json(
        {
          error: error.message,
          code: error.code,
          hostOffline: true,
          host: error.host,
        },
        { status: error.status },
      );
    }
    if (error instanceof HostOpError) return apiErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: message, code: "archive_restore_failed" },
      { status: restoreFailureStatus(message) },
    );
  }
}
