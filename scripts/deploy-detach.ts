import { closeSync, openSync } from "node:fs";

/** Own POSIX session and file-backed stdio; caller/host process-group teardown cannot reach this worker. */
export function detachDeployWorker(
  command: string[],
  logPath: string,
  cwd: string,
): Bun.Subprocess {
  const log = openSync(logPath, "a", 0o600);
  try {
    const child = Bun.spawn(command, {
      cwd,
      env: { ...process.env },
      detached: true,
      stdin: "ignore",
      stdout: log,
      stderr: log,
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}
