import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  ActivateHostArtifactArgsSchema,
  type ActivateHostArtifactArgs,
  type HostArtifactActivationResult,
} from "../api-contracts/host-control-models";
import { UPLOAD_ID_RE } from "../upload-limits";
import {
  installArtifact,
  isManagedArtifactBinary,
  isManagedArtifactDaemon,
} from "./install-artifact";
import { HostOpError } from "./link-protocol";

const STAGE_TTL = 30 * 60_000;
const MAX_STAGES = 128;
const START_TTL = 60_000;
const PENDING = { state: "pending" } as const;
export const ACTIVATION_WORKER = "managed-artifact-worker";

type Request = ActivateHostArtifactArgs & {
  owner: string;
  stagedPath: string;
  runnerStagedPath?: string;
  expectedPid: number;
  startBy: number;
};

function operationId(value: unknown): string {
  if (typeof value !== "string" || !UPLOAD_ID_RE.test(value))
    throw new HostOpError(400, "invalid_request", "Invalid activation operation ID");
  return value.toLowerCase();
}

function jobFiles(agentDir: string, id: string) {
  const parent = join(realpathSync(agentDir), "keylime");
  const parentInfo = lstatSync(parent);
  const uid = process.getuid?.();
  if (!uid || !parentInfo.isDirectory() || parentInfo.uid !== uid || (parentInfo.mode & 0o022) !== 0)
    throw new HostOpError(409, "artifact_activation_permissions", `The service user must own ${parent} and make it writable only by that user`);
  const dir = join(parent, "host-artifact-activation");
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new HostOpError(409, "artifact_activation_permissions", `The service user must own ${dir} and grant no group or other access`);
  return {
    dir,
    request: join(dir, `${id}.request`),
    claim: join(dir, `${id}.claim`),
    state: join(dir, `${id}.state`),
  };
}

function publish(dir: string, path: string, value: Request | HostArtifactActivationResult, exclusive = false) {
  const temp = join(dir, randomUUID());
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (exclusive) linkSync(temp, path);
    else renameSync(temp, path);
    const directory = openSync(dir, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

function claim(path: string): boolean {
  try {
    closeSync(openSync(path, "wx", 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function launchWorker(agentDir: string, id: string): Promise<void> {
  // The local supervisor client needs the user bus, not host credentials.
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.platform === "linux" && !env.XDG_RUNTIME_DIR)
    env.XDG_RUNTIME_DIR = `/run/user/${process.getuid!()}`;
  const worker = [process.execPath, "host", ACTIVATION_WORKER, agentDir, id] as const;
  if (process.platform === "darwin") {
    const child = spawn(worker[0], worker.slice(1), {
      detached: true,
      stdio: "ignore",
      env,
    });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    child.once("spawn", resolve);
    child.once("error", reject);
    await promise;
    child.unref();
  } else {
    // A transient service (not a scope or child process) survives the host unit's restart.
    // Clear the user manager's environment too. Escape systemd's argv expansion.
    const argv = [...Object.entries(env).map(([key, value]) => `${key}=${value}`), ...worker]
      .map((arg) => arg.replaceAll("$", () => "$$"));
    const child = Bun.spawn([
      "systemd-run", "--user", "--collect", "--property=Type=exec",
      "--unit", `keylime-artifact-${id}`, "--", "/usr/bin/env", "-i", ...argv,
    ], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    if (await child.exited !== 0)
      throw new Error("Could not start the transient activation service");
  }
}

export class ManagedArtifactActivation {
  private readonly stages = new Map<string, { path: string; owner: string; expires: number }>();

  constructor(private readonly agentDir: string, private readonly standalone: boolean) {}

  supported(): boolean {
    return this.standalone && isManagedArtifactDaemon();
  }

  stage(id: string, path: string, owner: string): void {
    if (!this.standalone) return;
    const now = Date.now();
    for (const [id, stage] of this.stages)
      if (stage.expires <= now) this.stages.delete(id);
    if (this.stages.size >= MAX_STAGES)
      this.stages.delete(this.stages.keys().next().value!);
    this.stages.set(id, { path, owner, expires: now + STAGE_TTL });
  }

  start(args: Record<string, unknown>, owner: string): HostArtifactActivationResult {
    if (!Value.Check(ActivateHostArtifactArgsSchema, args))
      throw new HostOpError(400, "invalid_request", "Invalid artifact activation request");
    const id = operationId(args.operationId);
    const { artifactId, target, sha256, runner } = args;
    if (runner && (target !== "keylime" || runner.artifactId === artifactId))
      throw new HostOpError(400, "invalid_request", "A runner requires target keylime and a separate staged artifact");
    if (!this.supported())
      throw new HostOpError(409, "artifact_activation_unsupported", "This daemon is not the supervised standalone host");
    const files = jobFiles(this.agentDir, id);
    const now = Date.now();
    const authorizedStage = (id: string) => {
      const stage = this.stages.get(id);
      if (!stage || stage.owner !== owner || stage.expires <= now)
        throw new HostOpError(404, "artifact_missing", "No authorized staged artifact; upload it again");
      return stage;
    };
    const stage = authorizedStage(artifactId);
    const runnerStage = runner ? authorizedStage(runner.artifactId) : undefined;
    try {
      publish(files.dir, files.request, {
        operationId: id, artifactId, target, sha256, owner, stagedPath: stage.path,
        ...(runnerStage ? { runner, runnerStagedPath: runnerStage.path } : {}),
        expectedPid: process.pid, startBy: Date.now() + START_TTL,
      }, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new HostOpError(409, "artifact_activation_conflict", "This operation ID has already been used");
      throw error;
    }
    void launchWorker(this.agentDir, id).catch((error: unknown) => {
      try {
        if (claim(files.claim))
          publish(files.dir, files.state, { state: "failed", error: error instanceof Error ? error.message : String(error) });
      } catch (writeError) {
        console.error("Could not record activation launch failure:", writeError);
      }
    });
    return PENDING;
  }

  status(value: unknown, owner: string): HostArtifactActivationResult {
    const id = operationId(value);
    if (!this.standalone)
      throw new HostOpError(404, "artifact_activation_missing", "No such activation operation");
    const files = jobFiles(this.agentDir, id);
    let request: Request | undefined;
    try {
      request = JSON.parse(readFileSync(files.request, "utf8")) as Request;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!request || request.owner !== owner)
      throw new HostOpError(404, "artifact_activation_missing", "No such activation operation");
    try {
      return JSON.parse(readFileSync(files.state, "utf8")) as HostArtifactActivationResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() > request.startBy && claim(files.claim)) {
      const result = { state: "failed", error: "The activation worker did not start in time" } as const;
      publish(files.dir, files.state, result);
      return result;
    }
    return PENDING;
  }
}

/** Internal one-shot entrypoint; an operation can be claimed only once. */
export async function runManagedArtifactWorker(args: string[]): Promise<number> {
  if (args.length !== 2 || !isAbsolute(args[0]) || !isManagedArtifactBinary())
    throw new Error("Expected a standalone activation worker invocation");
  const [agentDir, value] = args;
  const id = operationId(value);
  const files = jobFiles(agentDir, id);
  const request = JSON.parse(readFileSync(files.request, "utf8")) as Request;
  if (!claim(files.claim)) return 1;
  let backup: string | undefined;
  let runnerBackup: string | undefined;
  try {
    if (Date.now() > request.startBy) throw new Error("The activation worker started too late");
    const { runner, runnerStagedPath } = request;
    if (runner && !runnerStagedPath) throw new Error("Missing authorized runner path");
    await installArtifact({
      ...request,
      runner: runner && runnerStagedPath ? { stagedPath: runnerStagedPath, sha256: runner.sha256 } : undefined,
      agentDir,
      reportBackup: (path, binary) => {
        if (runner && binary === "keylime-omp") runnerBackup = path;
        else backup = path;
        publish(files.dir, files.state, { state: "pending", backup, runnerBackup });
      },
    });
  } catch (error) {
    publish(files.dir, files.state, {
      state: "failed", backup, runnerBackup, error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
  publish(files.dir, files.state, { state: "succeeded", backup, runnerBackup });
  return 0;
}
