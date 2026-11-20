// The daemon deletes expired sent uploads from its own active and archived sessions.
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getArchivedSessionsDir, getSessionsDir } from "../omp/paths";
import { loadHostSettings } from "../web-settings";
import { UPLOADS_LOCAL_DIR, withUploadNameLock } from "./uploads";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where sent uploads live: `<sessions>/<project>/<session>/local/uploads/*`, and the same under the archive
 * (a session's artifacts directory moves there whole). */
export interface RetentionRoots {
  sessions: string;
  archive: string;
}

function defaultRoots(): RetentionRoots {
  return {
    sessions: getSessionsDir(),
    archive: getArchivedSessionsDir(),
  };
}

/** The directories (never symlinks) directly in `dir`; empty when it cannot be read. */
async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(
        `[keylime host] upload retention: cannot read ${dir}: ${(error as Error).message}`,
      );
    return [];
  }
}

async function isRealDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Delete the regular files in `dir` last modified before the cutoff `cutoff()` returns at that moment (null: stop). A
 * symlink, directory or anything else is left alone; an entry that fails (gone, not ours to delete) is skipped and tried
 * at the next sweep. Returns false once the policy says stop. */
async function sweepDir(
  dir: string,
  cutoff: () => number | null,
): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(
        `[keylime host] upload retention: cannot read ${dir}: ${(error as Error).message}`,
      );
    return true;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      // Locked from stat to unlink: a publication cannot replace this name with a fresh file in between.
      const stop = await withUploadNameLock(async () => {
        const info = await lstat(file);
        if (!info.isFile()) return false;
        // Read per file: a setting made longer (or Never) while this sweep runs must not lose a file to the old one.
        const current = cutoff();
        if (current === null) return true;
        if (info.mtimeMs < current) await unlink(file);
        return false;
      });
      if (stop) return false;
    } catch {
      // Skipped.
    }
  }
  return true;
}

/** Delete every sent upload older than `days` days at `now`. Fixed depth: only the uploads folders, never a tree below
 * them, and a `local` or `uploads` that is a symlink is not followed. The folders stay. Staged files keep U3's 24 h rule.
 * The symlink checks see each directory as it is when checked: a directory swapped for a link during the sweep is not
 * caught (Node has no `unlinkat`), which only a process already running as this user can do. `days` may be a function,
 * read before each delete, so a sweep follows a setting changed while it runs (null: stop). */
export async function sweepSentUploads(
  days: number | (() => number | null),
  now = Date.now(),
  roots: RetentionRoots = defaultRoots(),
): Promise<void> {
  const cutoff = () => {
    const current = typeof days === "function" ? days() : days;
    return current === null ? null : now - current * DAY_MS;
  };
  const folders: string[] = [];
  for (const root of [roots.sessions, roots.archive]) {
    for (const project of await subdirs(root)) {
      for (const session of await subdirs(project)) {
        // A symlinked `local` would lead the sweep out of the session.
        const local = join(session, "local");
        if (await isRealDir(local))
          folders.push(join(local, UPLOADS_LOCAL_DIR));
      }
    }
  }
  for (const folder of folders) {
    if ((await isRealDir(folder)) && !(await sweepDir(folder, cutoff))) return;
  }
}

export class UploadRetention {
  private timer: NodeJS.Timeout | undefined;
  private active = 0;
  busy(): boolean {
    return this.active > 0;
  }

  constructor(
    private readonly readDays: () => number | null = () =>
      loadHostSettings().uploadRetentionDays,
    private readonly roots: RetentionRoots = defaultRoots(),
  ) {}

  /** Sweep with the stored setting, then again every 24 h (a timer that never keeps the process alive). */
  start(): Promise<void> {
    this.timer ??= setInterval(() => void this.sweep(), DAY_MS);
    this.timer.unref();
    return this.sweep();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A sweep is idempotent and skips entries that vanish under it, so two at once are harmless. It reads the setting
   * before each delete, so one still running after a change follows the new value. */
  async sweep(now = Date.now()): Promise<void> {
    if (this.readDays() === null) return;
    this.active++;
    try {
      await sweepSentUploads(this.readDays, now, this.roots);
    } finally {
      this.active--;
    }
  }
}
