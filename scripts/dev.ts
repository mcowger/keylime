import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Usage: bun run dev [--port <port>]\nDefaults to a free loopback port. Each run keeps its temporary home/config after exit.",
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
    /^(OMP_|OMPWEB_|PI_|XDG_)/.test(name) ||
    name === "PORT" ||
    name === "NODE_ENV"
  )
    delete env[name];
}
Object.assign(env, {
  HOME: home,
  PI_CODING_AGENT_DIR: agent,
  OMP_WEB_PACKAGE_DIR: root,
  OMPWEB_HOST_SOCKET: path.join(directory, "host.sock"),
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
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  finish();
}
function spawn(args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd: root,
    env,
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
  const bootstrapExit = await bootstrap.exited;
  if (bootstrapExit !== 0)
    throw new Error("Could not configure isolated host link");
  if (!stopping) {
    const seed = Bun.spawn(
      [process.execPath, "--no-env-file", "scripts/seed-dev-ui.ts"],
      {
        cwd: root,
        env: { ...env, KEYLIME_UI_FIXTURE_ROOT: directory },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if ((await seed.exited) !== 0)
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
    spawn(["--hot", "--no-clear-screen", "bin/omp-web-host.ts"]);
  }
  await finished;
} catch (error) {
  console.error(error);
  exitCode = 1;
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
