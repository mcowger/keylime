import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { registerEffortRoot } from "./project-hierarchy";
import { TerminalManager } from "./terminals";

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
        "exit 7",
      ].join("\n"),
      env: {
        KEYLIME_EFFORT_ROOT: cwd,
        KEYLIME_SERVICE_ID: "fixture",
        KEYLIME_STT_KEY: "fixture-env-secret",
      },
    });
    const deadline = Date.now() + 3000;
    let snapshot = (await manager.snapshot(terminal.id)).snapshot;
    while (
      (manager.isRunning(terminal.id) ||
        !snapshot.includes("service:fixture")) &&
      Date.now() < deadline
    ) {
      await setImmediate();
      snapshot = (await manager.snapshot(terminal.id)).snapshot;
    }
    assert.equal(manager.isRunning(terminal.id), false);
    assert.match(snapshot, /service:fixture/);
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
