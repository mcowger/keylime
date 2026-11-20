// The daemon's retention of sent uploads (upload-retention.ts) against temp directories; no hub or daemon needed.
import assert from "node:assert/strict";
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mockBuiltin } from "../../tests/mock-builtin.ts";

const { sweepSentUploads, UploadRetention } =
  await import("./upload-retention.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const scratch = mkdtempSync(join(tmpdir(), "keylime-retention-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Session roots under a fresh temp dir. */
function layout() {
  const dir = mkdtempSync(join(scratch, "case-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  return {
    dir,
    agentDir,
    roots: {
      sessions: join(agentDir, "sessions"),
      archive: join(agentDir, "archive", "sessions"),
    },
  };
}

/** A file `ageDays` old (relative to now). */
function put(path: string, ageDays: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const when = (Date.now() - ageDays * DAY_MS) / 1000;
  utimesSync(path, when, when);
  return path;
}

const alive = (path: string) => existsSync(path);

test("a sweep deletes old uploads and keeps new ones in active and archived sessions", async () => {
  const { roots } = layout();
  const active = join(roots.sessions, "proj", "s1", "local", "uploads");
  const archived = join(roots.archive, "proj", "s2.jsonl", "local", "uploads");
  const kept = [];
  const gone = [];
  for (const folder of [active, archived]) {
    gone.push(put(join(folder, "old.zip"), 31));
    kept.push(put(join(folder, "new.zip"), 29));
  }
  // Not uploads: another file in `local/`, a session file, a directory in uploads (never entered), a compressed archive file.
  kept.push(put(join(roots.sessions, "proj", "s1", "local", "notes.txt"), 90));
  kept.push(put(join(roots.sessions, "proj", "s1.jsonl"), 90));
  kept.push(put(join(roots.archive, "proj", "s2.jsonl.gz"), 90));
  kept.push(put(join(active, "dir", "inner.bin"), 90));
  // The directory itself is old too: only regular files are ever deleted.
  const oldDir = join(active, "dir");
  const longAgo = (Date.now() - 90 * DAY_MS) / 1000;
  utimesSync(oldDir, longAgo, longAgo);
  kept.push(oldDir);

  await sweepSentUploads(30, Date.now(), roots);

  assert.deepEqual(gone.filter(alive), []);
  assert.deepEqual(
    kept.filter((path) => !alive(path)),
    [],
  );
  for (const folder of [active, archived])
    assert.equal(
      statSync(folder).isDirectory(),
      true,
      "the uploads folder stays",
    );
});

test("a sweep never follows a symlink: not an uploads entry, not `uploads`, not `local`", async () => {
  const { dir, roots } = layout();
  const outside = join(dir, "outside");
  const secret = put(join(outside, "secret.bin"), 400);
  const nested = put(join(outside, "uploads", "nested.bin"), 400);

  // An entry in uploads that points at an old file, and a real old one beside it.
  const entry = join(roots.sessions, "proj", "s1", "local", "uploads");
  const real = put(join(entry, "old.bin"), 400);
  const link = join(entry, "link.bin");
  symlinkSync(secret, link);
  // The symlink itself is old (lstat's mtime), so only the non-file check keeps it.
  lutimesSync(
    link,
    (Date.now() - 400 * DAY_MS) / 1000,
    (Date.now() - 400 * DAY_MS) / 1000,
  );
  // `uploads` itself a symlink to a directory with an old file.
  mkdirSync(join(roots.sessions, "proj", "s2", "local"), { recursive: true });
  symlinkSync(outside, join(roots.sessions, "proj", "s2", "local", "uploads"));
  // `local` a symlink to a directory holding uploads/.
  mkdirSync(join(roots.archive, "proj", "s3.jsonl"), { recursive: true });
  symlinkSync(outside, join(roots.archive, "proj", "s3.jsonl", "local"));
  // A session directory that is a symlink.
  symlinkSync(
    join(roots.sessions, "proj", "s2"),
    join(roots.sessions, "proj", "s4"),
  );
  // A symlinked project directory and a symlinked session directory (under both roots), each leading to a real
  // `local/uploads` with an old file outside the roots.
  const viaProject = put(
    join(dir, "outside-project", "s1", "local", "uploads", "old.bin"),
    400,
  );
  const viaSession = put(
    join(dir, "outside-session", "local", "uploads", "old.bin"),
    400,
  );
  for (const root of [roots.sessions, roots.archive]) {
    mkdirSync(join(root, "proj"), { recursive: true });
    symlinkSync(join(dir, "outside-project"), join(root, "linked-project"));
    symlinkSync(
      join(dir, "outside-session"),
      join(root, "proj", "linked-session"),
    );
  }

  await sweepSentUploads(30, Date.now(), roots);

  assert.equal(alive(real), false);
  assert.equal(
    alive(secret),
    true,
    "the target of a symlinked entry is not deleted",
  );
  assert.equal(
    alive(nested),
    true,
    "nothing is deleted through a symlinked uploads or local",
  );
  assert.equal(
    alive(join(entry, "link.bin")),
    true,
    "the symlink itself stays",
  );
  assert.equal(
    alive(viaProject),
    true,
    "a symlinked project directory is not entered",
  );
  assert.equal(
    alive(viaSession),
    true,
    "a symlinked session directory is not entered",
  );
});

test("startup and subsequent sweeps use the current daemon policy", async () => {
  const { roots } = layout();
  const old = put(
    join(roots.sessions, "proj", "s1", "local", "uploads", "old.bin"),
    400,
  );
  let days: number | null = null;
  const retention = new UploadRetention(() => days, roots);
  await retention.start();
  retention.stop();
  assert.equal(alive(old), true);
  days = 30;
  await retention.sweep();
  assert.equal(alive(old), false);
});

for (const relaxed of [null, 90]) {
  test(`a running sweep spares remaining files in the same folder after 7 days changes to ${relaxed}`, async (t) => {
    const { roots } = layout();
    const folder = join(roots.sessions, "proj", "s1", "local", "uploads");
    const files = ["a.bin", "b.bin", "c.bin"].map((name) =>
      put(join(folder, name), 40),
    );
    let days: number | null = 7;
    const real = { ...(await import("node:fs/promises")) };
    const removed: string[] = [];
    await mockBuiltin(t, "node:fs/promises", {
      async unlink(path: string) {
        await real.unlink(path);
        removed.push(path);
        if (removed.length === 1) days = relaxed;
      },
    });
    const freshModule = `./upload-retention.ts?fresh=mid-folder-${relaxed}`;
    const {
      UploadRetention: FreshUploadRetention,
    }: typeof import("./upload-retention") = await import(freshModule);
    const retention = new FreshUploadRetention(() => days, roots);
    await retention.sweep();
    assert.equal(
      removed.length,
      1,
      "only the unlink completed before the policy changed is allowed",
    );
    assert.equal(
      files.filter(alive).length,
      2,
      "the other expired files in that same folder survive",
    );
  });
}

test("unreadable roots and upload folders are reported; missing folders stay quiet", async (t) => {
  const { roots } = layout();
  const folder = join(roots.sessions, "proj", "s1", "local", "uploads");
  const old = put(join(folder, "old.bin"), 40);
  const real = { ...(await import("node:fs/promises")) };
  await mockBuiltin(t, "node:fs/promises", {
    async readdir(path: string, options?: { withFileTypes: true }) {
      if (path === roots.archive || path === folder)
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return options ? real.readdir(path, options) : real.readdir(path);
    },
  });
  const freshModule = "./upload-retention.ts?fresh=read-errors";
  const { sweepSentUploads: freshSweep }: typeof import("./upload-retention") =
    await import(freshModule);
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    console.error = error;
  });
  await freshSweep(7, Date.now(), roots);
  assert.equal(alive(old), true, "an unreadable folder is skipped");
  assert.equal(
    errors.length,
    2,
    "an absent temporary root is skipped without an error",
  );
  for (const path of [roots.archive, folder]) {
    assert.ok(
      errors.some(
        (line) => line.includes(path) && line.includes("permission denied"),
      ),
    );
  }
});

test("stopping retention scheduling does not hide a native sweep still removing old files", async (t) => {
  const { roots } = layout();
  const old = put(
    join(roots.sessions, "project", "session", "local", "uploads", "old.bin"),
    31,
  );
  const retention = new UploadRetention(() => 30, roots);
  t.after(() => retention.stop());
  const sweeping = retention.start();
  assert.equal(retention.busy(), true);
  retention.stop();
  assert.equal(
    retention.busy(),
    true,
    "maintenance must wait for the active native sweep, not just its timer",
  );
  await sweeping;
  assert.equal(retention.busy(), false);
  assert.equal(existsSync(old), false);
});
