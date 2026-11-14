import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceHarness } from "./workspace-test-helper.mjs";

test(
  "linked host owns isolated PTYs and retains screen through link reconnect",
  { timeout: 60000 },
  async (t) => {
    const f = await workspaceHarness();
    t.after(() => f.close());
    const owner = await f.startHost();
    const other = await f.startHost();
    assert.equal(
      (
        await owner.host.workspaceOps.hierarchy({
          action: "registerProject",
          path: owner.project,
        })
      ).ok,
      true,
    );
    const op = (action, input) =>
      owner.host.workspaceOps.terminals(action, input);
    const first = await op("create", {
      cwd: owner.project,
      cols: 80,
      rows: 24,
    });
    const second = await op("create", {
      cwd: owner.project,
      cols: 80,
      rows: 24,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const id = first.value.terminal.id;
    assert.notEqual(id, second.value.terminal.id);
    await op("input", {
      id,
      data: 'printf \'PTY_ID=%s CWD=%s\\n\' "$$" "$PWD"\n',
    });
    let snapshot;
    const deadline = Date.now() + 10000;
    do {
      await delay(50);
      snapshot = await op("snapshot", { id });
    } while (
      snapshot.ok &&
      !/PTY_ID=\d+ CWD=/.test(snapshot.value.snapshot) &&
      Date.now() < deadline
    );
    assert.equal(snapshot.ok, true);
    const match = /PTY_ID=(\d+) CWD=([^\r\n]+)/.exec(snapshot.value.snapshot);
    assert.ok(match);
    assert.ok(snapshot.value.snapshot.includes(owner.project));
    assert.equal(
      (await other.host.workspaceOps.terminals("snapshot", { id })).ok,
      false,
    );
    const oldSockets = new Set(f.sockets);
    for (const socket of oldSockets) socket.close(1012, "server restarting");
    const reconnectDeadline = Date.now() + 15000;
    while (
      ([...oldSockets].some((socket) => f.sockets.has(socket)) ||
        f.sockets.size < 2) &&
      Date.now() < reconnectDeadline
    )
      await delay(20);
    assert.ok(
      [...oldSockets].every((socket) => !f.sockets.has(socket)),
      "old sockets remained connected",
    );
    assert.equal(f.sockets.size, 2, "hosts did not reconnect");
    const restored = await op("snapshot", { id });
    await op("input", {
      id,
      data: "sleep 300 & printf 'CHILD_PID=%s\\n' $! \n",
    });
    let child;
    const childDeadline = Date.now() + 10000;
    do {
      await delay(50);
      const current = await op("snapshot", { id });
      child = current.ok && /CHILD_PID=(\d+)/.exec(current.value.snapshot)?.[1];
    } while (!child && Date.now() < childDeadline);
    assert.ok(child, JSON.stringify((await op("snapshot", { id })).value));
    await op("input", {
      id: second.value.terminal.id,
      data: "i=0; while [ $i -lt 5000 ]; do printf 'burst-%s\\n' \"$i\"; i=$((i+1)); done; printf 'BURST_DONE\\n'\n",
    });
    let burst;
    const burstDeadline = Date.now() + 15000;
    do {
      await delay(50);
      burst = await op("snapshot", { id: second.value.terminal.id });
    } while (
      burst.ok &&
      !burst.value.snapshot.includes("BURST_DONE") &&
      Date.now() < burstDeadline
    );
    assert.equal(burst.ok, true);
    assert.ok(burst.value.snapshot.includes("BURST_DONE"));
    assert.equal(restored.ok, true);
    assert.ok(restored.value.snapshot.includes(`PTY_ID=${match[1]}`));
    await op("close", { id });
    assert.throws(() => process.kill(Number(child), 0), { code: "ESRCH" });
    assert.equal((await op("snapshot", { id })).ok, false);
    assert.equal(
      (await op("snapshot", { id: second.value.terminal.id })).ok,
      true,
    );
    await op("close", { id: second.value.terminal.id });
  },
);
