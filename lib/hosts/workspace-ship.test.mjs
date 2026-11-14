import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  hierarchyOperation,
  registerCreatedWorkspace,
} from "./project-hierarchy.ts";
import { setWorkspaceDeletionAdapter } from "./workspace-creation.ts";
import {
  shipPreview,
  startShip,
  shipStatus,
  refreshShipPrs,
} from "./workspace-ship.ts";

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ship-test-")));
  const oldDir = process.env.PI_CODING_AGENT_DIR,
    oldPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh\ncase "$1 $2" in\n  'auth status') exit 0;;\n  'pr create') cat >/dev/null; echo https://github.com/test/repo/pull/42;;\n  'pr view') echo '{"state":"MERGED","mergedAt":"2026-11-14T00:00:00Z","url":"https://github.com/test/repo/pull/42","number":42,"autoMergeRequest":null,"statusCheckRollup":[]}';;\n  *) exit 0;;\nesac\n`,
  );
  chmodSync(gh, 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(root, "project"),
    workspace = join(root, "workspace"),
    remote = join(root, "remote.git");
  mkdirSync(project);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(project, "init", "-q");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  writeFileSync(join(project, "file"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-qm", "base");
  git(project, "remote", "add", "origin", remote);
  git(project, "push", "-u", "origin", "HEAD");
  const result = await hierarchyOperation({
    action: "registerProject",
    path: project,
  });
  assert.equal(result.ok, true);
  git(project, "worktree", "add", "-qb", "feature", workspace);
  registerCreatedWorkspace(project, workspace, "feature");
  setWorkspaceDeletionAdapter({
    fence: () => () => {},
    inspect: async () => [],
    stop: async () => {},
  });
  return {
    project,
    workspace,
    git,
    input: { projectPath: project, path: workspace },
  };
}
async function finished(job) {
  const deadline = Date.now() + 15000;
  while (job.status === "running" && Date.now() < deadline) {
    await delay(25);
    job = await shipStatus(job.id);
  }
  return job;
}
test("preview counts and local landing deletes merged branch", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "feature"), "feature");
  f.git(f.workspace, "add", ".");
  f.git(f.workspace, "commit", "-qm", "feature");
  const preview = await shipPreview(f.input);
  assert.equal(preview.ahead, 1);
  assert.equal(preview.behind, 0);
  assert.equal(preview.dirty, false);
  const job = await finished(
    await startShip({ ...f.input, mode: "local", rebase: true, cleanup: true }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.equal(existsSync(f.workspace), false);
  assert.throws(() =>
    f.git(f.project, "rev-parse", "--verify", "refs/heads/feature"),
  );
  assert.equal(f.git(f.project, "rev-parse", "HEAD"), job.landedSha);
});
test("conflicted rebase is aborted", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "file"), "feature\n");
  f.git(f.workspace, "commit", "-am", "feature");
  const before = f.git(f.workspace, "rev-parse", "HEAD");
  writeFileSync(join(f.project, "file"), "base change\n");
  f.git(f.project, "commit", "-am", "base change");
  const preview = await shipPreview(f.input);
  assert.equal(preview.ahead, 1);
  assert.equal(preview.behind, 1);
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "local",
      rebase: true,
      cleanup: false,
    }),
  );
  assert.equal(job.status, "conflict");
  assert.deepEqual(job.conflictFiles, ["file"]);
  assert.equal(f.git(f.workspace, "rev-parse", "HEAD"), before);
  assert.equal(f.git(f.workspace, "status", "--porcelain"), "");
});
test("merged PR watcher finishes and removes workspace", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "feature"), "feature");
  f.git(f.workspace, "add", ".");
  f.git(f.workspace, "commit", "-qm", "feature");
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr",
      rebase: false,
      cleanup: true,
      pr: { title: "Feature", body: "Details" },
    }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.pr.number, 42);
  await refreshShipPrs();
  const deadline = Date.now() + 15000;
  while (existsSync(f.workspace) && Date.now() < deadline) await delay(25);
  assert.equal(existsSync(f.workspace), false);
});
