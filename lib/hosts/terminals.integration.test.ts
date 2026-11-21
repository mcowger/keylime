import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { workspaceHarness } from "./workspace-test-helper.ts";

function shCommand(script: string): string {
  return `/bin/sh -c '${script.replaceAll("'", "'\\''")}'\n`;
}

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
    const op = (action: string, input: Record<string, unknown>) =>
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
    assert.ok(first.ok && second.ok);
    assert.ok(first.value.terminal);
    assert.ok(second.value.terminal);
    const id = first.value.terminal.id;
    assert.notEqual(id, second.value.terminal.id);
    await op("input", {
      id: second.value.terminal.id,
      data: shCommand(
        "stty raw -echo; printf '\\033[c'; reply=$(dd bs=1 count=7 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty sane; printf 'DEVICE_REPLY:%s\\n' \"$reply\"",
      ),
    });
    const deviceDeadline = Date.now() + 5000;
    let deviceSnapshot;
    do {
      await delay(50);
      deviceSnapshot = await op("snapshot", { id: second.value.terminal.id });
    } while (
      deviceSnapshot.ok &&
      !deviceSnapshot.value.snapshot?.includes("DEVICE_REPLY:1b5b3f313b3263") &&
      Date.now() < deviceDeadline
    );
    assert.ok(
      deviceSnapshot.ok &&
        deviceSnapshot.value.snapshot?.includes("DEVICE_REPLY:1b5b3f313b3263"),
    );
    await op("input", {
      id,
      data: shCommand('printf \'PTY_ID=%s CWD=%s\\n\' "$$" "$PWD"'),
    });
    let snapshot;
    const deadline = Date.now() + 10000;
    do {
      await delay(50);
      snapshot = await op("snapshot", { id });
    } while (
      snapshot.ok &&
      !/PTY_ID=\d+ CWD=/.test(snapshot.value.snapshot ?? "") &&
      Date.now() < deadline
    );
    assert.equal(snapshot.ok, true);
    assert.ok(snapshot.ok);
    assert.ok(snapshot.value.snapshot);
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
      data: shCommand("sleep 300 & printf 'CHILD_PID=%s\\n' $!"),
    });
    let child;
    const childDeadline = Date.now() + 10000;
    do {
      await delay(50);
      const current = await op("snapshot", { id });
      child =
        current.ok && /CHILD_PID=(\d+)/.exec(current.value.snapshot ?? "")?.[1];
    } while (!child && Date.now() < childDeadline);
    assert.ok(child, JSON.stringify(await op("snapshot", { id })));
    await op("input", {
      id: second.value.terminal.id,
      data: shCommand(
        "i=0; while [ $i -lt 5000 ]; do printf 'burst-%s\\n' \"$i\"; i=$((i+1)); done; printf 'BURST_DONE\\n'",
      ),
    });
    let burst;
    const burstDeadline = Date.now() + 15000;
    do {
      await delay(50);
      burst = await op("snapshot", { id: second.value.terminal.id });
    } while (
      burst.ok &&
      !burst.value.snapshot?.includes("BURST_DONE") &&
      Date.now() < burstDeadline
    );
    assert.equal(burst.ok, true);
    assert.ok(burst.ok);
    assert.ok(burst.value.snapshot?.includes("BURST_DONE"));
    assert.equal(restored.ok, true);
    assert.ok(restored.ok);
    assert.ok(restored.value.snapshot?.includes(`PTY_ID=${match[1]}`));
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

test(
  "daemon answers color and character size queries without a viewer",
  { timeout: 30000 },
  async (t) => {
    const f = await workspaceHarness();
    t.after(() => f.close());
    const owner = await f.startHost();
    assert.equal(
      (
        await owner.host.workspaceOps.hierarchy({
          action: "registerProject",
          path: owner.project,
        })
      ).ok,
      true,
    );
    const op = (action: string, input: Record<string, unknown>) =>
      owner.host.workspaceOps.terminals(action, input);
    const created = await op("create", {
      cwd: owner.project,
      cols: 80,
      rows: 24,
    });
    assert.equal(created.ok, true);
    assert.ok(created.ok);
    assert.ok(created.value.terminal);
    const id = created.value.terminal.id;
    assert.equal((await op("resize", { id, cols: 500, rows: 37 })).ok, true);
    const script = `
process.stdin.setRawMode(true);
let data = Buffer.alloc(0);
process.stdin.on('data', chunk => { data = Buffer.concat([data, chunk]); });
for (const part of ['\\x1b]4;1;rgb:f/0/0;1;?', ';16;?\\x07\\x1b]10;#123456;?;?\\x1b', '\\\\\\x1b]10;?\\x07\\x1b]11;rgb:0/f/0\\x07\\x1b]11;?\\x07\\x1b]111\\x07\\x1b]11;?\\x07\\x1b]104;1\\x07\\x1b]4;1;?\\x07\\x1b]110\\x07\\x1b]10;?\\x07\\x1b[18t']) {
  process.stdout.write(part);
  await Bun.sleep(30);
}
await Bun.sleep(500);
process.stdin.setRawMode(false);
console.log('QUERY_' + 'RESULT:' + data.toString('base64'));
process.exit(0);
`;
    await op("input", {
      id,
      data: `"${process.execPath}" -e "eval('(async()=>{'+atob('${Buffer.from(script).toString("base64")}')+'})()')"\n`,
    });
    let snapshot;
    const deadline = Date.now() + 10000;
    let match;
    do {
      await delay(50);
      snapshot = await op("snapshot", { id });
      match =
        snapshot.ok &&
        /QUERY_RESULT:([A-Za-z0-9+/=]+)/.exec(snapshot.value.snapshot ?? "");
    } while (!match && Date.now() < deadline);
    assert.ok(
      match,
      snapshot.ok ? snapshot.value.snapshot : JSON.stringify(snapshot),
    );
    const reply = Buffer.from(match[1], "base64").toString();
    assert.equal(
      reply,
      [
        "\x1b]4;1;rgb:ffff/0000/0000\x1b\\",
        "\x1b]4;16;rgb:0000/0000/0000\x1b\\",
        "\x1b]11;rgb:0000/0000/0000\x1b\\",
        "\x1b]12;rgb:ffff/ffff/ffff\x1b\\",
        "\x1b]10;rgb:1212/3434/5656\x1b\\",
        "\x1b]11;rgb:0000/ffff/0000\x1b\\",
        "\x1b]11;rgb:0000/0000/0000\x1b\\",
        "\x1b]4;1;rgb:cccc/0000/0000\x1b\\",
        "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
        "\x1b[8;37;500t",
      ].join(""),
    );
    await op("close", { id });
  },
);

test(
  "daemon aggregates viewer focus and reports focus enabled after attachment",
  { timeout: 30000 },
  async (t) => {
    const f = await workspaceHarness();
    t.after(() => f.close());
    const owner = await f.startHost();
    assert.equal(
      (
        await owner.host.workspaceOps.hierarchy({
          action: "registerProject",
          path: owner.project,
        })
      ).ok,
      true,
    );
    const op = (action: string, input: Record<string, unknown>) =>
      owner.host.workspaceOps.terminals(action, input);
    const created = await op("create", {
      cwd: owner.project,
      cols: 120,
      rows: 24,
    });
    assert.equal(created.ok, true);
    assert.ok(created.ok);
    assert.ok(created.value.terminal);
    const id = created.value.terminal.id;
    assert.equal(
      (await op("focus", { id, viewer: "one", focused: true })).ok,
      true,
    );
    const script = `
process.stdin.setRawMode(true);
let data = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  data = Buffer.concat([data, chunk]);
  if (data.includes('\\x1b[O')) finish();
});
function finish() {
  process.stdin.setRawMode(false);
  console.log('FOCUS_' + 'RESULT:' + data.toString('hex'));
  process.exit(0);
}
process.stdout.write('\\x1b[?1004hFOCUS_' + 'READY');
setTimeout(finish, 8000);
`;
    await op("input", {
      id,
      data: `"${process.execPath}" -e "eval(atob('${Buffer.from(script).toString("base64")}'))"\n`,
    });
    let snapshot;
    let deadline = Date.now() + 5000;
    do {
      await delay(50);
      snapshot = await op("snapshot", { id });
    } while (
      snapshot.ok &&
      !snapshot.value.snapshot?.includes("FOCUS_READY") &&
      Date.now() < deadline
    );
    assert.ok(snapshot.ok && snapshot.value.snapshot?.includes("FOCUS_READY"));
    assert.equal(
      (await op("focus", { id, viewer: "two", focused: true })).ok,
      true,
    );
    assert.equal(
      (await op("focus", { id, viewer: "one", focused: false })).ok,
      true,
    );
    assert.equal(
      (await op("focus", { id, viewer: "two", focused: false })).ok,
      true,
    );
    deadline = Date.now() + 10000;
    let match;
    do {
      await delay(50);
      snapshot = await op("snapshot", { id });
      match =
        snapshot.ok &&
        /FOCUS_RESULT:([0-9a-f]+)/.exec(snapshot.value.snapshot ?? "");
    } while (!match && Date.now() < deadline);
    assert.ok(
      match,
      snapshot.ok ? snapshot.value.snapshot : JSON.stringify(snapshot),
    );
    assert.equal(Buffer.from(match[1], "hex").toString(), "\x1b[I\x1b[O");
    await op("close", { id });
  },
);
