import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceHarness } from "./workspace-test-helper.ts";

test("linked hosts follow the live project recipe for creation and teardown without replacing manual settings", async (t) => {
  const fixture = await workspaceHarness();
  t.after(() => fixture.close());
  const owner = await fixture.startHost();
  const projectPath = owner.project;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", projectPath, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Workspace test");
  git("config", "user.email", "workspace@example.invalid");
  writeFileSync(
    join(projectPath, ".gitignore"),
    ".env\nsetup.txt\nmanual.txt\n",
  );
  writeFileSync(join(projectPath, ".worktreeinclude"), ".env\n");
  const recipePath = join(projectPath, "paseo.json");
  const recipe = (setup: string[], teardown: string[] = []) =>
    writeFileSync(
      recipePath,
      JSON.stringify({ worktree: { setup, teardown } }),
    );
  recipe(["printf committed > setup.txt"]);
  git("add", ".");
  git("commit", "-qm", "project");
  writeFileSync(join(projectPath, ".env"), "local configuration");
  const registered = await owner.host.workspaceOps.hierarchy({
    action: "registerProject",
    path: projectPath,
  });
  assert.ok(registered.ok, !registered.ok ? registered.error : undefined);
  const manual = {
    pre: [],
    create: [],
    postBlocking: ["printf manual > manual.txt"],
    postNonBlocking: [],
  };
  let settings = await owner.host.workspaceOps.workspaceCreationSettings({
    projectPath,
    override: manual,
    source: "paseo",
  });
  assert.ok(settings.ok, !settings.ok ? settings.error : undefined);
  assert.equal(settings.value.source, "paseo");
  assert.deepEqual(settings.value.override, manual);

  async function create(branch: string) {
    const result = await owner.host.workspaceOps.createWorkspace({
      projectPath,
      branch,
      mode: "new",
      baseRef: "main",
      name: branch,
    });
    assert.ok(result.ok, !result.ok ? result.error : undefined);
    let job = result.value;
    const deadline = Date.now() + 15_000;
    while (job.status === "running" && Date.now() < deadline) {
      await delay(25);
      const status = await owner.host.workspaceOps.workspaceCreationStatus(
        job.id,
      );
      assert.ok(status.ok, !status.ok ? status.error : undefined);
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
  assert.equal(
    readFileSync(join(first, ".env"), "utf8"),
    "local configuration",
  );
  assert.equal(
    JSON.parse(readFileSync(join(first, "paseo.json"), "utf8")).worktree
      .setup[0],
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
  const refused =
    await owner.host.workspaceOps.removeRegisteredWorktree(deletion);
  assert.ok(!refused.ok);
  assert.match(refused.error, /teardown/i);
  assert.equal(existsSync(first), true);
  const retained = await owner.host.workspaceOps.hierarchy({ action: "list" });
  assert.ok(retained.ok, !retained.ok ? retained.error : undefined);
  assert.ok(
    retained.value.projects[0].workspaces.some(
      (workspace) => workspace.path === first,
    ),
  );

  recipe(
    [],
    [
      'test "$PASEO_PROJECT_PATH" = "$OMP_PROJECT_PATH" && test "$PASEO_PROJECT_PATH" = "$PASEO_SOURCE_CHECKOUT_PATH"',
      'test "$PASEO_WORKSPACE_PATH" = "$OMP_WORKSPACE_PATH" && test "$PASEO_WORKSPACE_PATH" = "$PASEO_WORKTREE_PATH" && test "$PASEO_WORKSPACE_PATH" = "$PWD"',
      'test "$PASEO_BRANCH" = "$OMP_BRANCH" && test "$PASEO_BRANCH" = "$PASEO_BRANCH_NAME" && test "$PASEO_BRANCH" = "live-first"',
      'printf "%s" "$PASEO_WORKTREE_PATH" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown.txt"',
    ],
  );
  const removed =
    await owner.host.workspaceOps.removeRegisteredWorktree(deletion);
  assert.ok(removed.ok, !removed.ok ? removed.error : undefined);
  assert.equal(removed.value.status, "deleted");
  assert.equal(existsSync(first), false);
  assert.equal(readFileSync(join(projectPath, "teardown.txt"), "utf8"), first);

  settings = await owner.host.workspaceOps.workspaceCreationSettings({
    projectPath,
    source: "manual",
  });
  assert.ok(settings.ok, !settings.ok ? settings.error : undefined);
  assert.deepEqual(settings.value.override, manual);
  const third = await create("manual-again");
  assert.equal(readFileSync(join(third, "manual.txt"), "utf8"), "manual");
  assert.equal(existsSync(join(third, "setup.txt")), false);
});

test("Paseo runs use the owning checkout's live recipe and the workspace's branch and services", async (t) => {
  const fixture = await workspaceHarness();
  t.after(() => fixture.close());
  const owner = await fixture.startHost();
  const ops = owner.host.workspaceOps;
  const projectPath = owner.project;
  const first = join(owner.home, "first");
  const second = join(owner.home, "second");
  const recipePath = join(projectPath, "paseo.json");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", projectPath, ...args]);
  git("init", "-b", "main");
  git("config", "user.name", "Workspace test");
  git("config", "user.email", "workspace@example.invalid");
  writeFileSync(
    recipePath,
    JSON.stringify({ scripts: { check: { command: "exit 99" } } }),
  );
  git("add", "paseo.json");
  git("commit", "-qm", "project");
  git("worktree", "add", "-qb", "first", first);
  git("worktree", "add", "-qb", "second", second);

  const registered = await ops.hierarchy({
    action: "registerProject",
    path: projectPath,
  });
  assert.ok(registered.ok, !registered.ok ? registered.error : undefined);
  const imported = await ops.hierarchy({
    action: "importWorkspaces",
    projectId: registered.value.projects[0].id,
    paths: [first, second],
  });
  assert.ok(imported.ok, !imported.ok ? imported.error : undefined);
  const source = async (source: "manual" | "paseo") => {
    const result = await ops.workspaceCreationSettings({ projectPath, source });
    assert.ok(result.ok, !result.ok ? result.error : undefined);
  };
  const list = async (cwd: string) => {
    const result = await ops.workspaceScripts({ action: "list", cwd });
    assert.ok(result.ok, !result.ok ? result.error : undefined);
    assert.ok("entries" in result.value);
    return result.value;
  };
  const launch = async (cwd: string, name: string) => {
    const result = await ops.workspaceScripts({ action: "launch", cwd, name });
    assert.ok(result.ok, !result.ok ? result.error : undefined);
    assert.ok("terminal" in result.value);
    return result.value.terminal;
  };
  const run = async (cwd: string, name: string) => {
    const row = (await list(cwd)).entries.find((entry) => entry.name === name);
    assert.ok(row?.run, `Missing retained run: ${name}`);
    return row.run;
  };
  const stop = (cwd: string, terminalId: string) =>
    ops.workspaceScripts({ action: "stop", cwd, terminalId });

  assert.deepEqual(await list(first), {
    enabled: false,
    error: null,
    entries: [],
  });
  assert.match(
    JSON.stringify(
      await ops.workspaceScripts({
        action: "launch",
        cwd: first,
        name: "check",
      }),
    ),
    /paseo_scripts_disabled/,
  );
  await source("paseo");
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  t.after(() => listener.stop(true));
  const check = {
    command: "printf 'live:%s\\n' \"$PASEO_BRANCH_NAME\"\nexit 7",
  };
  const daemon = {
    type: "service",
    command: "printf '%s\\n' \"$PASEO_PORT\"; exec sleep 60",
  };
  const app = {
    type: "service",
    command: "printf '%s\\n' \"$PASEO_SERVICE_DAEMON_PORT\"; exec sleep 60",
  };
  writeFileSync(
    recipePath,
    JSON.stringify({
      scripts: {
        check,
        daemon,
        app,
        occupied: { ...daemon, port: listener.port },
        invalid: { ...daemon, port: 0 },
      },
    }),
  );

  const checked = await launch(first, "check");
  assert.equal(checked.title, "check");
  const idleCheck = await launch(second, "check");
  const output = async (terminalId: string, pattern: RegExp) => {
    const deadline = Date.now() + 4000;
    for (;;) {
      const result = await ops.terminals("snapshot", { id: terminalId });
      assert.ok(result.ok, !result.ok ? result.error : undefined);
      const snapshot = result.value.snapshot ?? "";
      if (pattern.test(snapshot)) return;
      assert.ok(
        Date.now() < deadline,
        `Output did not contain ${pattern}: ${snapshot}`,
      );
      await delay(20);
    }
  };
  await output(checked.id, /live:first/);
  const waitForExit = async (cwd: string) => {
    const deadline = Date.now() + 4000;
    let current = await run(cwd, "check");
    while (current.status === "running" && Date.now() < deadline) {
      await delay(20);
      current = await run(cwd, "check");
    }
    assert.equal(current.status, "exited");
    return current;
  };
  assert.deepEqual(await waitForExit(first), {
    terminalId: checked.id,
    status: "exited",
    exitCode: 7,
    port: null,
    signal: null,
  });
  assert.equal((await waitForExit(second)).exitCode, 7);
  assert.ok(
    (await list(first)).entries.find(({ name }) => name === "invalid")?.error,
  );

  const daemon1 = await launch(first, "daemon");
  const daemon2 = await launch(second, "daemon");
  const firstPort = (await run(first, "daemon")).port;
  const secondPort = (await run(second, "daemon")).port;
  assert.ok(firstPort && secondPort && firstPort !== secondPort);
  await output(daemon1.id, new RegExp(`^${firstPort}\\b`));
  await output(daemon2.id, new RegExp(`^${secondPort}\\b`));
  const refuses = async (
    cwd: string,
    name: string,
    code: string,
    status: number,
  ) => {
    const result = await ops.workspaceScripts({ action: "launch", cwd, name });
    assert.ok(!result.ok);
    assert.equal(result.code, code);
    assert.equal(result.status, status);
  };
  await refuses(first, "daemon", "paseo_script_running", 409);
  await refuses(first, "occupied", "paseo_port_unavailable", 409);
  await refuses(first, "invalid", "paseo_invalid_script", 400);
  const appRun = await launch(first, "app");
  await output(appRun.id, new RegExp(`^${firstPort}\\b`));

  // A live claim blocks a fixed port even when the service hasn't bound it.
  writeFileSync(
    recipePath,
    JSON.stringify({ scripts: { app, fixed: { ...daemon, port: firstPort } } }),
  );
  await refuses(second, "fixed", "paseo_port_unavailable", 409);
  assert.equal(
    (await list(first)).entries.find(({ name }) => name === "daemon")
      ?.configured,
    false,
  );
  writeFileSync(recipePath, '{"scripts":[] }');
  assert.ok((await list(first)).error);
  assert.equal((await run(first, "daemon")).terminalId, daemon1.id);
  await refuses(first, "check", "paseo_invalid_script", 400);
  await source("manual");
  const disabled = await list(first);
  assert.equal(disabled.enabled, false);
  assert.equal(
    disabled.entries.find(({ name }) => name === "daemon")?.run?.terminalId,
    daemon1.id,
  );
  assert.deepEqual(await stop(first, daemon2.id), {
    ok: false,
    status: 404,
    code: "terminal_not_found",
    error: "Terminal not found",
  });
  assert.deepEqual(await stop(first, daemon1.id), {
    ok: true,
    value: { stopped: true },
  });
  assert.deepEqual(await stop(first, daemon1.id), {
    ok: true,
    value: { stopped: true },
  });
  assert.equal((await run(first, "daemon")).status, "stopped");
  assert.equal((await run(first, "daemon")).port, null);
  await output(daemon1.id, new RegExp(`^${firstPort}\\b`));

  const deletion = { projectPath, path: first, discardChanges: false };
  const removal = await ops.removeRegisteredWorktree({
    ...deletion,
    stopProcesses: false,
  });
  assert.ok(removal.ok && removal.value.status === "processes");
  assert.deepEqual(removal.value.processes, [{ id: appRun.id, cwd: first }]);
  writeFileSync(join(first, "dirty.txt"), "dirty");
  const awaitingDiscard = await ops.removeRegisteredWorktree({
    ...deletion,
    stopProcesses: true,
  });
  assert.deepEqual(awaitingDiscard, { ok: true, value: { status: "dirty" } });
  const cancelled = await ops.removeRegisteredWorktree({
    ...deletion,
    stopProcesses: false,
    cancel: true,
  });
  assert.deepEqual(cancelled, { ok: true, value: { status: "cancelled" } });
  assert.equal((await run(first, "app")).status, "stopped");
  await output(appRun.id, new RegExp(`^${firstPort}\\b`));
  const accepted = await ops.removeRegisteredWorktree({
    ...deletion,
    stopProcesses: true,
    discardChanges: true,
    keepBranch: true,
  });
  assert.ok(accepted.ok && accepted.value.status === "deleted");
  assert.deepEqual(await ops.terminals("snapshot", { id: appRun.id }), {
    ok: false,
    status: 404,
    code: "terminal_not_found",
    error: "Terminal not found",
  });

  assert.deepEqual(await stop(second, daemon2.id), {
    ok: true,
    value: { stopped: true },
  });
  assert.equal((await run(second, "daemon")).status, "stopped");
  await output(idleCheck.id, /live:second/);
  await output(daemon2.id, new RegExp(`^${secondPort}\\b`));

  // No live processes: deletion must reclaim both retained terminal slots
  // without requiring the stop confirmation path.
  const idleRemoval = await ops.removeRegisteredWorktree({
    projectPath,
    path: second,
    discardChanges: false,
    stopProcesses: false,
    keepBranch: true,
  });
  assert.deepEqual(idleRemoval, { ok: true, value: { status: "deleted" } });
  for (const terminalId of [idleCheck.id, daemon2.id]) {
    assert.deepEqual(await ops.terminals("snapshot", { id: terminalId }), {
      ok: false,
      status: 404,
      code: "terminal_not_found",
      error: "Terminal not found",
    });
  }
});
