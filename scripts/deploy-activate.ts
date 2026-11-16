import {
  existsSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import {
  requestHostControl,
  type HostControlCommand,
  type HostControlStatus,
} from "../lib/hosts/host-control";
import { waitForIdleDrain } from "./deploy-wait";
import { prepareFrontend, selectFrontend } from "./deploy-frontend";

type ServiceStatus = { status: string; pid?: number };
type Options = {
  candidate: string;
  base: string;
  agent: string;
  home: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onPhase: (phase: string, details?: Record<string, unknown>) => void;
};

/** Injectable side effects keep the transaction independent of its launcher. */
export type ActivationDependencies = {
  preflight: (candidate: string) => void;
  previous: () => string;
  run: (command: string[]) => void;
  control: (command: HostControlCommand) => Promise<HostControlStatus>;
  status: (service: string) => ServiceStatus;
  children: (pid: number) => string[];
  select: (target: string) => void;
  readiness: () => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

function defaults({
  candidate,
  base,
  agent,
  home,
  env,
}: Options): ActivationDependencies {
  const run = (command: string[], capture = false) => {
    const result = Bun.spawnSync(command, {
      cwd: home,
      env,
      stdin: "ignore",
      stdout: capture ? "pipe" : "inherit",
      stderr: capture ? "pipe" : "inherit",
      timeout: 30_000,
    });
    if (capture && (!result.stdout || !result.stderr))
      throw new Error("Missing captured command output");
    if (result.exitCode !== 0 || result.signalCode)
      throw new Error(
        `Command failed: ${command.join(" ")}${capture ? `: ${result.stderr?.toString()}` : ""}`,
      );
    return capture ? result.stdout!.toString().trim() : "";
  };
  const status = (service: string): ServiceStatus =>
    JSON.parse(
      run(["pitchfork", "status", `global/${service}`, "--json"], true),
    );
  let previousFrontend: string | undefined;
  return {
    preflight: () => {
      if (!existsSync(path.join(candidate, "keylime-release.json")))
        throw new Error("Not a Keylime release directory");
      const result = Bun.spawnSync(
        [path.join(candidate, "keylime"), "preflight"],
        {
          cwd: home,
          env: { ...env, PI_CODING_AGENT_DIR: agent },
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          timeout: 30_000,
        },
      );
      if (result.exitCode !== 0 || result.signalCode)
        throw new Error("Candidate preflight failed");
    },
    previous: () => realpathSync(path.join(base, "current")),
    run: (command) => {
      run(command);
    },
    control: (command) => requestHostControl(command, agent),
    status,
    children: (pid) =>
      run(["ps", "-axo", "pid=,ppid=,command="], true)
        .split("\n")
        .filter((line) => Number(line.trim().split(/\s+/)[1]) === pid),
    select: (target) => {
      const pointer = path.join(base, "frontend-current");
      const isCandidate = target === candidate;
      if (isCandidate) {
        previousFrontend = existsSync(pointer)
          ? realpathSync(pointer)
          : realpathSync(path.join(base, "current"));
        prepareFrontend(candidate, previousFrontend);
      }
      const frontend = isCandidate ? candidate : previousFrontend;
      const tmp = path.join(base, `current-${process.pid}`);
      try {
        if (frontend) selectFrontend(base, frontend);
        symlinkSync(target, tmp);
        renameSync(tmp, path.join(base, "current"));
      } catch (error) {
        if (isCandidate && previousFrontend)
          selectFrontend(base, previousFrontend);
        throw error;
      } finally {
        rmSync(tmp, { force: true });
      }
    },
    readiness: async () => {
      const response = await fetch("http://127.0.0.1:8080/", {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      return [200, 302, 303, 307].includes(response.status);
    },
    now: () => performance.now(),
    sleep: (ms) => Bun.sleep(ms),
  };
}

export async function activateRelease(
  options: Options,
  injected?: ActivationDependencies,
): Promise<{ previous: string }> {
  const { candidate, onPhase } = options;
  const d = injected ?? defaults(options);
  d.preflight(candidate);
  const previous = d.previous();
  const host = d.status("keylime-host");
  if (host.status !== "running" || !host.pid)
    throw new Error("Production host must be running to prove it is idle");
  const hostPid = host.pid;
  let drained = false;
  let webStopped = false;
  let hostStopped = false;
  let selected = false;
  let admitted = false;
  const sameHost = () => {
    const current = d.status("keylime-host");
    if (current.status !== "running" || current.pid !== hostPid)
      throw new Error("Production host changed during activation");
  };
  const invalid = (error: unknown) =>
    error instanceof Error && error.message === "Invalid host control command";
  try {
    const idle = await waitForIdleDrain(
      async (deadline) => {
        sameHost();
        let reply: HostControlStatus;
        try {
          reply = await d.control("drain-idle");
        } catch (error) {
          if (invalid(error))
            throw Object.assign(
              new Error("Running daemon needs a maintenance upgrade"),
              { code: "host_busy" },
            );
          throw error;
        }
        if (reply.pid !== hostPid || !reply.drained)
          throw new Error("Production host did not confirm maintenance drain");
        drained = true;
        while (d.children(hostPid).length) {
          if (d.now() >= deadline)
            throw Object.assign(
              new Error("Idle session processes did not exit"),
              { code: "host_busy" },
            );
          await d.sleep(Math.min(100, deadline - d.now()));
        }
      },
      { now: d.now, sleep: d.sleep, timeoutMs: options.timeoutMs },
    );
    onPhase("stop-web", { forced: !idle });
    webStopped = true;
    d.run(["pitchfork", "stop", "global/keylime"]);
    if (!idle) {
      try {
        const reply = await d.control("drain-force");
        if (reply.pid !== hostPid || !reply.drained)
          throw new Error("Production host changed during forced drain");
        drained = true;
      } catch (error) {
        if (!invalid(error)) throw error;
      }
    }
    sameHost();
    onPhase("stop-host");
    hostStopped = true;
    d.run(["pitchfork", "stop", "global/keylime-host"]);
    drained = false;
    onPhase("select", { candidate, previous });
    d.select(candidate);
    selected = true;
    onPhase("start-web");
    // A failed start can still have opened admission; never roll back after attempting it.
    admitted = true;
    d.run(["pitchfork", "start", "global/keylime"]);
    webStopped = false;
    onPhase("start-host");
    d.run(["pitchfork", "start", "global/keylime-host"]);
    hostStopped = false;
    onPhase("verify");
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const web = d.status("keylime");
        const currentHost = d.status("keylime-host");
        if (
          web.status === "running" &&
          currentHost.status === "running" &&
          currentHost.pid &&
          (await d.readiness())
        ) {
          const control = await d.control("status");
          if (
            control.pid === currentHost.pid &&
            control.linked &&
            !control.drained
          ) {
            ready = true;
            break;
          }
        }
      } catch {
        /* Services may still be starting. */
      }
      if (attempt < 29) await d.sleep(1000);
    }
    if (!ready)
      throw new Error(
        "Production readiness failed; inspect Pitchfork logs. No automatic rollback after admission reopens.",
      );
    onPhase("complete", { candidate, previous });
    return { previous };
  } catch (error) {
    const failures: unknown[] = [];
    const attempt = async (action: () => unknown) => {
      try {
        await action();
      } catch (failure) {
        failures.push(failure);
      }
    };
    if (!admitted) {
      if (drained && !hostStopped) await attempt(() => d.control("resume"));
      if (selected) await attempt(() => d.select(previous));
    }
    // Both starts are attempted independently even when one fails.
    if (webStopped)
      await attempt(() => d.run(["pitchfork", "start", "global/keylime"]));
    if (hostStopped)
      await attempt(() => d.run(["pitchfork", "start", "global/keylime-host"]));
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Activation failed and recovery encountered errors",
      );
    throw error;
  }
}
