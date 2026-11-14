// Local macOS/Pitchfork deployment with a bounded, daemon-authoritative idle drain.
import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { activateRelease } from "./deploy-activate";
import {
  acquireDeployLock,
  readDeployState,
  saveDeployState,
  type DeployState,
} from "./deploy-state";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    activate: { type: "string" },
    id: { type: "string" },
    root: { type: "string" },
    recover: { type: "boolean" },
  },
});
const home = homedir();
const base = path.join(home, ".local/share/keylime");
if (!values.root || !values.id)
  throw new Error("Deploy worker requires --root and --id");
const root = path.resolve(values.root);
const agent = process.env.PI_CODING_AGENT_DIR || path.join(home, ".omp/agent");
if (process.platform !== "darwin")
  throw new Error("This deployment command targets macOS with Pitchfork");
mkdirSync(base, { recursive: true, mode: 0o700 });
const unlock = acquireDeployLock(base);
const prior = readDeployState(base);
if (
  prior &&
  !["complete", "failed", "recovered"].includes(prior.phase) &&
  !values.recover
) {
  unlock();
  throw new Error(
    `Previous deployment stopped in phase ${prior.phase}; use --recover after inspecting status`,
  );
}
let state: DeployState = {
  id: values.id,
  pid: process.pid,
  phase: "accepted",
  updatedAt: new Date().toISOString(),
  log: path.join(base, `deploy-${values.id}.log`),
};
const onPhase = (phase: string, details: Record<string, unknown> = {}) => {
  state = { ...state, ...details, phase, updatedAt: new Date().toISOString() };
  saveDeployState(base, state);
  console.log(`${state.updatedAt} ${phase}`);
};
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
    timeout: 900000,
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
    timeout: 30000,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Command failed: ${cmd.join(" ")}: ${result.stderr.toString()}`,
    );
  return result.stdout.toString().trim();
};
try {
  onPhase("accepted");
  if (values.recover) {
    onPhase("recovering", { interrupted: prior });
    run(["pitchfork", "start", "global/ompweb"]);
    run(["pitchfork", "start", "global/ompweb-host"]);
    onPhase("recovered");
  } else {
    onPhase("building");
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
        path.join(
          scratch,
          `release/ompweb-${process.platform}-${process.arch}`,
        ),
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
    await activateRelease({ candidate, base, agent, home, env, onPhase });
  }
} catch (error) {
  onPhase("failed", {
    error: error instanceof Error ? error.stack : String(error),
  });
  process.exitCode = 1;
} finally {
  unlock();
}
