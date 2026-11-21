import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { registerEffortRoot } from "./project-hierarchy";
import { TerminalManager } from "./terminals";

test("workspace terminals use the account shell and preserve an isolated HOME", async () => {
  const account = { shell: "/bin/sh", home: "/" };
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "keylime-shell-")));
  const cwd = join(sandbox, "workspace");
  const original = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    shell: process.env.SHELL,
    home: process.env.HOME,
    password: process.env.KEYLIME_PASSWORD_HASH,
  };
  process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
  process.env.SHELL = "/bin/false";
  process.env.HOME = sandbox;
  process.env.KEYLIME_PASSWORD_HASH = "fixture-host-secret";
  const manager = new TerminalManager(
    () => {},
    () => false,
    () => account,
  );
  try {
    mkdirSync(cwd);
    registerEffortRoot(cwd, "Shell fixture");
    const terminal = manager.create(cwd, 500, 24);
    const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const probe =
      'process.stdout.write("SHELLCHECK:" + Buffer.from(JSON.stringify({ parent: process.ppid, shell: process.env.SHELL, home: process.env.HOME, secret: process.env.KEYLIME_PASSWORD_HASH })).toString("base64") + "\\n")';
    manager.input(terminal.id, `${executable} -e '${probe}'; true\n`);
    const deadline = Date.now() + 10000;
    let snapshot = "";
    let match: RegExpExecArray | null = null;
    while (!match && Date.now() < deadline) {
      await setImmediate();
      snapshot = (await manager.snapshot(terminal.id)).snapshot;
      match = /SHELLCHECK:([A-Za-z0-9+/]+=*)/.exec(snapshot);
    }
    assert.ok(match, snapshot);
    const result = JSON.parse(Buffer.from(match[1], "base64").toString()) as {
      parent: number;
      shell: string;
      home: string;
      secret?: string;
    };
    assert.equal(result.shell, account.shell);
    assert.equal(result.home, sandbox);
    assert.equal(result.secret, undefined);
    const command = execFileSync(
      "ps",
      ["-p", String(result.parent), "-o", "comm="],
      {
        encoding: "utf8",
      },
    ).trim();
    const expectedName = basename(account.shell).replace(/^-/, "");
    const actualName = basename(command).replace(/^-/, "");
    assert.equal(
      actualName,
      process.platform === "linux" ? expectedName.slice(0, 15) : expectedName,
    );
    delete process.env.HOME;
    const withoutHome = manager.create(cwd, 500, 24);
    manager.input(withoutHome.id, 'printf "ACCOUNT_HOME:%s\\n" "$HOME"\n');
    const homeDeadline = Date.now() + 10000;
    let homeSnapshot = "";
    while (
      !homeSnapshot.includes("ACCOUNT_HOME:/") &&
      Date.now() < homeDeadline
    ) {
      await setImmediate();
      homeSnapshot = (await manager.snapshot(withoutHome.id)).snapshot;
    }
    assert.ok(homeSnapshot.includes("ACCOUNT_HOME:/"), homeSnapshot);
  } finally {
    await manager.stop();
    for (const [name, value] of Object.entries({
      PI_CODING_AGENT_DIR: original.agentDir,
      SHELL: original.shell,
      HOME: original.home,
      KEYLIME_PASSWORD_HASH: original.password,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("workspace terminals prefer the OS login shell over the service environment", async (t) => {
  let shell: string | undefined;
  try {
    if (process.platform === "linux") {
      const uid = process.geteuid?.();
      if (uid !== undefined) {
        shell = execFileSync("/usr/bin/getent", ["passwd", String(uid)], {
          encoding: "utf8",
        })
          .trim()
          .split(":")[6];
      }
    } else if (process.platform === "darwin") {
      const options = { encoding: "utf8" as const };
      const name = execFileSync("/usr/bin/id", ["-un"], options).trim();
      const record = execFileSync(
        "/usr/bin/dscl",
        ["/Search", "-read", `/Users/${name}`, "UserShell"],
        options,
      );
      shell = /^UserShell: (.+)$/m.exec(record)?.[1];
    }
  } catch {
    // The host need not have an account database command.
  }
  if (!shell || /\/(?:false|nologin)$/.test(shell)) {
    t.skip("the current account has no discoverable interactive shell");
    return;
  }
  const sandbox = realpathSync(
    mkdtempSync(join(tmpdir(), "keylime-native-shell-")),
  );
  const cwd = join(sandbox, "workspace");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const previousShell = process.env.SHELL;
  const home = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
  process.env.HOME = sandbox;
  const manager = new TerminalManager(() => {});
  try {
    mkdirSync(cwd);
    registerEffortRoot(cwd, "Native shell fixture");
    for (const serviceShell of [
      undefined,
      "unknown",
      shell === "/bin/sh" ? "/bin/false" : "/bin/sh",
    ]) {
      if (serviceShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = serviceShell;
      const terminal = manager.create(cwd, 500, 24);
      const fish = basename(shell) === "fish";
      manager.input(
        terminal.id,
        fish
          ? 'status is-login; and status is-interactive; and printf "LOGIN_INTERACTIVE:%s\\n" "$SHELL"\n'
          : 'printf "ACTUAL_SHELL:%s\\n" "$SHELL"\n',
      );
      const expected = `${fish ? "LOGIN_INTERACTIVE" : "ACTUAL_SHELL"}:${shell}`;
      const deadline = Date.now() + 10000;
      let snapshot = "";
      while (!snapshot.includes(expected) && Date.now() < deadline) {
        await setImmediate();
        snapshot = (await manager.snapshot(terminal.id)).snapshot;
      }
      assert.ok(snapshot.includes(expected), snapshot);
    }
  } finally {
    await manager.stop();
    if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentDir;
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a short-lived service retains its PTY output without passing Keylime secrets", async () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "keylime-service-")));
  const cwd = join(sandbox, "effort");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const password = process.env.KEYLIME_PASSWORD_HASH;
  process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
  process.env.KEYLIME_PASSWORD_HASH = "fixture-host-secret";
  const manager = new TerminalManager(() => {});
  try {
    mkdirSync(cwd);
    registerEffortRoot(cwd, "Service fixture");
    const terminal = await manager.startService({
      cwd,
      command: [
        'if [ "${KEYLIME_PASSWORD_HASH+x}${KEYLIME_STT_KEY+x}" ]; then printf "unexpected-secret\\n"; fi',
        'if [ -t 0 ] && [ "$(pwd -P)" = "$KEYLIME_EFFORT_ROOT" ]; then printf "service:%s\\n" "$KEYLIME_SERVICE_ID"; fi',
        'if [ "$0" = /bin/sh ] && [ "$SHELL" = /bin/false ] && [ "$HOME" = "$KEYLIME_EFFORT_ROOT" ]; then printf "service-shell:ok\\n"; fi',
        "exit 7",
      ].join("\n"),
      env: {
        KEYLIME_EFFORT_ROOT: cwd,
        KEYLIME_SERVICE_ID: "fixture",
        KEYLIME_STT_KEY: "fixture-env-secret",
        SHELL: "/bin/false",
        HOME: cwd,
      },
    });
    const deadline = Date.now() + 3000;
    let snapshot = (await manager.snapshot(terminal.id)).snapshot;
    while (
      (manager.isRunning(terminal.id) ||
        !snapshot.includes("service:fixture") ||
        !snapshot.includes("service-shell:ok")) &&
      Date.now() < deadline
    ) {
      await setImmediate();
      snapshot = (await manager.snapshot(terminal.id)).snapshot;
    }
    assert.equal(manager.isRunning(terminal.id), false);
    assert.match(snapshot, /service:fixture/);
    assert.match(snapshot, /service-shell:ok/);
    assert.doesNotMatch(snapshot, /unexpected-secret/);
    assert.deepEqual(manager.list(cwd), [terminal]);
    assert.deepEqual(manager.inspect(cwd), []);
    await manager.close(terminal.id);
    assert.equal(manager.has(terminal.id), false);
    await assert.rejects(manager.snapshot(terminal.id), {
      code: "terminal_not_found",
    });
  } finally {
    await manager.stop();
    if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = agentDir;
    if (password === undefined) delete process.env.KEYLIME_PASSWORD_HASH;
    else process.env.KEYLIME_PASSWORD_HASH = password;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
