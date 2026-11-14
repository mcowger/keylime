import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { filePathApiSegments } from "../file-paths.ts";
import { workspaceHarness } from "./workspace-test-helper.mjs";

test("registered worktrees are host-owned and dirty removal requires explicit discard", async (t) => {
  const f = await workspaceHarness();
  t.after(() => f.close());
  const owner = await f.startHost();
  const other = await f.startHost();
  const cwd = owner.project;
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args]);
  git("init", "-q");
  git("config", "user.name", "Workspace test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(cwd, "file.txt"), "base");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const registered = await owner.host.workspaceOps.hierarchy({
    action: "registerProject",
    path: cwd,
  });
  assert.equal(registered.ok, true);
  assert.equal(registered.value.projects[0].path, cwd);
  const request = {
    projectPath: cwd,
    branch: "feature/remote",
    mode: "new",
    baseRef: "HEAD",
    name: "Remote feature",
  };
  const denied = await other.host.workspaceOps.createWorkspace(request);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "project_not_found");
  const added = await owner.host.workspaceOps.createWorkspace(request);
  assert.equal(added.ok, true);
  assert.equal(
    (await other.host.workspaceOps.workspaceCreationStatus(added.value.id)).ok,
    false,
  );
  let job = added.value;
  const deadline = Date.now() + 15_000;
  while (job.status === "running" && Date.now() < deadline) {
    await delay(50);
    const result = await owner.host.workspaceOps.workspaceCreationStatus(
      job.id,
    );
    assert.equal(result.ok, true);
    job = result.value;
  }
  assert.equal(job.status, "complete", job.error ?? job.logs);
  const target = job.workspacePath;
  assert.ok(target);
  const hierarchy = await owner.host.workspaceOps.hierarchy({ action: "list" });
  assert.equal(hierarchy.ok, true);
  assert.ok(
    hierarchy.value.projects[0].workspaces.some(
      (workspace) =>
        workspace.id === job.workspaceId && workspace.path === target,
    ),
  );
  const input = { segments: filePathApiSegments(target), sessionId: null };
  assert.equal(
    (await owner.host.workspaceOps.listFiles(input, false)).ok,
    true,
  );
  assert.equal(
    (await other.host.workspaceOps.listFiles(input, false)).status,
    403,
  );
  const listing = await owner.host.workspaceOps.listWorktrees(target);
  assert.equal(listing.value.projectRoot, cwd);
  assert.equal(listing.value.currentWorktreePath, target);
  const worktreeGit = (...args) => execFileSync("git", ["-C", target, ...args]);
  writeFileSync(join(target, "file.txt"), "committed bytes");
  worktreeGit("add", "file.txt");
  worktreeGit("commit", "-qm", "worktree history");
  const commit = worktreeGit("rev-parse", "HEAD").toString().trim();
  writeFileSync(join(target, "file.txt"), "dirty bytes");
  const removal = {
    projectPath: cwd,
    path: target,
    stopProcesses: false,
    discardChanges: false,
  };
  const foreignRemoval =
    await other.host.workspaceOps.removeRegisteredWorktree(removal);
  assert.equal(foreignRemoval.ok, false);
  assert.equal(foreignRemoval.code, "project_not_found");
  const dirty = await owner.host.workspaceOps.removeRegisteredWorktree(removal);
  assert.deepEqual(dirty, { ok: true, value: { status: "dirty" } });
  assert.equal(existsSync(target), true);
  const main = await owner.host.workspaceOps.removeRegisteredWorktree({
    ...removal,
    path: cwd,
    discardChanges: true,
  });
  assert.equal(main.ok, false);
  assert.equal(existsSync(cwd), true);
  const unrelated = await owner.host.workspaceOps.removeRegisteredWorktree({
    ...removal,
    path: other.project,
    discardChanges: true,
  });
  assert.equal(unrelated.ok, false);
  assert.equal(existsSync(other.project), true);
  assert.deepEqual(
    await owner.host.workspaceOps.removeRegisteredWorktree({
      ...removal,
      discardChanges: true,
    }),
    { ok: true, value: { status: "branch", branch: "feature/remote" } },
  );
  assert.deepEqual(
    await owner.host.workspaceOps.removeRegisteredWorktree({
      ...removal,
      discardChanges: true,
      keepBranch: true,
    }),
    { ok: true, value: { status: "deleted" } },
  );
  assert.equal(existsSync(target), false);
  assert.equal(
    git("rev-parse", "refs/heads/feature/remote").toString().trim(),
    commit,
  );
  const after = await owner.host.workspaceOps.hierarchy({ action: "list" });
  assert.equal(after.ok, true);
  assert.equal(
    after.value.projects[0].workspaces.some(
      (workspace) => workspace.id === job.workspaceId,
    ),
    false,
  );
});

test("host deletes a squash-integrated workspace without a branch decision", async (t) => {
  const f = await workspaceHarness();
  t.after(() => f.close());
  const owner = await f.startHost();
  const cwd = owner.project;
  const target = join(cwd, "..", "squash-workspace");
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args]);
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Workspace test");
  git(cwd, "config", "user.email", "test@example.invalid");
  writeFileSync(join(cwd, "base"), "base");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "base");
  const registered = await owner.host.workspaceOps.hierarchy({
    action: "registerProject",
    path: cwd,
  });
  assert.equal(registered.ok, true);
  git(cwd, "worktree", "add", "-qb", "squashed", target);
  writeFileSync(join(target, "change"), "change");
  git(target, "add", "change");
  git(target, "commit", "-qm", "change");
  const imported = await owner.host.workspaceOps.hierarchy({
    action: "importWorkspaces",
    projectId: registered.value.projects[0].id,
    paths: [target],
  });
  assert.equal(imported.ok, true);
  git(cwd, "merge", "--squash", "squashed");
  git(cwd, "commit", "-qm", "squashed");
  assert.deepEqual(
    await owner.host.workspaceOps.removeRegisteredWorktree({
      projectPath: cwd,
      path: target,
      stopProcesses: false,
      discardChanges: false,
    }),
    { ok: true, value: { status: "deleted" } },
  );
  assert.equal(existsSync(target), false);
  assert.equal(git(cwd, "branch", "--list", "squashed").toString().trim(), "");
});
