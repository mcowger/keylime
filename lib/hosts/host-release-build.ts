import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDeployLock } from "../deploy-lock";
import { MAX_UPLOAD_BYTES } from "../upload-limits";
import { UploadError } from "../uploads";
import { hostReleaseTarget } from "./hub";

const BUILD_TIMEOUT_MS = 30 * 60_000;
// If a killed process group cannot be reaped, keep the lock until controller restart.
const retainedLocks = new Set<() => void>();

type Target = { platform: string; arch: string };
type BuildOptions = {
  target: (hostId: string) => Target;
  packageDir: () => string;
  environment: () => NodeJS.ProcessEnv;
};

class CleanupUnsafeError extends Error {}
function cancelled(signal: AbortSignal, timeout: AbortSignal): void {
  if (timeout.aborted)
    throw new UploadError(
      504,
      "release_build_timeout",
      "The release build timed out. Check build dependencies and try again.",
    );
  if (signal.aborted)
    throw new UploadError(
      499,
      "release_build_cancelled",
      "The release build was cancelled.",
    );
}

// A separate process group lets cancellation stop the entire build tree, including Bun's children.
async function run(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeout: AbortSignal,
  stage: string,
): Promise<void> {
  cancelled(signal, timeout);
  const combined = AbortSignal.any([signal, timeout]);
  let failed = false;
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
  });
  const kill = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
  };
  combined.addEventListener("abort", kill, { once: true });
  if (combined.aborted) kill();
  const { promise, resolve } = Promise.withResolvers<number | null>();
  child.once("error", () => {
    failed = true;
  });
  child.once("close", resolve);
  const status = await promise;
  combined.removeEventListener("abort", kill);
  if (combined.aborted || failed || status !== 0) {
    kill();
    // Retain the workspace if a process in the group has not exited.
    if (child.pid) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          throw new CleanupUnsafeError();
        }
        if (Date.now() >= deadline) throw new CleanupUnsafeError();
        await Bun.sleep(50);
      }
    }
  }
  cancelled(signal, timeout);
  if (failed || status !== 0)
    throw new UploadError(
      500,
      "release_build_failed",
      `Release build failed during ${stage}. Check that mise and build dependencies are available on the controller, then try again.`,
    );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function requireComplete(directory: string): Promise<void> {
  for (const name of ["keylime", "keylime-omp"]) {
    const file = await lstat(join(directory, name));
    if (
      !file.isFile() ||
      !(file.mode & 0o111) ||
      file.size === 0 ||
      file.size > MAX_UPLOAD_BYTES
    )
      throw new Error("Incomplete build output");
  }
}

/** Factory allows isolated tests to supply a target, package directory and subprocess environment. */
export function createHostReleaseBuilder(options: BuildOptions) {
  return async (hostId: string, signal: AbortSignal): Promise<void> => {
    const { platform, arch } = options.target(hostId);
    // The production target is validated by hostReleaseTarget; retain this boundary for all callers.
    if (
      !(platform === "linux" || platform === "darwin") ||
      !(arch === "x64" || arch === "arm64")
    )
      throw new UploadError(
        400,
        "release_build_target_invalid",
        "The host platform is not supported for release builds.",
      );
    const timeout = AbortSignal.timeout(BUILD_TIMEOUT_MS);
    cancelled(signal, timeout);
    let workspace: string | undefined;
    let staging: string | undefined;
    let unlock: (() => void) | undefined;
    let cleanupSafe = true;
    try {
      // Resolve the active release once so a concurrent deployment cannot change the source or output midway.
      const packageDir = await realpath(options.packageDir());
      const archive = join(packageDir, "keylime-source.tar");
      if (!(await exists(archive)) || !(await lstat(archive)).isFile())
        throw new UploadError(
          409,
          "release_source_unavailable",
          "This controller release has no committed source archive. Deploy a controller release with a source archive before building.",
        );
      const releaseDir = join(packageDir, "host-releases");
      await mkdir(releaseDir, { recursive: true });
      const name = `keylime-${platform}-${arch}`;
      const destination = join(releaseDir, name);
      try {
        unlock = acquireDeployLock(releaseDir);
      } catch {
        throw new UploadError(
          409,
          "release_build_busy",
          "Another release build is in progress. Try again when it finishes.",
        );
      }
      cancelled(signal, timeout);
      if (await exists(destination))
        throw new UploadError(
          409,
          "release_build_exists",
          "A release already exists for this platform and architecture; it will not be overwritten.",
        );
      workspace = await mkdtemp(join(tmpdir(), "keylime-release-build-"));
      const env = options.environment();
      await run(
        ["tar", "-xf", archive, "-C", workspace],
        workspace,
        env,
        signal,
        timeout,
        "source extraction",
      );
      await run(
        ["mise", "trust"],
        workspace,
        env,
        signal,
        timeout,
        "mise trust",
      );
      await run(
        ["mise", "install"],
        workspace,
        env,
        signal,
        timeout,
        "mise install",
      );
      const bun = ["mise", "exec", "--", "bun", "--no-env-file"];
      await run(
        [...bun, "install", "--frozen-lockfile"],
        workspace,
        { ...env, KEYLIME_SKIP_RUNNER_INSTALL: "1" },
        signal,
        timeout,
        "dependency installation",
      );
      const target = `bun-${platform}-${arch}${arch === "x64" ? "-baseline" : ""}`;
      await run(
        [
          ...bun,
          "scripts/build-release-binaries.ts",
          "--target",
          target,
          "--no-archive",
        ],
        workspace,
        env,
        signal,
        timeout,
        "binary compilation",
      );
      const output = join(workspace, "release", name);
      await requireComplete(output);
      cancelled(signal, timeout);
      staging = await mkdtemp(join(releaseDir, `.${name}-`));
      const stagedRelease = join(staging, name);
      await mkdir(stagedRelease);
      await run(
        ["cp", "-R", `${output}/.`, stagedRelease],
        workspace,
        env,
        signal,
        timeout,
        "release staging",
      );
      await requireComplete(stagedRelease);
      cancelled(signal, timeout);
      // Moving into the parent makes -n apply to the final name even if that directory appears concurrently.
      await run(
        ["mv", "-n", stagedRelease, releaseDir],
        workspace,
        env,
        signal,
        timeout,
        "release publication",
      );
      if (await exists(stagedRelease))
        throw new UploadError(
          409,
          "release_build_exists",
          "A release already exists for this platform and architecture; it will not be overwritten.",
        );
    } catch (error) {
      if (error instanceof CleanupUnsafeError) {
        cleanupSafe = false;
        throw new UploadError(
          500,
          "release_build_cleanup_pending",
          "A build process did not stop. Its temporary workspace was retained; stop the process before removing it.",
        );
      }
      if (error instanceof UploadError) throw error;
      cancelled(signal, timeout);
      throw new UploadError(
        500,
        "release_build_failed",
        "The release build could not be completed. Check controller storage and build dependencies, then try again.",
      );
    } finally {
      try {
        if (cleanupSafe && staging)
          await rm(staging, { recursive: true, force: true });
        if (cleanupSafe && workspace)
          await rm(workspace, { recursive: true, force: true });
      } catch {
        throw new UploadError(
          500,
          "release_build_cleanup_failed",
          "The release build workspace could not be removed. Check controller storage permissions.",
        );
      } finally {
        if (cleanupSafe) unlock?.();
        else if (unlock) retainedLocks.add(unlock);
      }
    }
  };
}

export const buildHostRelease = createHostReleaseBuilder({
  target: hostReleaseTarget,
  packageDir: () => process.env.KEYLIME_PACKAGE_DIR || process.cwd(),
  // Do not give source scripts controller credentials or unrelated process configuration.
  environment: () =>
    Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    ),
});
