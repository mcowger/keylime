import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceHarness } from "./workspace-test-helper.mjs";

test("linked hosts follow the live project recipe for creation and teardown without replacing manual settings", async (t) => {
  const fixture = await workspaceHarness();
  t.after(() => fixture.close());
  const owner = await fixture.startHost();
  const projectPath = owner.project;
  const git = (...args) =>
    execFileSync("git", ["-C", projectPath, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Workspace test");
  git("config", "user.email", "workspace@example.invalid");
  writeFileSync(join(projectPath, ".gitignore"), ".env\nsetup.txt\nmanual.txt\n");
  writeFileSync(join(projectPath, ".worktreeinclude"), ".env\n");
  const recipePath = join(projectPath, "paseo.json");
  const recipe = (setup, teardown = []) =>
    writeFileSync(recipePath, JSON.stringify({ worktree: { setup, teardown } }));
  recipe(["printf committed > setup.txt"]);
  git("add", ".");
  git("commit", "-qm", "project");
  writeFileSync(join(projectPath, ".env"), "local configuration");
  const registered = await owner.host.workspaceOps.hierarchy({
    action: "registerProject",
    path: projectPath,
  });
  assert.equal(registered.ok, true, registered.error);
  const manual = { pre: [], create: [], post: ["printf manual > manual.txt"] };
  let settings = await owner.host.workspaceOps.workspaceCreationSettings({
    projectPath,
    override: manual,
    source: "paseo",
  });
  assert.equal(settings.ok, true, settings.error);
  assert.equal(settings.value.source, "paseo");
  assert.deepEqual(settings.value.override, manual);

  async function create(branch) {
    const result = await owner.host.workspaceOps.createWorkspace({
      projectPath,
      branch,
      mode: "new",
      baseRef: "main",
      name: branch,
    });
    assert.equal(result.ok, true, result.error);
    let job = result.value;
    const deadline = Date.now() + 15_000;
    while (job.status === "running" && Date.now() < deadline) {
      await delay(25);
      const status = await owner.host.workspaceOps.workspaceCreationStatus(job.id);
      assert.equal(status.ok, true, status.error);
      job = status.value;
    }
    assert.equal(job.status, "complete", job.error ?? job.logs);
    assert.ok(job.workspacePath);
    return job.workspacePath;
  }

  // The dirty source recipe is deliberately different from the committed file
  // checked out into the new workspace, and changes after source selection.
  recipe([
    'test "$(cat .env)" = "local configuration"',
    'test "$PASEO_PROJECT_PATH" = "$OMP_PROJECT_PATH" && test "$PASEO_PROJECT_PATH" = "$PASEO_SOURCE_CHECKOUT_PATH"',
    'test "$PASEO_WORKSPACE_PATH" = "$OMP_WORKSPACE_PATH" && test "$PASEO_WORKSPACE_PATH" = "$PASEO_WORKTREE_PATH" && test "$PASEO_WORKSPACE_PATH" = "$PWD"',
    'test "$PASEO_BRANCH" = "$OMP_BRANCH" && test "$PASEO_BRANCH" = "$PASEO_BRANCH_NAME" && test "$PASEO_BRANCH" = "live-first"',
    'test "$PASEO_BASE_REF" = "$OMP_BASE_REF" && test "$PASEO_BASE_REF" = "main"',
    'test "$PASEO_BRANCH_MODE" = "$OMP_BRANCH_MODE" && test "$PASEO_BRANCH_MODE" = "new"',
    'test -n "$PASEO_CREATE_RESULT" && test "$PASEO_CREATE_RESULT" = "$OMP_CREATE_RESULT"',
    'printf "%s" "$PASEO_SOURCE_CHECKOUT_PATH" > setup.txt',
  ]);
  const first = await create("live-first");
  assert.equal(readFileSync(join(first, "setup.txt"), "utf8"), projectPath);
  assert.equal(existsSync(join(first, "manual.txt")), false);
  assert.equal(readFileSync(join(first, ".env"), "utf8"), "local configuration");
  assert.equal(
    JSON.parse(readFileSync(join(first, "paseo.json"), "utf8")).worktree.setup[0],
    "printf committed > setup.txt",
  );

  recipe(["printf second > setup.txt"]);
  const second = await create("live-second");
  assert.equal(readFileSync(join(second, "setup.txt"), "utf8"), "second");
  const deletion = {
    projectPath,
    path: first,
    stopProcesses: true,
    discardChanges: true,
    keepBranch: true,
  };
  recipe([], ["printf teardown-failed >&2; exit 9"]);
  const refused = await owner.host.workspaceOps.removeRegisteredWorktree(deletion);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /teardown/i);
  assert.equal(existsSync(first), true);
  const retained = await owner.host.workspaceOps.hierarchy({ action: "list" });
  assert.equal(retained.ok, true, retained.error);
  assert.ok(retained.value.projects[0].workspaces.some((workspace) => workspace.path === first));

  recipe([], [
    'test "$PASEO_PROJECT_PATH" = "$OMP_PROJECT_PATH" && test "$PASEO_PROJECT_PATH" = "$PASEO_SOURCE_CHECKOUT_PATH"',
    'test "$PASEO_WORKSPACE_PATH" = "$OMP_WORKSPACE_PATH" && test "$PASEO_WORKSPACE_PATH" = "$PASEO_WORKTREE_PATH" && test "$PASEO_WORKSPACE_PATH" = "$PWD"',
    'test "$PASEO_BRANCH" = "$OMP_BRANCH" && test "$PASEO_BRANCH" = "$PASEO_BRANCH_NAME" && test "$PASEO_BRANCH" = "live-first"',
    'printf "%s" "$PASEO_WORKTREE_PATH" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown.txt"',
  ]);
  const removed = await owner.host.workspaceOps.removeRegisteredWorktree(deletion);
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removed.value.status, "deleted");
  assert.equal(existsSync(first), false);
  assert.equal(readFileSync(join(projectPath, "teardown.txt"), "utf8"), first);

  settings = await owner.host.workspaceOps.workspaceCreationSettings({
    projectPath,
    source: "manual",
  });
  assert.equal(settings.ok, true, settings.error);
  assert.deepEqual(settings.value.override, manual);
  const third = await create("manual-again");
  assert.equal(readFileSync(join(third, "manual.txt"), "utf8"), "manual");
  assert.equal(existsSync(join(third, "setup.txt")), false);
});
