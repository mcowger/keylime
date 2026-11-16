#!/usr/bin/env bun
"use strict";
import type { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import type * as PathModule from "node:path";
import type * as FsModule from "node:fs";
import type * as HashPasswordModule from "./omp-web-hash-password";
import type * as OptionsModule from "./omp-web-options";
import type * as PortModule from "./port-availability";
import type * as LifecycleModule from "./process-lifecycle";
import type * as NetworkModule from "./network-addresses";

type ServerChild = ChildProcess;

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
  // Verify that the installed runner starts and speaks the expected protocol.
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
  // Fetch this release's omp runner if missing.
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
  const { checkLaunchSecurity, parseLaunchOptions } =
    require("./omp-web-options.ts") as typeof OptionsModule;
  const { isPortAvailable } =
    require("./port-availability.ts") as typeof PortModule;
  const { wireChildProcessLifecycle } =
    require("./process-lifecycle.ts") as typeof LifecycleModule;
  const {
    getAccessibleAddresses,
    getBrowserUrl,
    formatAddressBanner,
    openInBrowser,
  } = require("./network-addresses.ts") as typeof NetworkModule;

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
  const browserUrl = getBrowserUrl(hostname, port);
  let browserOpened = false;
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
      OMP_WEB_PORT: port,
      OMP_WEB_HOSTNAME: hostname,
    };
  }

  function trackServer(child: ServerChild) {
    child.once("error", (error) => {
      console.error(`Could not start ompweb: ${error.message}`);
    });
    attachOutput(child);
    wireChildProcessLifecycle(child, process);
    return child;
  }

  function spawnServer(command: string[]) {
    return trackServer(
      spawn(command[0], command.slice(1), {
        cwd: pkgDir,
        stdio: ["inherit", "pipe", "inherit"],
        env: serverEnvironment(),
      }),
    );
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

}
