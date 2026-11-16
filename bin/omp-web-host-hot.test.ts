import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  hostControlPath,
  requestHostControl,
} from "../lib/hosts/host-control.ts";

test("Bun hot reload replaces the host daemon and SIGTERM removes its endpoint", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "omp-web-host-hot-"));
  const root = join(scratch, "source");
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const agentDir = join(scratch, "agent");
  const endpoint = hostControlPath(agentDir);
  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(
    join(sourceRoot, "bin/omp-web-host.ts"),
    join(root, "bin/omp-web-host.ts"),
  );
  cpSync(join(sourceRoot, "lib"), join(root, "lib"), { recursive: true });
  copyFileSync(join(sourceRoot, "package.json"), join(root, "package.json"));
  symlinkSync(
    join(sourceRoot, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  mkdirSync(join(agentDir, "omp-web"), { recursive: true });
  const runner = join(scratch, "fake-omp");
  writeFileSync(
    runner,
    `#!${process.execPath}\nconsole.log("18.0.0-fixture");\n`,
    { mode: 0o700 },
  );

  let hellos = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, bun) {
      return bun.upgrade(req)
        ? undefined
        : new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        for (const line of String(data).split("\n").filter(Boolean)) {
          const frame = JSON.parse(line);
          if (frame.type === "hello") {
            hellos++;
            ws.send(
              JSON.stringify({
                type: "welcome",
                v: frame.v,
                hostId: "hot-fixture",
              }),
            );
          } else if (typeof frame.seq === "number") {
            ws.send(JSON.stringify({ type: "ack", ack: frame.seq }));
          }
        }
      },
    },
  });
  writeFileSync(
    join(agentDir, "omp-web", "host.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${server.port}`,
      token: "hot-fixture-token",
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    ["--hot", join(root, "bin/omp-web-host.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: scratch,
        PI_CODING_AGENT_DIR: agentDir,
        XDG_CONFIG_HOME: join(scratch, "config"),
        XDG_DATA_HOME: join(scratch, "data"),
        XDG_STATE_HOME: join(scratch, "state"),
        XDG_CACHE_HOME: join(scratch, "cache"),
        OMP_WEB_PACKAGE_DIR: root,
        OMP_WEB_OMP_BIN: runner,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  let exited = false;
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  child.once("close", (code, signal) => {
    exited = true;
    resolveClosed({ code, signal });
  });
  t.after(async () => {
    if (!exited) {
      child.kill("SIGKILL");
      await Promise.race([closed, sleep(5000, null, { ref: false })]);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    server.stop(true);
    rmSync(dirname(endpoint), { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  async function ready(generation: number) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      assert.equal(
        exited,
        false,
        `host exited during generation ${generation}: ${log}`,
      );
      if (hellos >= generation) {
        const status = await requestHostControl("status", agentDir).catch(
          () => null,
        );
        // The old endpoint can disappear before the replacement acquires it.
        if (status?.linked) {
          assert.equal(status.pid, child.pid);
          return;
        }
      }
      await sleep(25);
    }
    assert.fail(
      `generation ${generation} did not become ready (hellos=${hellos}): ${log}`,
    );
  }

  await ready(1);
  const daemonSource = join(root, "lib/hosts/daemon.ts");
  for (let generation = 2; generation <= 3; generation++) {
    appendFileSync(daemonSource, `\n// private hot reload ${generation}\n`);
    await ready(generation);
    assert.equal((await requestHostControl("drain", agentDir)).drained, true);
    assert.equal((await requestHostControl("resume", agentDir)).drained, false);
  }
  child.kill("SIGTERM");
  const result = await Promise.race([
    closed,
    sleep(15_000, null, { ref: false }),
  ]);
  assert.ok(result, `host did not exit on SIGTERM: ${log}`);
  assert.deepEqual(result, { code: 0, signal: null }, log);
  assert.equal(existsSync(endpoint), false);
});
