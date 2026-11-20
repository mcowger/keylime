import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string" },
    "browser-fixture": { type: "boolean" },
    "pr-monitor-fixture": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Usage: bun run dev [--port <port>] [--browser-fixture] [--pr-monitor-fixture]\nDefaults to a free loopback port. Each run keeps its temporary home/config after exit.",
  );
  process.exit(0);
}
const requestedPort = values.port === undefined ? 0 : Number(values.port);
if (
  !Number.isInteger(requestedPort) ||
  requestedPort < 0 ||
  requestedPort > 65535
)
  throw new Error("--port must be an integer from 0 to 65535");

const root = path.resolve(import.meta.dir, "..");
// A short path also keeps the Unix-domain socket below macOS's pathname limit.
const directory = mkdtempSync(path.join(tmpdir(), "kl-dev-"));
const home = path.join(directory, "home");
const agent = path.join(home, ".omp", "agent");
mkdirSync(agent, { recursive: true, mode: 0o700 });
const env = { ...process.env };
// Never inherit a running installation's auth, package root, session, or broker connection.
for (const name of Object.keys(env)) {
  if (
    /^(OMP_|KEYLIME_|PI_|XDG_)/.test(name) ||
    name === "PORT" ||
    name === "NODE_ENV"
  )
    delete env[name];
}
Object.assign(env, {
  HOME: home,
  PI_CODING_AGENT_DIR: agent,
  KEYLIME_PACKAGE_DIR: root,
  KEYLIME_HOST_SOCKET: path.join(directory, "host.sock"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_RUNTIME_DIR: directory,
});

const probe = Bun.listen({
  hostname: "127.0.0.1",
  port: requestedPort,
  socket: { data() {} },
});
const port = probe.port;
probe.stop(true);
const url = `http://127.0.0.1:${port}`;
console.log(`[dev] Directory: ${directory}\n[dev] URL: ${url}`);

const children: Bun.Subprocess[] = [];
let stopping = false;
let exitCode = 0;
const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
let startupChild: Bun.Subprocess | undefined;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  startupChild?.kill();
  finish();
}
function spawn(args: string[], extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd: root,
    env: { ...env, ...extraEnv },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });
  children.push(child);
  void child.exited.then((code) => {
    if (!stopping) {
      console.error(`[dev] Child ${child.pid} exited (${code})`);
      stop(code || 1);
    }
  });
  return child;
}
function signalGroup(child: Bun.Subprocess, signal: NodeJS.Signals) {
  try {
    // Include server/dev.ts's environment-inlining child in shutdown.
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => stop(0));

try {
  // Bootstrap in a child so module-level config caches only ever see the isolated environment.
  const bootstrap = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import { ensureLocalHostLink } from "./lib/hosts/local-bootstrap.ts"; await ensureLocalHostLink({url: ${JSON.stringify(url)}});`,
    ],
    { cwd: root, env, stdout: "inherit", stderr: "inherit" },
  );
  startupChild = bootstrap;
  const bootstrapExit = await bootstrap.exited;
  startupChild = undefined;
  if (bootstrapExit !== 0 && !stopping)
    throw new Error("Could not configure isolated host link");
  if (!stopping) {
    const seed = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "scripts/seed-dev-ui.ts",
        ...(values["pr-monitor-fixture"] ? ["--pr-monitor-fixture"] : []),
      ],
      {
        cwd: root,
        env: { ...env, KEYLIME_UI_FIXTURE_ROOT: directory },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    startupChild = seed;
    const seedExit = await seed.exited;
    startupChild = undefined;
    if (seedExit !== 0 && !stopping)
      throw new Error("Could not seed isolated UI fixtures");
  }
  if (!stopping) {
    spawn([
      "--hot",
      "--no-clear-screen",
      "server/dev.ts",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ]);
    spawn(["--hot", "--no-clear-screen", "bin/keylime-host.ts"], {
      ...(values["browser-fixture"]
        ? { KEYLIME_UI_FIXTURE_ROOT: directory, KEYLIME_BROWSER_FIXTURE: "1" }
        : {}),
      ...(values["pr-monitor-fixture"]
        ? {
            PATH: `${path.join(directory, "pr-monitor-bin")}${path.delimiter}${env.PATH ?? ""}`,
          }
        : {}),
    });
    if (values["browser-fixture"]) {
      const fixtureSession = "11111111-1111-4111-8111-111111111111";
      const deadline = Date.now() + 60_000;
      let started = false;
      while (!stopping && Date.now() < deadline) {
        try {
          const response = await fetch(`${url}/api/agent/${fixtureSession}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "get_state" }),
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) {
            started = true;
            break;
          }
        } catch {
          /* Server and host start asynchronously. */
        }
        await Bun.sleep(500);
      }
      if (!started && !stopping)
        console.error(
          "[dev] Could not start browser fixture session; check the runner build and host logs",
        );
    }
  }
  await finished;
} catch (error) {
  if (!stopping) {
    console.error(error);
    exitCode = 1;
  }
} finally {
  stopping = true;
  for (const child of children) signalGroup(child, "SIGTERM");
  const force = setTimeout(() => {
    for (const child of children) signalGroup(child, "SIGKILL");
  }, 5000);
  await Promise.all(children.map((child) => child.exited));
  clearTimeout(force);
  console.log(`[dev] Stopped. Files retained at ${directory}`);
}
process.exit(exitCode);
