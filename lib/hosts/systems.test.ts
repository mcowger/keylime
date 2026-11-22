import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PlanningOperation } from "../api-contracts/planning";
import { ChannelTable } from "./daemon-channels";
import { planningOperation } from "./planning";
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
import { subscribeWorkspaceJobChanges } from "./workspace-job-changes";

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
  let failMemberInspection: string | undefined;
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
      inspect: async (cwd) => {
        if (cwd === failMemberInspection)
          throw new Error("Injected member inspection failure");
        return [
          ...(await channels.inspectWorkspace(cwd)),
          ...terminals.inspect(cwd),
        ];
      },
      stop: async (cwd) => {
        await Promise.all([
          channels.stopWorkspace(cwd),
          terminals.stopWorkspace(cwd),
        ]);
      },
    },
    sessionsChanged: () => {},
  };
  const jobInvalidations: Array<{ scope: string; statuses: string[] }> = [];
  const unsubscribe = subscribeWorkspaceJobChanges((scope) => {
    if (scope === "effort") {
      const file = path.join(dir, "agent", "keylime", "systems.json");
      if (fs.existsSync(file)) {
        const state = JSON.parse(fs.readFileSync(file, "utf8")) as {
          efforts: Array<{ status: string }>;
        };
        jobInvalidations.push({
          scope,
          statuses: state.efforts.map((e) => e.status),
        });
      }
    } else if (scope === "setup") {
      const jobs = path.join(
        dir,
        "agent",
        "keylime",
        "workspace-creation",
        "jobs",
      );
      if (fs.existsSync(jobs)) {
        const statuses = fs
          .readdirSync(jobs)
          .filter((name) => name.endsWith(".json"))
          .map((name) => {
            const job = JSON.parse(
              fs.readFileSync(path.join(jobs, name), "utf8"),
            ) as { status: string };
            return job.status;
          });
        jobInvalidations.push({ scope, statuses });
      }
    }
  });
  try {
    const repos = ["app", "worker"].map((name) => {
      const repo = path.join(dir, name);
      fs.mkdirSync(repo);
      git(repo, "init", "-b", name === "worker" ? "trunk" : "main");
      git(repo, "config", "user.name", "Effort Test");
      git(repo, "config", "user.email", "test@example.invalid");
      git(repo, "config", "commit.gpgsign", "false");
      git(repo, "config", "core.hooksPath", path.join(dir, "no-hooks"));
      fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n/dev-data/\n");
      git(repo, "add", "--force", ".gitignore");
      git(repo, "commit", "-qm", "base");
      if (name === "worker") {
        git(repo, "remote", "add", "origin", repo);
        git(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
        git(
          repo,
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          "refs/remotes/origin/trunk",
        );
      }
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
    const owner = { kind: "system", id: system.id } as const;
    const planning = (input: PlanningOperation["input"]) =>
      planningOperation({ owner, input }, () =>
        systemsOperation({ action: "list" }, runtime),
      );
    async function trackEffort(id: string, name: string, root: string) {
      const saved = await planning({
        action: "saveTask",
        brief: name,
        prompt: name,
        status: "in_progress",
      });
      const task = saved.tasks.at(-1)!;
      const started = await planning({
        action: "begin",
        taskId: task.id,
        revision: task.revision,
        id,
        name,
        setup: { kind: "system", name, confirmation: "confirmed", bases: [] },
      });
      const expected = started.tasks.find(
        (entry) => entry.id === task.id,
      )!.launch!;
      await planning({
        action: "updateLaunch",
        taskId: task.id,
        expected,
        next: {
          ...expected,
          version: expected.version + 1,
          phase: "ready",
          effortId: id,
          path: root,
        },
      });
      return task.id;
    }
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
    await delay(75);
    assert.ok(
      jobInvalidations.some(
        ({ scope, statuses }) =>
          scope === "effort" && statuses.includes("failed"),
      ),
    );
    assert.ok(
      jobInvalidations.some(
        ({ scope, statuses }) =>
          scope === "setup" && statuses.includes("failed"),
      ),
    );
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
    const taskId = await trackEffort(effortId, effort.name, effort.root);
    await planning({
      action: "saveTask",
      brief: "Other task",
      prompt: "Other task",
      status: "in_progress",
    });
    const taskStatus = async () =>
      (await planning({ action: "read" })).tasks.find(
        (task) => task.id === taskId,
      )!;
    const { cleanup: stopPreview } = await systemsOperation(
      { action: "cleanupPreview", effortId },
      runtime,
    );
    assert.ok(stopPreview);
    await systemsOperation(
      {
        action: "cleanup",
        effortId,
        mode: "stop",
        confirmation: stopPreview.confirmation,
      },
      runtime,
    );
    assert.equal((await taskStatus()).status, "in_progress");
    assert.equal(
      readHierarchy().projects.find((project) => project.path === worker)
        ?.hidden,
      true,
    );
    assert.equal(effort.members[0].defaultBranch, undefined);
    assert.equal(effort.members[1].defaultBranch, "trunk");
    assert.equal(effort.members[1].currentBranch, effort.branch);
    const workerCheckout = effort.members[1].path;
    git(worker, "switch", "-c", "source-branch");
    git(workerCheckout, "switch", "trunk");
    let observed = (await systemsOperation({ action: "list" }, runtime))
      .efforts[0];
    assert.equal(observed.members[1].currentBranch, "trunk");
    assert.equal(observed.members[1].defaultBranch, "trunk");
    git(workerCheckout, "switch", "--detach");
    observed = (await systemsOperation({ action: "list" }, runtime)).efforts[0];
    assert.equal(observed.members[1].currentBranch, undefined);
    assert.equal(observed.members[1].defaultBranch, "trunk");
    git(workerCheckout, "switch", effort.branch);

    const statePath = path.join(dir, "agent", "keylime", "systems.json");
    const stateBefore = fs.readFileSync(statePath, "utf8");
    const stored = JSON.parse(stateBefore);
    stored.efforts[0].members[1].currentBranch = "stale-current";
    stored.efforts[0].members[1].defaultBranch = "stale-default";
    const staleState = JSON.stringify(stored);
    fs.writeFileSync(statePath, staleState);
    observed = (await systemsOperation({ action: "list" }, runtime)).efforts[0];
    assert.equal(observed.members[1].currentBranch, effort.branch);
    assert.equal(observed.members[1].defaultBranch, "trunk");
    assert.equal(fs.readFileSync(statePath, "utf8"), staleState);
    fs.writeFileSync(statePath, stateBefore);

    const checkoutGit = path.join(workerCheckout, ".git");
    fs.renameSync(checkoutGit, `${checkoutGit}.hidden`);
    try {
      observed = (await systemsOperation({ action: "list" }, runtime))
        .efforts[0];
      assert.equal(observed.members[1].currentBranch, undefined);
      assert.equal(observed.members[1].defaultBranch, "trunk");
    } finally {
      fs.renameSync(`${checkoutGit}.hidden`, checkoutGit);
    }
    const repoGit = path.join(worker, ".git");
    fs.renameSync(repoGit, `${repoGit}.hidden`);
    try {
      observed = (await systemsOperation({ action: "list" }, runtime))
        .efforts[0];
      assert.equal(observed.members[1].currentBranch, undefined);
      assert.equal(observed.members[1].defaultBranch, undefined);
    } finally {
      fs.renameSync(`${repoGit}.hidden`, repoGit);
    }
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
    const checkout = effort.members[0].path;
    const ignored = path.join(checkout, ".env");
    fs.writeFileSync(ignored, "LOCAL_ONLY=keep-me\n");
    fs.mkdirSync(path.join(checkout, "dev-data"));
    fs.writeFileSync(path.join(checkout, "dev-data", "db.sqlite"), "local db");
    assert.equal(git(checkout, "status", "--porcelain"), "");
    const { cleanup: ignoredPreview } = await systemsOperation(
      { action: "cleanupPreview", effortId },
      runtime,
    );
    assert.ok(ignoredPreview);
    assert.deepEqual(ignoredPreview.repos[0].dirty, [".env", "dev-data/"]);
    await assert.rejects(
      systemsOperation(
        {
          action: "cleanup",
          effortId,
          mode: "remove",
          confirmation: ignoredPreview.confirmation,
        },
        runtime,
      ),
      { code: "effort_dirty" },
    );
    assert.equal((await taskStatus()).status, "in_progress");
    assert.equal(fs.readFileSync(ignored, "utf8"), "LOCAL_ONLY=keep-me\n");
    assert.equal(
      fs.readFileSync(path.join(checkout, "dev-data", "db.sqlite"), "utf8"),
      "local db",
    );
    const dirty = path.join(effort.members[0].path, "unsaved.txt");
    fs.writeFileSync(dirty, "dirty\n");
    const { cleanup } = await systemsOperation(
      { action: "cleanupPreview", effortId },
      runtime,
    );
    assert.ok(cleanup);
    assert.deepEqual(cleanup.repos[0].dirty, [
      ".env",
      "dev-data/",
      "unsaved.txt",
    ]);
    failMemberInspection = effort.members[1].path;
    const { efforts: failedEfforts } = await systemsOperation(
      {
        action: "cleanup",
        effortId,
        mode: "force",
        confirmation: cleanup.confirmation,
      },
      runtime,
    );
    assert.equal(
      failedEfforts.find(({ id }) => id === effortId)?.status,
      "cleanup_failed",
    );
    assert.equal(fs.existsSync(effort.members[0].path), false);
    assert.equal(fs.existsSync(effort.members[1].path), true);
    assert.equal((await taskStatus()).status, "in_progress");
    failMemberInspection = undefined;
    const { cleanup: retryPreview } = await systemsOperation(
      { action: "cleanupPreview", effortId },
      runtime,
    );
    assert.ok(retryPreview);
    const {
      efforts: [cleaned],
    } = await systemsOperation(
      {
        action: "cleanup",
        effortId,
        mode: "force",
        confirmation: retryPreview.confirmation,
      },
      runtime,
    );
    assert.equal(fs.existsSync(dirty), false);
    assert.equal(fs.existsSync(ignored), false);
    assert.equal(cleaned.status, "cleaned", JSON.stringify(cleaned));
    const completed = await taskStatus();
    assert.equal(completed.status, "done");
    assert.equal(completed.revision, 3);
    assert.equal(
      (await planning({ action: "read" })).tasks.find(
        (task) => task.brief === "Other task",
      )?.status,
      "in_progress",
    );
    await planning({
      action: "saveTask",
      taskId,
      revision: completed.revision,
      brief: completed.brief,
      prompt: completed.prompt,
      status: "ready",
    });
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      efforts: { id: string; planningCompletionPending?: boolean }[];
    };
    state.efforts.find(({ id }) => id === effortId)!.planningCompletionPending =
      true;
    fs.writeFileSync(statePath, JSON.stringify(state));
    await systemsOperation({ action: "list" }, runtime);
    const recovered = await taskStatus();
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.revision, completed.revision + 1);
    await systemsOperation({ action: "list" }, runtime);
    assert.equal((await taskStatus()).status, "ready");
    assert.deepEqual(cleaned.retainedPaths, [generated, artifact]);
    assert.equal(fs.existsSync(path.join(cleaned.root, "repomap.md")), false);
    assert.equal(fs.readFileSync(artifact, "utf8"), "data\n");
    assert.equal(isEffortPath(cleaned.root), false);
    assert.equal(
      git(worker, "rev-parse", `refs/heads/${cleaned.branch}`),
      preview.members[1].baseCommit,
    );
    assert.equal(isEffortRepo(worker), true);

    for (const repo of repos)
      await workspaceCreationSettings({
        projectPath: repo,
        override: { ...override, pre: ["exit 97"] },
      });
    const emptyInput = { systemId: system.id, name: "No created worktrees" };
    const { preview: emptyPlan } = await systemsOperation(
      { action: "preview", ...emptyInput },
      runtime,
    );
    assert.ok(emptyPlan);
    const { effortId: emptyId } = await systemsOperation(
      { action: "create", ...emptyInput, confirmation: emptyPlan.confirmation },
      runtime,
    );
    assert.ok(emptyId);
    await waitForSystemsSetup();
    const emptyTask = await trackEffort(
      emptyId,
      emptyInput.name,
      emptyPlan.root,
    );
    const { cleanup: emptyPreview } = await systemsOperation(
      { action: "cleanupPreview", effortId: emptyId },
      runtime,
    );
    assert.ok(emptyPreview);
    const emptyResult = await systemsOperation(
      {
        action: "cleanup",
        effortId: emptyId,
        mode: "remove",
        confirmation: emptyPreview.confirmation,
      },
      runtime,
    );
    assert.equal(
      emptyResult.efforts.find(({ id }) => id === emptyId)?.status,
      "cleaned",
    );
    assert.equal(
      (await planning({ action: "read" })).tasks.find(
        ({ id }) => id === emptyTask,
      )?.status,
      "in_progress",
    );
    await workspaceCreationSettings({ projectPath: worker, override: null });

    await workspaceCreationSettings({ projectPath: app, override: null });
    // Root can read mode-000 files, so only exercise denial as a non-root user.
    for (const unreadable of process.getuid?.() === 0
      ? [false]
      : [false, true]) {
      const cleanInput = {
        systemId: system.id,
        name: unreadable ? "Unreadable instructions" : "Clean worktrees",
      };
      const { preview: cleanPlan } = await systemsOperation(
        { action: "preview", ...cleanInput },
        runtime,
      );
      assert.ok(cleanPlan);
      const { effortId: cleanId } = await systemsOperation(
        {
          action: "create",
          ...cleanInput,
          confirmation: cleanPlan.confirmation,
        },
        runtime,
      );
      assert.ok(cleanId);
      await waitForSystemsSetup();
      for (const name of ["AGENTS.md", "repomap.md"])
        assert.ok(fs.existsSync(path.join(cleanPlan.root, name)));
      const instructionsPath = path.join(cleanPlan.root, "AGENTS.md");
      const original = fs.readFileSync(instructionsPath);
      if (unreadable) fs.chmodSync(instructionsPath, 0o000);
      const { cleanup: cleanPreview } = await systemsOperation(
        { action: "cleanupPreview", effortId: cleanId },
        runtime,
      );
      assert.ok(cleanPreview);
      assert.deepEqual(
        cleanPreview.repos.map(({ dirty }) => dirty),
        [[], []],
      );
      const { efforts } = await systemsOperation(
        {
          action: "cleanup",
          effortId: cleanId,
          mode: "remove",
          confirmation: cleanPreview.confirmation,
        },
        runtime,
      );
      const cleanResult = efforts.find(({ id }) => id === cleanId);
      assert.equal(cleanResult?.status, "cleaned", JSON.stringify(cleanResult));
      assert.deepEqual(
        cleanResult?.retainedPaths,
        unreadable ? [instructionsPath] : [],
      );
      if (unreadable) {
        for (const { path: checkoutPath } of cleanPlan.members)
          assert.equal(fs.existsSync(checkoutPath), false);
        assert.equal(
          fs.existsSync(path.join(cleanPlan.root, "repomap.md")),
          false,
        );
        fs.chmodSync(instructionsPath, 0o600);
        assert.deepEqual(fs.readFileSync(instructionsPath), original);
      } else {
        assert.equal(fs.existsSync(cleanPlan.root), false);
      }
    }
  } finally {
    unsubscribe();
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
