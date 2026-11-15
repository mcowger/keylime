import { closeSync, openSync, readSync } from "node:fs";
import { readDeployState, type DeployState } from "./deploy-state";

/** Observe the detached worker without owning its lifetime; drain its log after exit. */
export async function followDeployment(
  base: string,
  id: string,
  logPath: string,
  child: Bun.Subprocess,
  write: (bytes: Uint8Array) => void | Promise<void> = (bytes) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
    return promise;
  },
): Promise<DeployState> {
  const fd = openSync(logPath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  let terminal: DeployState | undefined;
  const drain = async () => {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) return;
      await write(buffer.subarray(0, count));
      offset += count;
    }
  };
  try {
    for (;;) {
      await drain();
      const state = readDeployState(base);
      if (
        state?.id === id &&
        ["complete", "failed", "recovered"].includes(state.phase)
      )
        terminal = state;
      if (child.exitCode !== null) {
        await drain();
        if (!terminal)
          throw new Error(
            `Deployment worker exited without a terminal status; inspect ${logPath} and --status`,
          );
        return terminal;
      }
      await Bun.sleep(100);
    }
  } finally {
    closeSync(fd);
  }
}
