import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { HostOpError } from "./hosts/link-protocol";
import { getAgentDir } from "./omp/paths";

const LEASE_MS = 30_000;
const RENEW_MS = 10_000;

/** A restore sent, or about to be sent, to `hostId` under claim token `claim`, whose outcome this server never learned: that
 * daemon may be running it, or be handed its request later by a sender that was suspended. `since`: when the claim last
 * renewed. `instance` is the daemon process that reserved the token: only that process can revoke the token and say
 * whether its restore runs, so no other answer proves the restore stopped. */
export type HeldRestore = {
  sessionId: string;
  hostId: string;
  claim: string;
  instance: string;
  since: number;
};

export type RestoreClaim = {
  /** The row's owner and the token daemons admit a restore by (`restoreReserve`, `restoreArchive`, `restoreFence`). */
  readonly token: string;
  /** This claim's restore is about to be sent to its host, already reserved there by the daemon process `instance`. Keeps the
   * session claimed past this request and past this process dying: a lease's clock cannot end a claim whose op can still
   * run, or still be sent, from another machine. Only `release()`, or a later request's `confirmStopped`, drops it. Throws
   * 409 when this request already lost its lease, before anything is sent. */
  hold(instance: string): void;
  /** The host gave a definite answer for the restore: drop the claim now. Never call it on an answer that does not prove this
   * claim's restore ended (a refusal to admit it, an error, silence): the claim then stays held. */
  release(): void;
  /** Run `run`, the step that makes a local restore's transcript visible, only while this claim still owns the session, with
   * the store's write lock held across it: no request can take the session over from a holder suspended past its lease
   * between the check and the publish, and one that takes over afterwards sees the published session. `run` must be
   * synchronous (no await): SQLite waits for a lock by blocking the whole process, so a lock held across an await would
   * freeze this process's event loop, and the await with it, for the busy timeout. */
  publish<T>(run: () => T): T;
};

/**
 * Main-only: coordinate restores of the same (host, session) across web processes sharing an agent directory.
 *
 * `confirmStopped` is asked about a held claim after its request stopped renewing it: the host's restore may be running, or
 * may still be sent. It resolves only once the host has fenced that claim (its restore can no longer start) and reports
 * nothing running, and throws otherwise; the claim is then taken over. Without it such a claim stays busy.
 */
export async function withArchiveRestoreLock<T>(
  hostId: string,
  sessionId: string,
  restore: (claim: RestoreClaim) => Promise<T>,
  confirmStopped?: (held: HeldRestore) => Promise<void>,
): Promise<T> {
  const dir = join(getAgentDir(), "keylime");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Clean cutover. Old controllers and outstanding restores must be stopped before switching stores.
  const path = join(dir, "archive-restore-host-locks.sqlite");
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const db = new Database(path);
  const owner = randomUUID();
  let claimed = false;
  let renewal: NodeJS.Timeout | undefined;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    // FULL: a held row is the only record that a daemon may still publish, so a power loss must not forget it.
    db.exec("PRAGMA synchronous = FULL");
    db.exec(`CREATE TABLE IF NOT EXISTS restore_claims (
      host_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      renewed_at INTEGER NOT NULL,
      instance TEXT,
      PRIMARY KEY (host_id, session_id)
    )`);
    const take = () =>
      db
        .transaction(() => {
          const now = Date.now();
          // A lease dated ahead (the writer's clock was fast) lapses too, or it would never expire.
          db.prepare(
            "DELETE FROM restore_claims WHERE host_id = ? AND session_id = ? AND instance IS NULL AND renewed_at NOT BETWEEN ? AND ?",
          ).run(hostId, sessionId, now - LEASE_MS, now + LEASE_MS);
          return (
            db
              .prepare(
                "INSERT INTO restore_claims (host_id, session_id, owner, renewed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
              )
              .run(hostId, sessionId, owner, now).changes === 1
          );
        })
        .immediate();
    claimed = take();
    if (!claimed && confirmStopped) {
      const now = Date.now();
      // A held claim still renewing belongs to a request awaiting its host: that one stays busy.
      const held = db
        .prepare(
          "SELECT owner, instance, renewed_at FROM restore_claims WHERE host_id = ? AND session_id = ? AND instance IS NOT NULL AND renewed_at NOT BETWEEN ? AND ?",
        )
        .get(hostId, sessionId, now - LEASE_MS, now + LEASE_MS) as {
        owner: string;
        instance: string;
        renewed_at: number;
      } | null;
      if (held) {
        await confirmStopped({
          sessionId,
          hostId,
          claim: held.owner,
          instance: held.instance,
          since: held.renewed_at,
        });
        db.prepare(
          "DELETE FROM restore_claims WHERE host_id = ? AND session_id = ? AND owner = ?",
        ).run(hostId, sessionId, held.owner);
        claimed = take();
      }
    }
    if (!claimed)
      throw new HostOpError(
        409,
        "archive_restore_busy",
        `Session ${sessionId} is already being restored`,
      );
    renewal = setInterval(() => {
      try {
        db.prepare(
          "UPDATE restore_claims SET renewed_at = ? WHERE host_id = ? AND session_id = ? AND owner = ?",
        ).run(Date.now(), hostId, sessionId, owner);
      } catch {
        /* busy: the next renewal retries well within the lease */
      }
    }, RENEW_MS);
    renewal.unref();
    return await restore({
      token: owner,
      hold(instance) {
        // Renewed in the same write: the request leaves right after, and a held row that looked stale would be fenced by another request.
        if (
          db
            .prepare(
              "UPDATE restore_claims SET instance = ?, renewed_at = ? WHERE host_id = ? AND session_id = ? AND owner = ?",
            )
            .run(instance, Date.now(), hostId, sessionId, owner).changes !== 1
        ) {
          throw new HostOpError(
            409,
            "archive_restore_busy",
            `Session ${sessionId} restore claim was lost`,
          );
        }
      },
      release() {
        try {
          db.prepare(
            "DELETE FROM restore_claims WHERE host_id = ? AND session_id = ? AND owner = ?",
          ).run(hostId, sessionId, owner);
        } catch {
          /* busy: the row stays held, which the next restore of this session asks the host about */
        }
      },
      publish(run) {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (
            !db
              .prepare(
                "SELECT 1 FROM restore_claims WHERE host_id = ? AND session_id = ? AND owner = ?",
              )
              .get(hostId, sessionId, owner)
          ) {
            throw new HostOpError(
              409,
              "archive_restore_busy",
              `Session ${sessionId} restore claim was lost; the archive was not restored`,
            );
          }
          const result = run();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* already ended */
          }
          throw error;
        }
      },
    });
  } catch (error) {
    if (
      !claimed &&
      error &&
      typeof error === "object" &&
      "errno" in error &&
      error.errno === 5
    ) {
      throw new HostOpError(
        409,
        "archive_restore_busy",
        `Session ${sessionId} restore lock is busy`,
      );
    }
    throw error;
  } finally {
    clearInterval(renewal);
    try {
      // A held row outlives this request: only its host's confirmation ends it.
      if (claimed)
        db.prepare(
          "DELETE FROM restore_claims WHERE host_id = ? AND session_id = ? AND owner = ? AND instance IS NULL",
        ).run(hostId, sessionId, owner);
    } finally {
      db.close(true);
    }
  }
}
