import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ShipJob } from "../workspace-ship-types";
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

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ship-test-")));
  const oldDir = process.env.PI_CODING_AGENT_DIR,
    oldPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh\necho "$*" >> '${root}/gh.log'\ncase "$1 $2" in\n  'auth status') exit 0;;\n  'pr list') if [ -f '${root}/lookup-fails' ] || { [ -f '${root}/fail-after-first' ] && [ -f '${root}/seen-lookup' ]; }; then echo 'GitHub rate limit exceeded' >&2; exit 1; elif [ -f '${root}/empty-after-first' ] && [ -f '${root}/seen-lookup' ]; then echo '[]'; else touch '${root}/seen-lookup'; if [ -f '${root}/open-pr' ]; then cat '${root}/open-pr'; else echo '[]'; fi; fi;;\n  'pr create') cat >/dev/null; if [ -f '${root}/race-pr' ]; then cp '${root}/race-pr' '${root}/open-pr'; echo 'PR already exists' >&2; exit 1; fi; echo https://github.com/test/repo/pull/42;;\n  'pr view') echo '{"state":"MERGED","mergedAt":"2026-11-14T00:00:00Z","url":"https://github.com/test/repo/pull/42","number":42,"autoMergeRequest":null,"statusCheckRollup":[]}';;\n  *) exit 0;;\nesac\n`,
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
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(project, "init", "-q");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  writeFileSync(join(project, "file"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-qm", "base");
  git(project, "remote", "add", "origin", remote);
  git(project, "push", "-u", "origin", "HEAD");
  git(project, "remote", "add", "github", "https://github.com/test/repo.git");
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
    root,
    workspace,
    git,
    input: { projectPath: project, path: workspace },
  };
}
async function finished(job: ShipJob) {
  const deadline = Date.now() + 15000;
  while (job.status === "running" && Date.now() < deadline) {
    await delay(25);
    job = await shipStatus(job.id);
  }
  return job;
}
test("PR lookup failure permits both PR modes and local landing", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "lookup-fails"), "");
  writeFileSync(join(f.workspace, "feature"), "feature");
  f.git(f.workspace, "add", ".");
  f.git(f.workspace, "commit", "-qm", "feature");
  const preview = await shipPreview(f.input);
  assert.equal(preview.pr, null);
  assert.match(preview.github.prLookupError!, /GitHub rate limit exceeded/);
  for (const mode of ["pr", "pr-auto"] as const) {
    const job = await finished(
      await startShip({
        ...f.input,
        mode,
        rebase: false,
        cleanup: false,
        pr: { title: "Feature", body: "Details" },
      }),
    );
    assert.equal(job.status, "complete", job.error);
    assert.equal(job.pr?.number, 42);
    if (mode === "pr-auto") assert.equal(job.pr?.autoMerge, true);
  }
  const local = await finished(
    await startShip({
      ...f.input,
      mode: "local",
      rebase: false,
      cleanup: false,
    }),
  );
  assert.equal(local.status, "complete", local.error);
  assert.equal(
    f.git(f.project, "rev-parse", "HEAD"),
    f.git(f.workspace, "rev-parse", "HEAD"),
  );
});

test("preview counts and local landing deletes merged branch", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "feature"), "feature");
  f.git(f.workspace, "add", ".");
  f.git(f.workspace, "commit", "-qm", "feature");
  const preview = await shipPreview(f.input);
  assert.equal(preview.ahead, 1);
  assert.equal(preview.behind, 0);
  assert.equal(preview.dirty, false);
  assert.deepEqual(preview.issues, []);
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
  assert.deepEqual(preview.issues, [
    `Potential conflicts with ${preview.base}: file`,
  ]);
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
test("preview reports unmerged files and in-progress operations without changing the workspace", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "file"), "feature\n");
  f.git(f.workspace, "commit", "-am", "feature");
  writeFileSync(join(f.project, "file"), "base change\n");
  f.git(f.project, "commit", "-am", "base change");
  assert.throws(() =>
    f.git(f.workspace, "merge", f.git(f.project, "branch", "--show-current")),
  );
  const before = f.git(f.workspace, "status", "--porcelain");
  const preview = await shipPreview(f.input);
  assert.ok(
    preview.issues.some((issue) =>
      issue.includes("Unresolved conflicts: file"),
    ),
  );
  assert.ok(
    preview.issues.some((issue) => issue.includes("merge is in progress")),
  );
  assert.equal(f.git(f.workspace, "status", "--porcelain"), before);
});
test("preview detects conflicts in uncommitted changes without modifying the index or worktree", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "file"), "staged feature\n");
  f.git(f.workspace, "add", "file");
  writeFileSync(join(f.workspace, "file"), "unstaged feature\n");
  writeFileSync(join(f.project, "file"), "base change\n");
  f.git(f.project, "commit", "-am", "base change");
  const status = f.git(f.workspace, "status", "--porcelain");
  const staged = f.git(f.workspace, "show", ":file");
  const preview = await shipPreview(f.input);
  assert.deepEqual(preview.issues, [
    `Potential conflicts with ${preview.base}: file`,
  ]);
  assert.equal(f.git(f.workspace, "status", "--porcelain"), status);
  assert.equal(f.git(f.workspace, "show", ":file"), staged);
  assert.equal(
    f.git(f.workspace, "diff", "--", "file").includes("unstaged feature"),
    true,
  );
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
  assert.ok(job.pr);
  assert.equal(job.pr.number, 42);
  await refreshShipPrs();
  const deadline = Date.now() + 15000;
  while (existsSync(f.workspace) && Date.now() < deadline) await delay(25);
  assert.equal(existsSync(f.workspace), false);
});

test("preview discovers an existing PR and auto-merge adopts it", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "open-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        autoMergeRequest: null,
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  const preview = await shipPreview(f.input);
  assert.equal(preview.pr?.number, 17);
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: true,
    }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.pr?.number, 17);
  assert.equal(job.pr?.autoMerge, true);
  assert.equal(job.pr?.cleanup, true);
  const log = readFileSync(join(f.root, "gh.log"), "utf8");
  assert.match(log, /pr merge 17 --squash --auto/);
  assert.doesNotMatch(log, /pr create/);
  await refreshShipPrs();
  const deadline = Date.now() + 15000;
  while (existsSync(f.workspace) && Date.now() < deadline) await delay(25);
  assert.equal(existsSync(f.workspace), false);
});
test("auto-merge retains the job preview PR only when post-push discovery fails", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "open-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  writeFileSync(join(f.root, "fail-after-first"), "");
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: false,
    }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.pr?.number, 17);
  assert.match(
    readFileSync(join(f.root, "gh.log"), "utf8"),
    /pr merge 17 --squash --auto/,
  );
});

test("auto-merge does not reuse a preview PR after a successful empty lookup", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "open-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  writeFileSync(join(f.root, "empty-after-first"), "");
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: false,
    }),
  );
  assert.equal(job.status, "failed");
  assert.match(job.error!, /title and body are required/);
  assert.doesNotMatch(readFileSync(join(f.root, "gh.log"), "utf8"), /pr merge/);
});

test("open PR mode rejects an existing PR before pushing", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "open-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr",
      rebase: false,
      cleanup: false,
      pr: { title: "Feature", body: "Details" },
    }),
  );
  assert.equal(job.status, "failed");
  assert.match(job.error!, /already exists/);
  assert.equal(
    job.steps.find((step) => step.name === "push")?.status,
    "pending",
  );
});

test("auto-merge requires a description when no PR exists", async (t) => {
  const f = await fixture(t);
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: false,
    }),
  );
  assert.equal(job.status, "failed");
  assert.match(job.error!, /title and body are required/);
});

test("auto-merge adopts a PR created concurrently", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "race-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: false,
      pr: { title: "Feature", body: "Details" },
    }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.pr?.number, 17);
  assert.match(
    readFileSync(join(f.root, "gh.log"), "utf8"),
    /pr merge 17 --squash --auto/,
  );
});
