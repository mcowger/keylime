// Local macOS/Pitchfork deployment. Never stop a daemon that owns session children.
import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    activate: { type: "string" },
    wait: { type: "boolean" },
    help: { type: "boolean" },
  },
});
const home = homedir();
const base = path.join(home, ".local/share/keylime");
const root = path.resolve(import.meta.dir, "..");
const agent = process.env.PI_CODING_AGENT_DIR || path.join(home, ".omp/agent");
if (values.help) {
  console.log(
    "bun run deploy:local\n  Build committed HEAD, smoke-test, then activate only if the host has no sessions.\nbun run deploy:local --activate <release-directory> [--wait]\n  Activate an already verified release; --wait waits for all session processes to exit.\nReleases and pre-cutover backups: ~/.local/share/keylime/",
  );
  process.exit(0);
}
if (process.platform !== "darwin")
  throw new Error("This deployment command targets macOS with Pitchfork");
mkdirSync(base, { recursive: true, mode: 0o700 });
const lock = path.join(base, "deploy.lock");
mkdirSync(lock); // Exclusive; an orphaned lock needs manual inspection, never time-expired.
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(OMP_|OMPWEB_|PI_|XDG_)/.test(key)) delete env[key];
const run = (cmd: string[], cwd = root, childEnv = env) => {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: childEnv,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(`Command failed: ${cmd.slice(0, 3).join(" ")}`);
};
const text = (cmd: string[]) => {
  const result = Bun.spawnSync(cmd, {
    cwd: home,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Command failed: ${cmd.join(" ")}: ${result.stderr.toString()}`,
    );
  return result.stdout.toString().trim();
};
const select = (target: string) => {
  const tmp = path.join(base, `current-${process.pid}`);
  symlinkSync(target, tmp);
  renameSync(tmp, path.join(base, "current"));
};
const status = () =>
  JSON.parse(text(["pitchfork", "status", "global/ompweb-host", "--json"])) as {
    pid?: number;
    status: string;
  };
const children = (pid: number) =>
  text(["ps", "-axo", "pid=,ppid=,command="])
    .split("\n")
    .filter((line) => {
      const cols = line.trim().split(/\s+/);
      return Number(cols[1]) === pid;
    });
let webStopped = false;
let hostStopped = false;
let frozen: number | undefined;
let previous: string | undefined;
let selected = false;
try {
  let candidate: string;
  if (values.activate) {
    candidate = realpathSync(path.resolve(values.activate));
    if (!existsSync(path.join(candidate, "keylime-release.json")))
      throw new Error("Not a verified Keylime release directory");
  } else {
    const sha = text(["git", "-C", root, "rev-parse", "HEAD"]);
    const version = `${sha.slice(0, 12)}-${Date.now()}`;
    const scratch = path.join(base, "builds", version);
    mkdirSync(scratch, { recursive: true });
    // Build only committed source, never accidentally publish a dirty working tree.
    const archive = Bun.spawnSync(["git", "archive", "HEAD"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (archive.exitCode) throw new Error("git archive failed");
    const unpack = Bun.spawnSync(["tar", "-xf", "-", "-C", scratch], {
      stdin: archive.stdout,
    });
    if (unpack.exitCode) throw new Error("Source extraction failed");
    run(["mise", "trust"], scratch);
    run(["mise", "install"], scratch);
    const bun = (...args: string[]) =>
      run(["mise", "exec", "--", "bun", ...args], scratch);
    bun("install", "--frozen-lockfile");
    bun("runner/scripts/use-omp-build.ts");
    run(
      ["mise", "exec", "--", "bun", "install", "--frozen-lockfile"],
      path.join(scratch, "runner"),
    );
    bun("runner/scripts/build-binary.ts");
    bun("run", "build:binary");
    candidate = path.join(base, "releases", version);
    mkdirSync(path.dirname(candidate), { recursive: true });
    cpSync(
      path.join(scratch, `release/ompweb-${process.platform}-${process.arch}`),
      candidate,
      { recursive: true },
    );
    bun("scripts/smoke.ts", "--binary", path.join(candidate, "ompweb"));
    writeFileSync(
      path.join(candidate, "keylime-release.json"),
      JSON.stringify({ sha, builtAt: new Date().toISOString() }) + "\n",
    );
    console.log(`Verified release: ${candidate}`);
  }
  // Preflight only probes the candidate runner; it does not start the production web server.
  run([path.join(candidate, "ompweb"), "preflight"], home, {
    ...env,
    PI_CODING_AGENT_DIR: agent,
  });
  if (!existsSync(path.join(base, "current")))
    throw new Error(
      "Configure current release, Pitchfork and mise before activation (docs/local-deployment.md)",
    );
  previous = realpathSync(path.join(base, "current"));
  for (;;) {
    const host = status();
    if (host.status !== "running" || !host.pid)
      throw new Error("Production host must be running to prove it is idle");
    if (children(host.pid).length) {
      console.log("Waiting: production host still owns session processes.");
      if (!values.wait) {
        console.log(
          `Activate later: bun run deploy:local --activate ${candidate} --wait`,
        );
        process.exitCode = 2;
        break;
      }
      await Bun.sleep(10000);
      continue;
    }
    // Stop admission, then freeze host while checking for a raced spawn.
    run(["pitchfork", "stop", "global/ompweb"]);
    webStopped = true;
    process.kill(host.pid, "SIGSTOP");
    frozen = host.pid;
    if (status().pid !== host.pid || children(host.pid).length) {
      process.kill(host.pid, "SIGCONT");
      frozen = undefined;
      run(["pitchfork", "start", "global/ompweb"]);
      webStopped = false;
      if (!values.wait)
        throw new Error(
          "A session started during cutover; services left unchanged",
        );
      await Bun.sleep(10000);
      continue;
    }
    process.kill(host.pid, "SIGCONT");
    frozen = undefined;
    run(["pitchfork", "stop", "global/ompweb-host"]);
    hostStopped = true;
    const backup = path.join(base, "backups", String(Date.now()));
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const file of [
      ".config/pitchfork/config.toml",
      ".config/mise/config.macmini.toml",
    ])
      cpSync(
        path.join(home, file),
        path.join(backup, path.basename(path.dirname(file)) + ".toml"),
      );
    run([
      "tar",
      "-czf",
      path.join(backup, "agent.tar.gz"),
      "-C",
      path.dirname(agent),
      path.basename(agent),
    ]);
    writeFileSync(path.join(backup, "previous-release.txt"), previous + "\n");
    select(candidate);
    selected = true;
    run(["pitchfork", "start", "global/ompweb"]);
    webStopped = false;
    run(["pitchfork", "start", "global/ompweb-host"]);
    hostStopped = false;
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch("http://127.0.0.1:8080/", {
          redirect: "manual",
          signal: AbortSignal.timeout(2000),
        });
        if (
          [200, 302, 303, 307].includes(response.status) &&
          status().status === "running"
        ) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(1000);
    }
    if (!ready)
      throw new Error(
        "Production readiness failed; inspect Pitchfork logs. No automatic rollback after admission reopens.",
      );
    console.log(
      `Deployed ${candidate}\nBackup: ${backup}\nPrevious: ${previous}\nURL: http://192.168.0.11:8080/`,
    );
    break;
  }
} catch (error) {
  // Before admission reopens, restore selection and restart old services on failure.
  if (frozen) process.kill(frozen, "SIGCONT");
  if (webStopped && hostStopped && previous && selected) select(previous);
  if (webStopped) run(["pitchfork", "start", "global/ompweb"]);
  if (hostStopped) run(["pitchfork", "start", "global/ompweb-host"]);
  throw error;
} finally {
  rmSync(lock, { recursive: true });
}
