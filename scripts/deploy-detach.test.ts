import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireDeployLock } from "../lib/deploy-lock";
import { saveDeployState, readDeployState } from "./deploy-state";

test("deployment worker survives termination of its submitting process group", async () => {
  // Real subprocess/session survival requires the OS scheduler; fake timers cannot drive another process.
  const dir = mkdtempSync(path.join(tmpdir(), "keylime-detach-"));
  const marker = path.join(dir, "completed");
  const ready = path.join(dir, "ready");
  const module = path.join(import.meta.dir, "deploy-detach.ts");
  const worker = `await Bun.write(${JSON.stringify(ready)}, String(process.pid)); await Bun.sleep(250); await Bun.write(${JSON.stringify(marker)}, "complete");`;
  const launcher = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { detachDeployWorker } from ${JSON.stringify(module)}; detachDeployWorker([process.execPath,"--eval",${JSON.stringify(worker)}], ${JSON.stringify(path.join(dir, "log"))}, ${JSON.stringify(dir)}); await Bun.sleep(10000);`,
    ],
    { detached: true, stdout: "ignore", stderr: "inherit" },
  );
  let killed = false;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("worker not ready");
      await Bun.sleep(10);
    }
    process.kill(-launcher.pid, "SIGKILL");
    killed = true;
    await launcher.exited;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error("worker died with caller");
      await Bun.sleep(10);
    }
    expect(readFileSync(marker, "utf8")).toBe("complete");
  } finally {
    if (!killed) process.kill(-launcher.pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deployment lock excludes concurrent workers and journal retains its phase", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keylime-lock-"));
  const release = acquireDeployLock(dir);
  try {
    expect(() => acquireDeployLock(dir)).toThrow();
    saveDeployState(dir, {
      id: "test",
      pid: process.pid,
      phase: "stop-host",
      updatedAt: new Date().toISOString(),
    });
    expect(readDeployState(dir)?.phase).toBe("stop-host");
  } finally {
    release();
  }
  const again = acquireDeployLock(dir);
  again();
  rmSync(dir, { recursive: true, force: true });
});
