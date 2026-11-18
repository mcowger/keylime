import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelTable } from "./daemon-channels";
import { readHierarchy } from "./project-hierarchy";
import {
  isEffortPath,
  isEffortRepo,
  stopSystems,
  systemsOperation,
  waitForSystemsSetup,
  type SystemsRuntime,
} from "./systems";
import { TerminalManager } from "./terminals";
import {
  removeRegisteredWorktree,
  stopWorkspaceCreation,
  workspaceCreationSettings,
} from "./workspace-creation";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

test("Effort retry preserves completed commands, pinned commits, and path ownership", async () => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "systems-effort-")),
  );
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  const terminals = new TerminalManager(() => {});
  const channels = new ChannelTable({
    prepareLaunch: (launch) => launch,
    log: () => {},
    spawn: async () => {
      throw new Error("Unexpected channel spawn");
    },
  });
  const runtime: SystemsRuntime = {
    terminals,
    processes: {
      fence: (cwd) => {
        const releaseChannels = channels.fenceWorkspace(cwd);
        const releaseTerminals = terminals.fence(cwd);
        return () => {
          releaseTerminals();
          releaseChannels();
        };
      },
      inspect: async (cwd) => [
        ...(await channels.inspectWorkspace(cwd)),
        ...terminals.inspect(cwd),
      ],
      stop: async (cwd) => {
        await Promise.all([
          channels.stopWorkspace(cwd),
          terminals.stopWorkspace(cwd),
        ]);
      },
    },
    sessionsChanged: () => {},
  };
  try {
    const repos = ["app", "worker"].map((name) => {
      const repo = path.join(dir, name);
      fs.mkdirSync(repo);
      git(repo, "init", "-b", "main");
      git(repo, "config", "user.name", "Effort Test");
      git(repo, "config", "user.email", "test@example.invalid");
      git(repo, "config", "commit.gpgsign", "false");
      git(repo, "config", "core.hooksPath", path.join(dir, "no-hooks"));
      git(repo, "commit", "--allow-empty", "-qm", "base");
      return repo;
    });
    const [app, worker] = repos;
    const root = path.join(dir, "worktrees");
    await systemsOperation({ action: "setRoot", root }, runtime);
    const {
      systems: [system],
    } = await systemsOperation(
      {
        action: "saveSystem",
        definition: {
          name: "Test System",
          repoPaths: repos,
          instructions: "Use the local test fixture.\n",
          services: [],
        },
      },
      runtime,
    );
    const override = {
      pre: ["printf 'pre\\n' >> .git/effort-test"],
      create: ["exit 90"],
      postBlocking: [
        "printf 'post\\n' >> \"$OMP_PROJECT_PATH/.git/effort-test\"",
        'test -f "$OMP_PROJECT_PATH/.git/effort-unblock"',
      ],
      postNonBlocking: [],
    };
    await workspaceCreationSettings({ projectPath: app, override });
    const input = { systemId: system.id, name: "Retry Test" };
    const { preview } = await systemsOperation(
      { action: "preview", ...input },
      runtime,
    );
    assert.ok(preview);
    assert.equal(preview.branch, "test-system/retry-test");
    assert.equal(preview.members[0].skipsCustomCreate, true);
    assert.equal(fs.existsSync(preview.root), false);
    const { effortId } = await systemsOperation(
      { action: "create", ...input, confirmation: preview.confirmation },
      runtime,
    );
    assert.ok(effortId);
    async function settled() {
      await waitForSystemsSetup();
      const {
        efforts: [effort],
      } = await systemsOperation({ action: "list" }, runtime);
      return effort;
    }
    let effort = await settled();
    assert.equal(effort.status, "failed", JSON.stringify(effort));
    assert.deepEqual(
      effort.members.map(({ status }) => status),
      ["failed", "complete"],
    );
    assert.equal(effort.members[0].stage, "postBlocking");
    assert.equal(isEffortPath(effort.root), true);
    assert.equal(
      isEffortPath(path.join(effort.members[0].path, "missing", "artifact")),
      true,
    );
    assert.equal(isEffortRepo(app), true);
    await assert.rejects(
      removeRegisteredWorktree({
        projectPath: app,
        path: effort.members[0].path,
        stopProcesses: false,
        discardChanges: false,
      }),
      { code: "effort_owned" },
    );
    const generated = path.join(effort.root, "AGENTS.md");
    const instructions = fs.readFileSync(generated, "utf8");
    assert.ok(instructions.startsWith("Use the local test fixture.\n"));
    assert.match(instructions, /repomap\.md/);
    fs.appendFileSync(generated, "Keep my notes.\n");
    git(app, "commit", "--allow-empty", "-qm", "later on main");
    assert.notEqual(
      git(app, "rev-parse", "HEAD"),
      preview.members[0].baseCommit,
    );
    await workspaceCreationSettings({
      projectPath: app,
      override: { ...override, postBlocking: ["exit 91"] },
    });
    fs.writeFileSync(path.join(app, ".git", "effort-unblock"), "");
    await systemsOperation({ action: "retry", effortId }, runtime);
    effort = await settled();
    assert.equal(effort.status, "ready", JSON.stringify(effort));
    assert.deepEqual(
      effort.members.map(({ status }) => status),
      ["complete", "complete"],
    );
    assert.equal(
      git(effort.members[0].path, "rev-parse", "HEAD"),
      preview.members[0].baseCommit,
    );
    assert.equal(
      fs.readFileSync(path.join(app, ".git", "effort-test"), "utf8"),
      "pre\npost\n",
    );
    const {
      efforts: [renamed],
    } = await systemsOperation(
      { action: "renameEffort", effortId, name: "New Name" },
      runtime,
    );
    assert.equal(renamed.root, effort.root);
    assert.equal(renamed.branch, effort.branch);
    assert.equal(
      readHierarchy().projects.find((project) => project.path === effort.root)
        ?.name,
      "New Name",
    );
    assert.equal(
      fs.readFileSync(generated, "utf8"),
      `${instructions}Keep my notes.\n`,
    );
    const artifact = path.join(effort.root, "server.log");
    fs.writeFileSync(artifact, "data\n");
    const dirty = path.join(effort.members[0].path, "unsaved.txt");
    fs.writeFileSync(dirty, "dirty\n");
    const { cleanup } = await systemsOperation(
      { action: "cleanupPreview", effortId },
      runtime,
    );
    assert.ok(cleanup);
    assert.deepEqual(cleanup.repos[0].dirty, ["unsaved.txt"]);
    const {
      efforts: [cleaned],
    } = await systemsOperation(
      {
        action: "cleanup",
        effortId,
        mode: "force",
        confirmation: cleanup.confirmation,
      },
      runtime,
    );
    assert.equal(fs.existsSync(dirty), false);
    assert.equal(cleaned.status, "cleaned", JSON.stringify(cleaned));
    assert.deepEqual(cleaned.retainedPaths, [generated, artifact]);
    assert.equal(fs.existsSync(path.join(cleaned.root, "repomap.md")), false);
    assert.equal(fs.readFileSync(artifact, "utf8"), "data\n");
    assert.equal(isEffortPath(cleaned.root), false);
    assert.equal(
      git(worker, "rev-parse", `refs/heads/${cleaned.branch}`),
      preview.members[1].baseCommit,
    );
    assert.equal(isEffortRepo(worker), true);
  } finally {
    await Promise.allSettled([
      stopSystems(),
      stopWorkspaceCreation(),
      terminals.stop(),
    ]);
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
