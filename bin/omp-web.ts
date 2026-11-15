#!/usr/bin/env bun
"use strict";
import type { ChildProcess } from "node:child_process";
import type { Stats } from "node:fs";
import type * as ChildProcessModule from "node:child_process";
import type * as PathModule from "node:path";
import type * as FsModule from "node:fs";
import type * as CryptoModule from "node:crypto";
import type * as OsModule from "node:os";
import type * as HashPasswordModule from "./omp-web-hash-password";
import type * as OptionsModule from "./omp-web-options";
import type * as PortModule from "./port-availability";
import type * as LifecycleModule from "./process-lifecycle";
import type * as NetworkModule from "./network-addresses";

type ServerChild = ChildProcess;
type UpdateControl = { root: string; attemptId: string };
type UpdateMessage = {
  type?: string;
  protocol?: number;
  attemptId?: string;
  root?: string;
};
type RestartRequest = { generation: number };

// Forward service subcommands without requiring callers to know the secondary executable path.
const forwardedServiceScripts: Record<string, string> = {
  launchd: "omp-web-launchd.ts",
  "ompweb-launchd": "omp-web-launchd.ts",
  systemd: "omp-web-systemd.ts",
  "ompweb-systemd": "omp-web-systemd.ts",
};

// `ompweb hash-password` reads the password on stdin and prints the value for
// OMP_WEB_PASSWORD_HASH. Handled first so it works with no build artifacts, no
// port, and no agent directory.
if (
  process.argv[2] === "hash-password" ||
  process.argv[2] === "hash_password"
) {
  const { runHashPasswordCommand } =
    require("./omp-web-hash-password.ts") as typeof HashPasswordModule;
  runHashPasswordCommand()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error(
        `Could not hash the password: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
} else {
  startLauncher();
}

function startLauncher() {
  // `ompweb preflight` (lib/hosts/preflight.ts): what an updater runs on a candidate release; it prints "preflight ok: <omp> <version>".
  if (process.argv[2] === "preflight") {
    process.env.OMP_WEB_PACKAGE_DIR ??= module
      .require("node:path")
      .join(__dirname, "..");
    import("../lib/hosts/preflight.ts").then(
      ({ runPreflight }) => runPreflight().then((code) => process.exit(code)),
      (error) => {
        console.error(
          `preflight failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      },
    );
    return;
  }
  // `ompweb fetch-omp` (lib/omp/runner-fetch.ts): fetch this version's omp runner if missing; updaters run it before preflight.
  if (process.argv[2] === "fetch-omp") {
    process.env.OMP_WEB_PACKAGE_DIR ??= module
      .require("node:path")
      .join(__dirname, "..");
    import("../lib/omp/runner-fetch.ts").then(
      ({ runFetchOmp }) => runFetchOmp().then((code) => process.exit(code)),
      (error) => {
        console.error(
          `fetch-omp failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      },
    );
    return;
  }
  // `ompweb host` runs in this process: a supervisor's SIGTERM must reach the daemon, not a wrapper.
  if (process.argv[2] === "host") {
    process.argv.splice(2, 1);
    require("./omp-web-host.ts");
    return;
  }
  const forwardedServiceScript = forwardedServiceScripts[process.argv[2]];
  if (forwardedServiceScript) {
    const { spawnSync } = require("node:child_process");
    const { join } = require("node:path");
    const result = spawnSync(
      process.execPath,
      [join(__dirname, forwardedServiceScript), ...process.argv.slice(3)],
      { stdio: "inherit" },
    );
    if (result.error) {
      console.error(
        `Failed to run ${process.argv[2]}: ${result.error.message}`,
      );
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  }

  const { spawn } = require("node:child_process") as typeof ChildProcessModule;
  const path = require("node:path") as typeof PathModule;
  const fs = require("node:fs") as typeof FsModule;
  const crypto = require("node:crypto") as typeof CryptoModule;
  const { checkLaunchSecurity, parseLaunchOptions } =
    require("./omp-web-options.ts") as typeof OptionsModule;
  const { isPortAvailable } =
    require("./port-availability.ts") as typeof PortModule;
  const { terminateChildProcess, wireChildProcessLifecycle } =
    require("./process-lifecycle.ts") as typeof LifecycleModule;
  const {
    getAccessibleAddresses,
    getBrowserUrl,
    formatAddressBanner,
    openInBrowser,
  } = require("./network-addresses.ts") as typeof NetworkModule;

  const UPDATE_PROTOCOL = 1;
  const UPDATE_MESSAGE = "ompweb:update-control";
  const UPDATE_ACK = "ompweb:update-control-ack";
  const RESTART_ACK_RETRIES = 3;
  const RESTART_ACK_RETRY_MS = 100;
  const RESTART_GATE_START = "ompweb:restart-gate-start";

  function runRestartGate(startMessageType: string) {
    const { spawn: spawnChild } =
      require("node:child_process") as typeof ChildProcessModule;
    const os = require("node:os") as typeof OsModule;
    let child: ServerChild | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let finished = false;
    let stopping = false;

    const exitCode = (code?: number | null, signal?: NodeJS.Signals | null) => {
      const signalNumber = signal ? os.constants.signals[signal] : undefined;
      return (
        code ?? (typeof signalNumber === "number" ? 128 + signalNumber : 1)
      );
    };
    const finish = (code?: number | null, signal?: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      process.exitCode = exitCode(code, signal);
      if (process.connected) process.disconnect?.();
    };
    const killTree = (signal: NodeJS.Signals) => {
      if (!child) return finish(undefined, signal);
      try {
        process.kill(-process.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };
    const stop = (signal: NodeJS.Signals = "SIGTERM") => {
      if (finished || stopping) return;
      stopping = true;
      if (!child) return finish(undefined, signal);
      killTree(signal);
      forceTimer = setTimeout(() => killTree("SIGKILL"), 4_000);
      forceTimer.unref();
    };

    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.once("disconnect", () => stop());
    process.on("message", (rawMessage) => {
      const message = rawMessage as { type?: string; args?: string[] };
      if (!child) {
        if (
          message?.type !== startMessageType ||
          !Array.isArray(message.args) ||
          message.args.length === 0
        )
          return;
        child = spawnChild(message.args[0], message.args.slice(1), {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["inherit", "pipe", "inherit", "ipc"],
        });
        child.stdout!.pipe(process.stdout, { end: false });
        child.on("message", (childMessage) => {
          if (!process.connected) return;
          try {
            process.send?.(childMessage, () => {});
          } catch {}
        });
        child.once("error", () => finish(1));
        child.once("close", finish);
        return;
      }
      if (!child.connected) return;
      try {
        child.send(message, () => {});
      } catch {}
    });
  }
  const pkgDir = path.join(__dirname, "..");

  const launchOptions = parseLaunchOptions();
  if (launchOptions.help || launchOptions.version) {
    process.exit(0);
  }
  if (launchOptions.error) {
    console.error(launchOptions.error);
    process.exit(2);
  }

  const port = launchOptions.port;
  const hostname = launchOptions.hostname;
  const openBrowser = launchOptions.openBrowser;
  const passwordEnabled = checkLaunchSecurity(launchOptions) !== undefined;

  function serverCommand() {
    return [
      process.execPath,
      path.join(pkgDir, "server", "main.ts"),
      "-p",
      String(port),
      "-H",
      String(hostname),
    ];
  }
  const restartDescriptor = JSON.stringify({
    launcherPath: path.join(pkgDir, "bin", "omp-web.ts"),
    hostname: String(hostname),
    port: String(port),
  });
  const browserUrl = getBrowserUrl(hostname, port);
  let browserOpened = false;
  let currentChild: ServerChild | null = null;
  let currentGeneration = 0;
  let updateControl: UpdateControl | null = null;
  let waitingForRestart = false;

  function updatePath(control: UpdateControl, suffix: string) {
    return path.join(control.root, `${control.attemptId}.${suffix}`);
  }

  function ownedByCurrentUser(info: Stats) {
    return (
      typeof process.getuid !== "function" || info.uid === process.getuid()
    );
  }

  function secureDirectory(directory: string) {
    const info = fs.lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !ownedByCurrentUser(info)
    )
      throw new Error("unsafe update control directory");
    return info;
  }

  function secureRegularFile(file: string) {
    let info;
    try {
      info = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      !ownedByCurrentUser(info)
    ) {
      throw new Error("unsafe update control file");
    }
    return info;
  }

  function atomicWrite(file: string, value: string) {
    secureDirectory(path.dirname(file));
    secureRegularFile(file);
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, value, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  function readControlJson(file: string): Record<string, unknown> | null {
    if (!secureRegularFile(file)) return null;
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  function removeSecureFile(file: string) {
    if (!secureRegularFile(file)) return true;
    fs.rmSync(file);
    return true;
  }

  function readPackageVersion() {
    try {
      return (
        JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"))
          .version ?? "0.0.0"
      );
    } catch {
      return "0.0.0";
    }
  }

  function isExternalControlRoot(root: unknown): root is string {
    if (typeof root !== "string" || !path.isAbsolute(root)) return false;
    try {
      const packageRoot = fs.realpathSync(pkgDir);
      const controlRoot = fs.realpathSync(root);
      secureDirectory(controlRoot);
      const relative = path.relative(packageRoot, controlRoot);
      return (
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      );
    } catch {
      return false;
    }
  }

  function acknowledgeArm(
    child: ServerChild,
    message: UpdateMessage,
    error?: string,
  ) {
    if (!child.connected) return;
    child.send({
      type: UPDATE_ACK,
      protocol: UPDATE_PROTOCOL,
      attemptId: message.attemptId,
      ok: !error,
      ...(error ? { error } : {}),
    });
  }

  function isProcessAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
    }
  }

  function hasLivePreparedOwnership(control: UpdateControl) {
    const status = readControlJson(path.join(control.root, "status.json"));
    const lease = readControlJson(path.join(control.root, "lease.json"));
    return (
      status?.attemptId === control.attemptId &&
      (status.state === "prepared" || status.state === "running") &&
      status.stage === "stopping" &&
      typeof status.workerPid === "number" &&
      isProcessAlive(status.workerPid) &&
      lease?.attemptId === control.attemptId &&
      typeof lease.expiresAt === "number" &&
      Number.isFinite(lease.expiresAt) &&
      lease.expiresAt > Date.now() &&
      !secureRegularFile(updatePath(control, "abort.json")) &&
      !secureRegularFile(updatePath(control, "go"))
    );
  }

  function watchUpdateCompletion(control: UpdateControl) {
    const poll = () => {
      if (updateControl !== control) return;
      let completion;
      try {
        completion = readControlJson(updatePath(control, "complete.json"));
      } catch {
        setTimeout(poll, 100).unref?.();
        return;
      }
      if (completion) {
        if (
          completion.protocol !== UPDATE_PROTOCOL ||
          completion.attemptId !== control.attemptId
        ) {
          setTimeout(poll, 100).unref?.();
          return;
        }
        try {
          atomicWrite(
            updatePath(control, "complete-ack.json"),
            JSON.stringify({
              protocol: UPDATE_PROTOCOL,
              attemptId: control.attemptId,
            }),
          );
        } catch {
          setTimeout(poll, 100).unref?.();
          return;
        }
        updateControl = null;
        waitingForRestart = false;
        if (!currentChild) process.exit(1);
        return;
      }
      setTimeout(poll, 100).unref?.();
    };
    poll();
  }

  function handleUpdateArm(child: ServerChild, message: UpdateMessage) {
    if (
      !message ||
      message.type !== UPDATE_MESSAGE ||
      message.protocol !== UPDATE_PROTOCOL
    )
      return;
    if (
      typeof message.attemptId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(message.attemptId) ||
      !isExternalControlRoot(message.root)
    ) {
      acknowledgeArm(child, message, "invalid update control");
      return;
    }
    try {
      const control = {
        attemptId: message.attemptId,
        root: fs.realpathSync(message.root),
      };
      if (
        updateControl &&
        (updateControl.attemptId !== control.attemptId ||
          updateControl.root !== control.root)
      ) {
        acknowledgeArm(child, message, "another update is active");
        return;
      }
      if (!hasLivePreparedOwnership(control)) {
        acknowledgeArm(child, message, "update attempt is no longer active");
        return;
      }
      if (!updateControl) {
        process.chdir(control.root);
        atomicWrite(
          updatePath(control, "armed.json"),
          JSON.stringify({
            protocol: UPDATE_PROTOCOL,
            attemptId: control.attemptId,
            launcherPid: process.pid,
          }),
        );
        currentGeneration = 0;
        updateControl = control;
        watchUpdateCompletion(control);
      } else {
        atomicWrite(
          updatePath(updateControl, "armed.json"),
          JSON.stringify({
            protocol: UPDATE_PROTOCOL,
            attemptId: updateControl.attemptId,
            launcherPid: process.pid,
          }),
        );
      }
    } catch {
      acknowledgeArm(child, message, "update control could not be armed");
      return;
    }
    acknowledgeArm(child, message);
  }

  function attachOutput(child: ServerChild) {
    let bannerPrinted = false;
    let readyBuffer = "";
    child.stdout!.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      readyBuffer += text;
      if (readyBuffer.length > 500) readyBuffer = readyBuffer.slice(-500);
      if (!readyBuffer.includes("Ready")) return;
      if (!bannerPrinted) {
        bannerPrinted = true;
        const { entries, hint } = getAccessibleAddresses({ hostname, port });
        process.stdout.write(
          formatAddressBanner({
            version: readPackageVersion(),
            entries,
            hint,
            passwordEnabled,
            isTTY: process.stdout.isTTY,
          }),
        );
      }
      if (openBrowser && !browserOpened) {
        browserOpened = true;
        openInBrowser(browserUrl);
      }
    });
  }

  function serverEnvironment() {
    return {
      ...process.env,
      OMP_WEB_PACKAGE_DIR: pkgDir,
      OMP_WEB_LAUNCHER_PID: String(process.pid),
      OMP_WEB_BUN_BIN: process.execPath,
      OMP_WEB_PORT: port,
      OMP_WEB_HOSTNAME: hostname,
      OMP_WEB_RESTART_DESCRIPTOR: restartDescriptor,
    };
  }

  function trackServer(child: ServerChild) {
    currentChild = child;
    child.on("message", (message) =>
      handleUpdateArm(child, message as UpdateMessage),
    );
    child.once("error", (error) => {
      console.error(`Could not start ompweb: ${error.message}`);
      if (child.pid !== undefined && child.pid > 0) return;
      if (currentChild === child) currentChild = null;
      if (updateControl) {
        waitForRestartRequest(updateControl).catch((restartError) => {
          console.error(
            `Could not complete update restart: ${restartError.message}`,
          );
        });
      }
    });
    attachOutput(child);
    wireChildProcessLifecycle(child, process, undefined, () => {
      if (!updateControl) return false;
      if (currentChild === child) currentChild = null;
      waitForRestartRequest(updateControl).catch((error) => {
        console.error(`Could not complete update restart: ${error.message}`);
      });
      return true;
    });
    return child;
  }

  function spawnServer(command: string[]) {
    return trackServer(
      spawn(command[0], command.slice(1), {
        cwd: pkgDir,
        stdio: ["inherit", "pipe", "inherit", "ipc"],
        env: serverEnvironment(),
      }),
    );
  }

  function spawnRestartGate() {
    return spawn(
      process.execPath,
      [
        "-e",
        `(${runRestartGate.toString()})(${JSON.stringify(RESTART_GATE_START)})`,
      ],
      {
        cwd: pkgDir,
        detached: true,
        stdio: ["inherit", "pipe", "inherit", "ipc"],
        env: serverEnvironment(),
      },
    );
  }

  function startRestartGate(child: ServerChild, args: string[]) {
    return new Promise<void>((resolve, reject) => {
      if (!child.connected)
        return reject(new Error("restart gate IPC is unavailable"));
      child.send({ type: RESTART_GATE_START, args }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async function acknowledgeRestartRequest(
    control: UpdateControl,
    request: RestartRequest,
    child: ServerChild,
  ) {
    if (child.pid === undefined || child.pid <= 0) {
      if (currentChild === child) currentChild = null;
      return false;
    }
    const acknowledgement = JSON.stringify({
      protocol: UPDATE_PROTOCOL,
      attemptId: control.attemptId,
      generation: request.generation,
      pid: child.pid,
    });
    while (true) {
      for (let attempt = 1; attempt <= RESTART_ACK_RETRIES; attempt += 1) {
        try {
          atomicWrite(updatePath(control, "restart-ack.json"), acknowledgement);
          currentGeneration = request.generation;
          try {
            removeSecureFile(updatePath(control, "restart-request.json"));
          } catch {
            /* the durable acknowledgement makes the retained request harmless */
          }
          return true;
        } catch {
          if (attempt < RESTART_ACK_RETRIES) {
            await new Promise((resolve) =>
              setTimeout(resolve, RESTART_ACK_RETRY_MS),
            );
          }
        }
      }

      if (await terminateChildProcess(child)) {
        if (currentChild === child) currentChild = null;
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, RESTART_ACK_RETRY_MS));
    }
  }

  async function acknowledgeAndStartRestart(
    control: UpdateControl,
    request: RestartRequest,
    child: ServerChild,
    args: string[],
  ) {
    if (!(await acknowledgeRestartRequest(control, request, child)))
      return false;
    await startRestartGate(child, args);
    return true;
  }

  async function waitForRestartRequest(control: UpdateControl) {
    if (waitingForRestart || updateControl !== control) return;
    waitingForRestart = true;
    const requestFile = updatePath(control, "restart-request.json");
    try {
      while (updateControl === control && !currentChild) {
        let request;
        try {
          request = readControlJson(requestFile);
        } catch {}
        if (
          request?.attemptId === control.attemptId &&
          request.protocol === UPDATE_PROTOCOL &&
          request.action === "start" &&
          typeof request.generation === "number" &&
          Number.isInteger(request.generation) &&
          request.generation === currentGeneration + 1
        ) {
          let command;
          try {
            command = serverCommand();
          } catch (error) {
            // Retried while the update is active; one line per attempt, not a spin.
            console.error(
              `Could not start the updated server: ${error instanceof Error ? error.message : String(error)}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            continue;
          }
          const child = trackServer(spawnRestartGate());
          if (
            await acknowledgeAndStartRestart(
              control,
              { generation: request.generation },
              child,
              command,
            )
          )
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      waitingForRestart = false;
      if (updateControl === control && !currentChild) {
        setTimeout(() => {
          waitForRestartRequest(control).catch((error) => {
            console.error(
              `Could not complete update restart: ${error.message}`,
            );
          });
        }, 0);
      }
    }
  }

  async function main() {
    if (
      !fs.existsSync(path.join(pkgDir, "dist", "index.html")) ||
      !fs.existsSync(path.join(pkgDir, "server", "main.ts"))
    ) {
      console.error("Build artifacts not found. Please report this issue.");
      process.exit(1);
    }
    if (!(await isPortAvailable(port, hostname))) {
      console.error(`Port ${port} on ${hostname} is already in use.`);
      console.error(
        `If ompweb is already running, open ${browserUrl}. Otherwise, stop the process using it or run: ompweb --port ${Number(port) + 1}`,
      );
      process.exitCode = 1;
      return;
    }
    let command;
    try {
      command = serverCommand();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    spawnServer(command);
  }

  if (require.main === module) {
    main().catch((error) => {
      console.error(`Could not start ${browserUrl}: ${error.message}`);
      process.exit(1);
    });
  }

  module.exports = {
    acknowledgeAndStartRestart,
    acknowledgeRestartRequest,
    handleUpdateArm,
    spawnRestartGate,
    startRestartGate,
  };
}
