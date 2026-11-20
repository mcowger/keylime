import { Database } from "bun:sqlite";
import { join } from "node:path";

/** Kernel-owned SQLite writer lock: release on process death, never expire by clock or PID. */
export function acquireDeployLock(base: string): () => void {
  const db = new Database(join(base, "deployment-lock.sqlite"));
  try {
    db.exec(
      "PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY);",
    );
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close(true);
    throw error;
  }
  return () => {
    db.exec("ROLLBACK");
    db.close(true);
  };
}
