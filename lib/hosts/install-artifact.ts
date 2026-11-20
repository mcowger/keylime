import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  createWriteStream,
  linkSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { acquireDeployLock } from "../deploy-lock";
import { getAgentDir } from "../omp/paths";
import { MAX_UPLOAD_BYTES, UPLOAD_ID_RE } from "../upload-limits";
import { requestHostControl } from "./host-control";
import {
  STANDALONE_HOST_INSTALL,
  STANDALONE_HOST_LAUNCH_AGENT,
  STANDALONE_HOST_UNIT,
} from "./standalone-service";

const USAGE =
  "Usage: keylime host install-artifact <staged-path> --target <keylime|keylime-omp> --sha256 <hex>";

function serviceCommand(argv: string[], timeout: number): string {
  const env = process.platform === "linux" && !process.env.XDG_RUNTIME_DIR
    ? { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` }
    : process.env;
  const result = Bun.spawnSync(argv, { env, timeout, stdin: "ignore" });
  if (result.exitCode !== 0 || result.signalCode) {
    const detail = result.stderr.toString().trim();
    throw new Error(`${argv.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.toString().trim();
}

function standaloneService(uid: number) {
  if (process.platform === "linux") {
    const systemctl = ["systemctl", "--user"];
    return {
      pid: () =>
        Number(
          serviceCommand(
            [
              ...systemctl,
              "show",
              "--property=MainPID",
              "--value",
              STANDALONE_HOST_UNIT,
            ],
            3000,
          ),
        ),
      restart: () =>
        serviceCommand(
          [...systemctl, "restart", STANDALONE_HOST_UNIT],
          120_000,
        ),
    };
  }
  if (process.platform === "darwin") {
    const job = `gui/${uid}/${STANDALONE_HOST_LAUNCH_AGENT}`;
    return {
      pid: () => {
        const status = serviceCommand(["launchctl", "print", job], 3000);
        return Number(/^\s*pid = (\d+)$/m.exec(status)?.[1]);
      },
      restart: () =>
        serviceCommand(["launchctl", "kickstart", "-k", job], 120_000),
    };
  }
  throw new Error(
    "Artifact installation requires a systemd user service or a macOS LaunchAgent",
  );
}

function standaloneInstall(uid: number): string {
  const install = join(realpathSync(homedir()), STANDALONE_HOST_INSTALL);
  const info = lstatSync(install);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0 || realpathSync(install) !== install)
    throw new Error(`Expected an owned standalone installation at ${install}`);
  return install;
}

export function isManagedArtifactBinary(): boolean {
  try {
    const uid = process.getuid?.();
    return !!uid && import.meta.path.startsWith("/$bunfs/") &&
      realpathSync(process.execPath) === join(standaloneInstall(uid), "keylime");
  } catch {
    return false;
  }
}

export function isManagedArtifactDaemon(): boolean {
  try {
    return isManagedArtifactBinary() && standaloneService(process.getuid!()).pid() === process.pid;
  } catch {
    return false;
  }
}

async function copyVerified(
  stagedPath: string,
  candidate: string,
  sha256: string,
  uid: number,
  configuredAgent: string,
) {
  const root = join(realpathSync(configuredAgent), "keylime", "host-artifacts");
  const path = resolve(stagedPath);
  const parent = dirname(path);
  const id = basename(parent);
  if (
    !UPLOAD_ID_RE.test(id) ||
    (parent !== join(root, id) &&
      parent !== join(configuredAgent, "keylime", "host-artifacts", id)) ||
    realpathSync(parent) !== join(root, id) ||
    realpathSync(root) !== root
  )
    throw new Error(
      "Select the staged file under this daemon's keylime/host-artifacts directory without symlinks",
    );
  for (const dir of [root, join(root, id)]) {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
      throw new Error(`Artifact directory is not private: ${dir}`);
  }

  const source = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const hash = createHash("sha256");
  try {
    const info = await source.stat();
    if (
      !info.isFile() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size < 1 ||
      info.size > MAX_UPLOAD_BYTES
    )
      throw new Error(
        "Expected a private, nonempty staged file no larger than 2 GiB",
      );
    await pipeline(
      source.createReadStream({ end: info.size - 1, autoClose: false }),
      new Transform({
        transform(chunk: Buffer, _encoding, next) {
          hash.update(chunk);
          next(null, chunk);
        },
      }),
      createWriteStream(candidate, { flags: "wx", mode: 0o600 }),
    );
  } finally {
    await source.close();
  }
  if (hash.digest("hex") !== sha256)
    throw new Error("SHA-256 mismatch; the installed binary was not changed");
  const output = await open(candidate, "r+");
  try {
    await output.chmod(0o700);
    await output.sync();
  } finally {
    await output.close();
  }
}

/** Operator-only, host-local activation for the standalone binary install. */
export async function runInstallArtifact(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      target: { type: "string" },
      sha256: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const { target, sha256 } = values;
  if (
    positionals.length !== 1 ||
    (target !== "keylime" && target !== "keylime-omp") ||
    !sha256 ||
    !/^[0-9a-f]{64}$/i.test(sha256)
  )
    throw new Error(USAGE);
  return installArtifact({ stagedPath: positionals[0], target, sha256: sha256.toLowerCase() });
}

export async function installArtifact({
  stagedPath,
  target,
  sha256,
  runner,
  agentDir = getAgentDir(),
  expectedPid,
  reportBackup,
}: {
  stagedPath: string;
  target: "keylime" | "keylime-omp";
  sha256: string;
  runner?: { stagedPath: string; sha256: string };
  agentDir?: string;
  expectedPid?: number;
  reportBackup?: (path: string, binary: "keylime" | "keylime-omp") => void;
}): Promise<number> {
  if (runner && target !== "keylime")
    throw new Error("A paired runner requires target keylime");
  const uid = process.getuid?.();
  if (!uid) throw new Error("Run this as the host service user, not root");
  const service = standaloneService(uid);
  const install = standaloneInstall(uid);
  const control = (command: Parameters<typeof requestHostControl>[0]) => requestHostControl(command, agentDir);
  const daemon = join(install, "keylime");
  const installedRunner = join(install, "keylime-omp");
  const plan = (binary: "keylime" | "keylime-omp") => {
    const destination = join(install, binary);
    const previous = lstatSync(destination);
    if (
      !previous.isFile() ||
      previous.uid !== uid ||
      (previous.mode & 0o7000) !== 0 ||
      !(previous.mode & 0o100)
    )
      throw new Error(`Expected an owned executable at ${destination}`);
    return {
      binary,
      destination,
      previous,
      backup: `${destination}.backup-${randomUUID()}`,
    };
  };

  const unlock = acquireDeployLock(install);
  let scratch: string | undefined;
  const backups: string[] = [];
  let drainedPid: number | undefined;
  let replaced = false;
  try {
    const primary = plan(target);
    const secondary = runner ? plan("keylime-omp") : undefined;
    scratch = mkdtempSync(join(install, ".install-artifact-"));
    const candidate = join(scratch, "candidate");
    await copyVerified(stagedPath, candidate, sha256, uid, agentDir);
    const runnerCandidate = join(scratch, "runner-candidate");
    if (runner)
      await copyVerified(runner.stagedPath, runnerCandidate, runner.sha256, uid, agentDir);
    const preflight = spawnSync(
      target === "keylime" ? candidate : daemon,
      ["preflight"],
      {
        cwd: scratch,
        env: {
          HOME: scratch,
          PATH: process.env.PATH,
          TMPDIR: scratch,
          PI_CODING_AGENT_DIR: join(scratch, "agent"),
          KEYLIME_OMP_BIN: runner
            ? runnerCandidate
            : target === "keylime-omp" ? candidate : installedRunner,
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 40_000,
        killSignal: "SIGKILL",
      },
    );
    if (
      preflight.error ||
      preflight.status !== 0 ||
      !/^preflight ok: /m.test(preflight.stdout)
    ) {
      const detail = (preflight.stderr?.trim() || preflight.error?.message)
        ?.slice(-500);
      throw new Error(
        `Preflight failed for ${runner ? "keylime and keylime-omp" : target}; the installed binary was not changed${detail ? `: ${detail}` : ""}`,
      );
    }
    const status = await control("status");
    if (status.executable !== daemon || status.pid !== service.pid() ||
        (expectedPid !== undefined && status.pid !== expectedPid))
      throw new Error(
        "The local daemon is not the installed standalone host service",
      );
    if (status.drained)
      throw new Error(
        "The daemon is already drained. Finish maintenance or resume it before retrying",
      );
    const drained = await control("drain");
    drainedPid = drained.drained ? drained.pid : undefined;
    if (
      drainedPid !== status.pid ||
      drained.executable !== daemon ||
      service.pid() !== status.pid
    )
      throw new Error("The installed host changed while entering maintenance");

    const binaries = secondary ? [primary, secondary] : [primary];
    for (const { binary, destination, previous } of binaries) {
      const current = lstatSync(destination);
      if (current.dev !== previous.dev || current.ino !== previous.ino)
        throw new Error(`The installed binary changed while preparing ${binary}`);
    }
    for (const { binary, destination, backup } of binaries) {
      // Keep the old inode by an exclusive link; the installed name never goes missing.
      linkSync(destination, backup);
      backups.push(backup);
      reportBackup?.(backup, binary);
    }
    renameSync(candidate, primary.destination);
    replaced = true;
    if (secondary) {
      try {
        renameSync(runnerCandidate, secondary.destination);
      } catch (error) {
        try {
          // Restore the first binary atomically without consuming its backup.
          const restore = join(scratch, "restore");
          linkSync(primary.backup, restore);
          renameSync(restore, primary.destination);
          replaced = false;
        } catch (restoreError) {
          throw new Error(
            `Could not install keylime-omp: ${String(error)}. Could not restore keylime: ${String(restoreError)}. The daemon was not resumed`,
            { cause: error },
          );
        }
        throw new Error(
          `Could not install keylime-omp; keylime was restored: ${String(error)}`,
          { cause: error },
        );
      }
    }
    for (const { binary, backup } of binaries)
      console.log(`Installed ${binary}. Backup: ${backup}`);
    // Once restart is attempted, the supervisor may already have run the new pair.
    // Keep both backups and leave recovery to the operator from this point on.
    service.restart();
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      let next;
      try {
        next = await control("status");
      } catch {
        // The replacement may not have opened its control socket yet.
      }
      if (
        next &&
        next.pid !== status.pid &&
        next.executable === daemon &&
        !next.drained &&
        next.pid === service.pid()
      ) {
        console.log(
          `Host service restarted (PID ${next.pid}). Verify the link in Settings → Hosts.`,
        );
        return 0;
      }
      await Bun.sleep(250);
    }
    throw new Error("The replacement did not confirm startup");
  } catch (error) {
    if (replaced)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}. ${backups.length === 1 ? "Backup" : "Backups"}: ${backups.join(", ")}. Check the service before restoring it; no automatic rollback.`,
        { cause: error },
      );
    if (drainedPid) {
      try {
        const current = await control("status");
        if (
          current.pid === drainedPid &&
          current.drained &&
          current.executable === daemon
        )
          await control("resume");
      } catch (recoveryError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}. Could not resume the daemon: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    try {
      if (scratch) rmSync(scratch, { recursive: true });
    } finally {
      unlock();
    }
  }
}
