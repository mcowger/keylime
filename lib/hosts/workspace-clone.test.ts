import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SpawnOptions } from "node:child_process";
import type { BigIntStats, PathLike } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { CloneProgress } from "../git-clone";
import type { WorkspaceClones as WorkspaceClonesType } from "./workspace-clone";
import { mockBuiltin } from "../../tests/mock-builtin.ts";

type FsOverrides = {
  lstat: (path: PathLike, options: { bigint: true }) => Promise<BigIntStats>;
};

async function fixture(t: TestContext, fsOverrides?: FsOverrides) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-clone-job-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const script = join(root, "controlled-child.cjs");
  writeFileSync(
    script,
    `
    const fs = require('node:fs'), path = require('node:path');
    const target = process.argv.at(-1), url = process.argv.at(-2);
    fs.writeFileSync(path.join(target, 'child.txt'), 'clone bytes');
    fs.writeFileSync(path.join(path.dirname(target), 'child.pid'), String(process.pid));
    process.on('SIGTERM', () => process.exit(1));
    process.stdout.write('progress\\n');
    if (url.includes('/fast.git')) process.exit(0);
    else { process.stdout.write('x'.repeat(400000)); setInterval(() => {}, 1000); }
  `,
  );
  const real = { ...(await import("node:child_process")) };
  await mockBuiltin(t, "node:child_process", {
    spawn: (command: string, args: readonly string[], options: SpawnOptions) =>
      command === "git"
        ? real.spawn(process.execPath, [script, ...args], options)
        : real.spawn(command, args, options),
  });
  if (fsOverrides) await mockBuiltin(t, "node:fs/promises", fsOverrides);
  const { grantWorkspaceRoot } = await import("./workspace-roots.ts");
  grantWorkspaceRoot(root);
  const { WorkspaceClones } = (await import(
    `./workspace-clone.ts?fresh=${randomUUID()}`
  )) as { WorkspaceClones: typeof WorkspaceClonesType };
  const jobs = new WorkspaceClones();
  t.after(() => jobs.stop());
  return { root, jobs };
}

function assertChildExited(root: string) {
  const pid = Number(readFileSync(join(root, "child.pid"), "utf8"));
  assert.throws(
    () => process.kill(pid, 0),
    (error) =>
      error instanceof Error && "code" in error && error.code === "ESRCH",
  );
}
async function terminal(jobs: WorkspaceClonesType, id: string) {
  let page: CloneProgress | undefined;
  do {
    page = await jobs.read(id, page?.cursor ?? 0);
  } while (!page.terminal);
  return page;
}

test("clone jobs retain success receipts and late cancellation never removes the completed workspace", async (t) => {
  const { root, jobs } = await fixture(t);
  const id = randomUUID();
  await jobs.start(id, root, "https://example.invalid/fast.git");
  const page = await terminal(jobs, id);
  assert.equal(page.frames.at(-1)?.type, "done");
  const target = join(root, "fast");
  assert.equal(readFileSync(join(target, "child.txt"), "utf8"), "clone bytes");
  assert.equal((await jobs.cancel(id)).frames.at(-1)?.type, "done");
  assert.equal(existsSync(target), true);
  await jobs.start(id, root, "https://example.invalid/fast.git");
  assert.equal(readFileSync(join(target, "child.txt"), "utf8"), "clone bytes");
  await assert.rejects(
    jobs.start(randomUUID(), root, "https://example.invalid/fast.git"),
    (e) => e instanceof Error && "status" in e && e.status === 409,
  );
  assert.equal(existsSync(target), true);
});

test("cancellation waits for actual process exit and cleanup, while progress rollover stays bounded", async (t) => {
  const { root, jobs } = await fixture(t);
  const id = randomUUID();
  await jobs.start(id, root, "https://example.invalid/slow.git");
  let page: CloneProgress | undefined;
  do {
    page = await jobs.read(id, page?.cursor ?? 0);
  } while (page.cursor < 400000);
  page = await jobs.read(id, 0);
  assert.equal(page.reset, true);
  assert.ok(
    page.frames.reduce(
      (n, f) => n + (f.type === "output" ? Buffer.byteLength(f.text) : 0),
      0,
    ) <=
      256 * 1024,
  );
  const cancelled = await jobs.cancel(id);
  assert.equal(cancelled.frames.at(-1)?.type, "cancelled");
  assertChildExited(root);
  assert.equal(existsSync(join(root, "slow")), false);
});

test("cleanup refuses a replacement directory and unknown jobs never report successful cancellation", async (t) => {
  const { root, jobs } = await fixture(t);
  const id = randomUUID();
  await jobs.start(id, root, "https://example.invalid/slow.git");
  while (!existsSync(join(root, "child.pid"))) await jobs.read(id, 0);
  renameSync(join(root, "slow"), join(root, "moved-owned-clone"));
  mkdirSync(join(root, "slow"));
  writeFileSync(join(root, "slow", "user.txt"), "keep me");
  const page = await jobs.cancel(id);
  const failure = page.frames.at(-1);
  assert.ok(failure?.type === "error");
  assert.equal(failure.code, "clone_cleanup_failed");
  assert.equal(readFileSync(join(root, "slow", "user.txt"), "utf8"), "keep me");
  await assert.rejects(
    jobs.cancel(randomUUID()),
    (e) => e instanceof Error && "code" in e && e.code === "clone_not_found",
  );
  await assert.rejects(
    jobs.start(randomUUID(), root, "file:///tmp/unsafe.git"),
    (e) => e instanceof Error && "code" in e && e.code === "invalid_git_url",
  );
});

test("an unobserved clone exits and cleans up, then its terminal receipt expires as unknown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root, jobs } = await fixture(t);
  const id = randomUUID();
  await jobs.start(id, root, "https://example.invalid/slow.git");
  let page = await jobs.read(id, 0);
  assert.equal(existsSync(join(root, "child.pid")), true);
  t.mock.timers.tick(120_000);
  do {
    page = await jobs.read(id, page.cursor);
  } while (!page.terminal);
  assert.equal(page.frames.at(-1)?.type, "cancelled");
  assertChildExited(root);
  assert.equal(existsSync(join(root, "slow")), false);
  t.mock.timers.tick(120_000);
  await assert.rejects(
    jobs.read(id, 0),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "clone_not_found",
  );
});

test("a replacement arriving after cleanup's identity check is preserved rather than recursively deleted", async (t) => {
  const real = { ...(await import("node:fs/promises")) };
  let target: string,
    armed = false,
    swapped = false;
  const { root, jobs } = await fixture(t, {
    async lstat(path: PathLike, options: { bigint: true }) {
      const info = await real.lstat(path, options);
      if (armed && String(path) === target && !swapped) {
        swapped = true;
        await real.rename(target, `${target}-moved`);
        await real.mkdir(target);
        await real.writeFile(
          join(target, "replacement.txt"),
          "unrelated user bytes",
        );
      }
      return info;
    },
  });
  target = join(root, "slow");
  const id = randomUUID();
  await jobs.start(id, root, "https://example.invalid/slow.git");
  await jobs.read(id, 0);
  armed = true;
  const page = await jobs.cancel(id);
  assert.equal(swapped, true);
  const retained = readdirSync(root, {
    recursive: true,
    encoding: "utf8",
  }).filter((path) => path.endsWith("replacement.txt"));
  assert.equal(
    retained.length,
    1,
    "the replacement's data must survive cleanup even when it races the ownership check",
  );
  assert.equal(
    readFileSync(join(root, retained[0]), "utf8"),
    "unrelated user bytes",
  );
  const failure = page.frames.at(-1);
  assert.ok(failure?.type === "error");
  assert.equal(failure.code, "clone_cleanup_failed");
});
