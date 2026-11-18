import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { HierarchyRequest } from "../project-hierarchy-types";
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
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const op = async (input: HierarchyRequest) => {
    const result = await hierarchyOperation(input);
    assert.equal(result.ok, true, result.ok ? undefined : result.error);
    assert.ok(result.ok);
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
    assert.ok(candidates.workspaceCandidates);
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
        ?.sessionIds,
      [moved],
    );
    await assert.rejects(
      removeRegisteredWorktree({
        projectPath: project,
        path: primary.path,
        stopProcesses: false,
        discardChanges: false,
      }),
    );
    await workspaceCreationSettings({
      projectPath: project,
      override: {
        pre: ['printf pre > "$OMP_PROJECT_PATH/order"'],
        create: [],
        postBlocking: ['printf post >> "$OMP_PROJECT_PATH/order"', "exit 7"],
        postNonBlocking: [],
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
    assert.equal(job.stage, "postBlocking");
    assert.ok(job.workspacePath);
    const workspacePath = job.workspacePath;
    assert.ok(existsSync(path.join(job.workspacePath, "tracked")));
    const created = readHierarchy().projects[0].workspaces.find(
      (w) => w.path === job.workspacePath,
    );
    assert.ok(created?.setup);
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
        return stopped ? [] : [{ id: moved, cwd: workspacePath }];
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
    assert.equal(git("branch", "--list", "feature"), "");
    const existingGit = (...args: string[]) =>
      execFileSync("git", ["-C", existing, ...args], {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    writeFileSync(path.join(existing, "tracked"), "unmerged");
    existingGit("commit", "-am", "unmerged change");
    const existingRequest = {
      projectPath: project,
      path: existing,
      stopProcesses: true,
      discardChanges: false,
    };
    assert.deepEqual(await removeRegisteredWorktree(existingRequest), {
      status: "branch",
      branch: "existing",
    });
    assert.ok(existsSync(existing));
    assert.ok(
      readHierarchy().projects[0].workspaces.some((w) => w.path === existing),
    );
    assert.equal(
      (await removeRegisteredWorktree({ ...existingRequest, keepBranch: true }))
        .status,
      "deleted",
    );
    assert.equal(git("branch", "--list", "existing"), "existing");

    const forcePath = path.join(temporary, "force");
    git("worktree", "add", "-b", "force", forcePath, "existing");
    await op({
      action: "importWorkspaces",
      projectId: owner.id,
      paths: [forcePath],
    });
    const forceRequest = { ...existingRequest, path: forcePath };
    assert.deepEqual(await removeRegisteredWorktree(forceRequest), {
      status: "branch",
      branch: "force",
    });
    assert.equal(
      (await removeRegisteredWorktree({ ...forceRequest, keepBranch: false }))
        .status,
      "deleted",
    );
    assert.equal(git("branch", "--list", "force"), "");

    const squashPath = path.join(temporary, "squash");
    git("worktree", "add", "-b", "squash", squashPath);
    const squashGit = (...args: string[]) =>
      execFileSync("git", ["-C", squashPath, ...args], {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    writeFileSync(path.join(squashPath, "one"), "one");
    squashGit("add", "one");
    squashGit("commit", "-m", "first change");
    writeFileSync(path.join(squashPath, "two"), "two");
    squashGit("add", "two");
    squashGit("commit", "-m", "second change");
    await op({
      action: "importWorkspaces",
      projectId: owner.id,
      paths: [squashPath],
    });
    git("merge", "--squash", "squash");
    git("commit", "-m", "squash changes");
    // Git's branch -d checks the configured upstream, not necessarily HEAD.
    git("branch", "--set-upstream-to=existing", "squash");
    assert.deepEqual(
      await removeRegisteredWorktree({ ...existingRequest, path: squashPath }),
      { status: "deleted" },
    );
    assert.equal(existsSync(squashPath), false);
    assert.equal(git("branch", "--list", "squash"), "");

    const partialPath = path.join(temporary, "partial");
    git("worktree", "add", "-b", "partial", partialPath);
    const partialGit = (...args: string[]) =>
      execFileSync("git", ["-C", partialPath, ...args], {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    writeFileSync(path.join(partialPath, "three"), "three");
    partialGit("add", "three");
    partialGit("commit", "-m", "merged change");
    git("merge", "--squash", "partial");
    git("commit", "-m", "squash partial branch");
    writeFileSync(path.join(partialPath, "four"), "not merged");
    partialGit("add", "four");
    partialGit("commit", "-m", "later change");
    await op({
      action: "importWorkspaces",
      projectId: owner.id,
      paths: [partialPath],
    });
    assert.deepEqual(
      await removeRegisteredWorktree({ ...existingRequest, path: partialPath }),
      { status: "branch", branch: "partial" },
    );
    assert.ok(existsSync(partialPath));
    assert.equal(
      (
        await removeRegisteredWorktree({
          ...existingRequest,
          path: partialPath,
          keepBranch: true,
        })
      ).status,
      "deleted",
    );
    assert.equal(git("branch", "--list", "partial"), "partial");
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
    assert.ok(directoryProject);
    assert.equal(directoryProject.name, "ordinary");
    assert.equal(directoryProject.workspaces[0].name, "default");
    assert.equal(
      (await op({ action: "list" })).projects.find(
        (project) => project.path === ordinary,
      )?.workspaces[0].name,
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
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  try {
    const defaults = {
      pre: ["echo host-default"],
      create: [],
      postBlocking: [],
      postNonBlocking: [],
    };
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
    git(
      cwd,
      "worktree",
      "add",
      path.join(temporary, "feature"),
      "-b",
      "feature",
    );
    git(cwd, "branch", "local-only");
    git(cwd, "push", "origin", "feature", "HEAD:refs/heads/remote-only");
    const matched = await workspaceBranches(cwd);
    assert.equal(matched.defaultRef, "refs/heads/release");
    assert.equal(matched.originAheadRef, null);
    assert.deepEqual(matched.otherRefs, [
      "refs/heads/local-only",
      "refs/remotes/origin/remote-only",
    ]);
    const ahead = git(
      cwd,
      "commit-tree",
      "-p",
      "release",
      "-m",
      "Remote ahead",
      "release^{tree}",
    );
    git(cwd, "push", "origin", `${ahead}:refs/heads/release`);
    assert.equal(
      (await workspaceBranches(cwd)).originAheadRef,
      "refs/remotes/origin/release",
    );
    const localAhead = git(
      cwd,
      "commit-tree",
      "-p",
      ahead,
      "-m",
      "Local ahead",
      "release^{tree}",
    );
    git(cwd, "update-ref", "refs/heads/release", localAhead);
    assert.equal((await workspaceBranches(cwd)).originAheadRef, null);
    assert.deepEqual(
      (await workspaceCreationSettings({ projectPath: cwd })).defaults,
      defaults,
    );
    const override = {
      pre: [],
      create: [],
      postBlocking: ["echo project"],
      postNonBlocking: [],
    };
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
    const settingsFile = path.join(
      process.env.PI_CODING_AGENT_DIR,
      "keylime",
      "workspace-creation",
      "settings.json",
    );
    const legacy = { pre: [], create: [], post: ["echo old"] };
    const stored = JSON.stringify({ defaults: legacy, projects: {} });
    writeFileSync(settingsFile, stored);
    await assert.rejects(
      workspaceCreationSettings({ projectPath: cwd }),
      /Stored workspace pipeline is invalid/,
    );
    assert.equal(readFileSync(settingsFile, "utf8"), stored);
    await workspaceCreationSettings({ defaults });
    writeFileSync(
      settingsFile,
      JSON.stringify({ defaults, projects: { [cwd]: legacy } }),
    );
    await assert.rejects(
      workspaceCreationSettings({ projectPath: cwd }),
      /Stored workspace pipeline is invalid/,
    );
    await workspaceCreationSettings({ projectPath: cwd, override: null });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("project icon discovery finds repository assets without generated or escaped files", async () => {
  const temporary = realpathSync(
    mkdtempSync(path.join(tmpdir(), "keylime-icons-")),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  const project = path.join(temporary, "repo");
  mkdirSync(project);
  const create = (
    relative: string,
    data: string | Buffer = '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  ) => {
    const file = path.join(project, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  };
  try {
    execFileSync("git", ["-C", project, "init"], { stdio: "pipe" });
    create(".gitignore", "generated/\n*.ignored.svg\n");
    create(
      "docs/images/plexus_logo.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    create("packages/frontend/src/assets/plexus-icon.svg");
    create("dist/icon.svg");
    create("release/logo.svg");
    create("generated/icon.svg");
    create("docs/images/logo.ignored.svg");
    create("node_modules/pkg/icon.svg");
    create("a/b/c/d/e/f/icon.svg");
    writeFileSync(path.join(temporary, "outside.svg"), "<svg></svg>");
    symlinkSync(
      path.join(temporary, "outside.svg"),
      path.join(project, "icon.svg"),
    );
    const registered = await hierarchyOperation({
      action: "registerProject",
      path: project,
    });
    assert.ok(registered.ok);
    const result = await hierarchyOperation({
      action: "listProjectIcons",
      projectId: registered.value.projects[0].id,
    });
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.iconCandidates?.map((candidate) => candidate.path).sort(),
      [
        "docs/images/plexus_logo.png",
        "packages/frontend/src/assets/plexus-icon.svg",
      ],
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});
