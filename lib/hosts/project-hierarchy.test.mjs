import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  hierarchyOperation,
  readHierarchy,
  registerCreatedSession,
  moveRegisteredSession,
} from "./project-hierarchy";
import {
  createWorkspace,
  workspaceCreationStatus,
  workspaceCreationSettings,
  removeRegisteredWorktree,
  setWorkspaceDeletionAdapter,
  workspaceBranches,
} from "./workspace-creation";

// Each file has its own Bun process (--parallel); environment changes never leak to other fixtures.
test("explicit hierarchy stays selective and worktree setup preserves failed workspaces", async () => {
  const temporary = realpathSync(
    mkdtempSync(path.join(tmpdir(), "keylime-hierarchy-")),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  const project = path.join(temporary, "repo");
  mkdirSync(project);
  const git = (...args) =>
    execFileSync("git", ["-C", project, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const op = async (input) => {
    const result = await hierarchyOperation(input);
    assert.equal(result.ok, true, result.error);
    return result.value;
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(path.join(project, "tracked"), "original");
    git("add", ".");
    git("commit", "-m", "initial");
    const existing = path.join(temporary, "existing");
    git("worktree", "add", "-b", "existing", existing);
    assert.deepEqual(readHierarchy().projects, []);
    const registered = await op({ action: "registerProject", path: project });
    const owner = registered.projects[0];
    const primary = owner.workspaces[0];
    assert.equal(owner.workspaces.length, 1);
    assert.equal(primary.name, "main");
    git("switch", "-c", "renamed-default");
    const refreshed = await op({ action: "list" });
    assert.equal(refreshed.projects[0].workspaces[0].name, "renamed-default");
    assert.equal(refreshed.projects[0].name, "repo");
    git("switch", "main");
    const candidates = await op({
      action: "discoverWorkspaces",
      projectId: owner.id,
    });
    assert.equal(candidates.workspaceCandidates.length, 1);
    assert.equal(readHierarchy().projects[0].workspaces.length, 1);
    await op({
      action: "importWorkspaces",
      projectId: owner.id,
      paths: [existing],
    });
    await op({
      action: "importWorkspaces",
      projectId: owner.id,
      paths: [existing],
    });
    assert.equal(readHierarchy().projects[0].workspaces.length, 2);
    const session = "11111111-1111-4111-8111-111111111111";
    const moved = "22222222-2222-4222-8222-222222222222";
    registerCreatedSession(existing, session);
    moveRegisteredSession(session, moved);
    assert.deepEqual(
      readHierarchy().projects[0].workspaces.find((w) => w.path === existing)
        .sessionIds,
      [moved],
    );
    assert.equal(
      (
        await hierarchyOperation({
          action: "unregisterWorkspace",
          workspaceId: primary.id,
        })
      ).ok,
      false,
    );
    await workspaceCreationSettings({
      projectPath: project,
      override: {
        pre: ['printf pre > "$OMP_PROJECT_PATH/order"'],
        create: [],
        post: ['printf post >> "$OMP_PROJECT_PATH/order"', "exit 7"],
      },
    });
    const started = await createWorkspace({
      projectPath: project,
      mode: "new",
      branch: "feature",
      baseRef: "main",
      name: "feature",
    });
    let job = started;
    const deadline = Date.now() + 10000;
    while (job.status === "running") {
      assert.ok(Date.now() < deadline);
      await Bun.sleep(15);
      job = await workspaceCreationStatus(job.id);
    }
    assert.equal(job.status, "failed");
    assert.equal(job.stage, "post");
    assert.ok(existsSync(path.join(job.workspacePath, "tracked")));
    const created = readHierarchy().projects[0].workspaces.find(
      (w) => w.path === job.workspacePath,
    );
    assert.equal(created.setup.status, "failed");
    let fenced = false;
    let stopped = false;
    setWorkspaceDeletionAdapter({
      fence() {
        assert.equal(fenced, false);
        fenced = true;
        return () => {
          fenced = false;
        };
      },
      async inspect() {
        return stopped ? [] : [{ id: moved, cwd: job.workspacePath }];
      },
      async stop() {
        stopped = true;
      },
    });
    let deletion = await removeRegisteredWorktree({
      projectPath: project,
      path: job.workspacePath,
      stopProcesses: false,
      discardChanges: false,
    });
    assert.equal(deletion.status, "processes");
    assert.equal(stopped, false);
    assert.ok(existsSync(job.workspacePath));
    writeFileSync(path.join(job.workspacePath, "untracked"), "keep me");
    deletion = await removeRegisteredWorktree({
      projectPath: project,
      path: job.workspacePath,
      stopProcesses: true,
      discardChanges: false,
    });
    assert.equal(deletion.status, "dirty");
    assert.equal(stopped, true);
    await removeRegisteredWorktree({
      projectPath: project,
      path: job.workspacePath,
      stopProcesses: false,
      discardChanges: false,
      cancel: true,
    });
    assert.ok(existsSync(job.workspacePath));
    assert.equal(fenced, false);
    deletion = await removeRegisteredWorktree({
      projectPath: project,
      path: job.workspacePath,
      stopProcesses: true,
      discardChanges: true,
    });
    assert.equal(deletion.status, "deleted");
    assert.equal(existsSync(job.workspacePath), false);
    assert.equal(git("branch", "--list", "feature"), "feature");
    await op({ action: "unregisterProject", projectId: owner.id });
    const fresh = await op({ action: "registerProject", path: project });
    assert.equal(fresh.projects[0].workspaces.length, 1);
    assert.deepEqual(fresh.projects[0].workspaces[0].sessionIds, []);
    const ordinary = path.join(temporary, "ordinary");
    mkdirSync(ordinary);
    const directories = await op({ action: "registerProject", path: ordinary });
    const directoryProject = directories.projects.find(
      (project) => project.path === ordinary,
    );
    assert.equal(directoryProject.name, "ordinary");
    assert.equal(directoryProject.workspaces[0].name, "default");
    assert.equal(
      (await op({ action: "list" })).projects.find(
        (project) => project.path === ordinary,
      ).workspaces[0].name,
      "default",
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("host creation defaults work without projects and base ref follows remote HEAD", async () => {
  const temporary = realpathSync(
    mkdtempSync(path.join(tmpdir(), "keylime-default-ref-")),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  try {
    const defaults = { pre: ["echo host-default"], create: [], post: [] };
    assert.deepEqual(
      (await workspaceCreationSettings({ defaults })).defaults,
      defaults,
    );
    const cwd = path.join(temporary, "project");
    mkdirSync(cwd);
    git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.name", "Fixture");
    git(cwd, "config", "user.email", "fixture@example.invalid");
    git(cwd, "commit", "--allow-empty", "-m", "initial");
    git(cwd, "branch", "release");
    const remote = path.join(temporary, "remote.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-b", "release");
    git(cwd, "remote", "add", "origin", remote);
    git(cwd, "push", "origin", "main", "release");
    assert.equal(
      (await hierarchyOperation({ action: "registerProject", path: cwd })).ok,
      true,
    );
    assert.equal((await workspaceBranches(cwd)).defaultRef, "release");
    assert.deepEqual(
      (await workspaceCreationSettings({ projectPath: cwd })).defaults,
      defaults,
    );
    const override = { pre: [], create: [], post: ["echo project"] };
    await workspaceCreationSettings({ projectPath: cwd, override });
    assert.deepEqual(
      (await workspaceCreationSettings({ projectPath: cwd })).override,
      override,
    );
    await workspaceCreationSettings({ projectPath: cwd, override: null });
    assert.equal(
      (await workspaceCreationSettings({ projectPath: cwd })).override,
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});
