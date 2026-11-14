import { expect, test } from "bun:test";
import {
  activateRelease,
  type ActivationDependencies,
} from "./deploy-activate";
import type { HostControlStatus } from "../lib/hosts/host-control";

function fixture() {
  const phases: string[] = [];
  const calls: string[] = [];
  let clock = 0;
  let selected = "old";
  let busy = false;
  let legacy = false;
  let failure = "";
  const reply: HostControlStatus = {
    pid: 42,
    version: "1",
    protocol: 1,
    linked: true,
    drained: false,
    executable: "",
    entrypoint: "",
  };
  const deps: ActivationDependencies = {
    preflight: () => {
      calls.push("preflight");
    },
    previous: () => selected,
    run: (command) => {
      const operation = `${command[1]}:${command[2]}`;
      calls.push(operation);
      if (operation === failure) {
        failure = "";
        throw new Error("injected failure");
      }
    },
    control: async (command) => {
      calls.push(command);
      if (legacy && (command === "drain-idle" || command === "drain-force"))
        throw new Error("Invalid host control command");
      if (busy && command === "drain-idle")
        throw Object.assign(new Error("busy"), { code: "host_busy" });
      return {
        ...reply,
        drained: command === "drain-idle" || command === "drain-force",
      };
    },
    status: () => ({ status: "running", pid: 42 }),
    children: () => [],
    backup: () => {
      calls.push("backup");
      return "backup";
    },
    select: (target) => {
      calls.push(`select:${target}`);
      selected = target;
    },
    readiness: async () => true,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const options = {
    candidate: "new",
    base: "/base",
    agent: "/agent",
    home: "/home",
    env: {},
    onPhase: (phase: string) => {
      phases.push(phase);
    },
  };
  return {
    deps,
    options,
    calls,
    phases,
    clock: () => clock,
    selected: () => selected,
    setBusy: () => {
      busy = true;
    },
    setLegacy: () => {
      legacy = true;
    },
    fail: (operation: string) => {
      failure = operation;
    },
  };
}

test("activation reports each mutation before it happens and checks both services", async () => {
  const f = fixture();
  const result = await activateRelease(f.options, f.deps);
  expect(result).toEqual({ previous: "old", backup: "backup" });
  expect(f.phases).toEqual([
    "stop-web",
    "stop-host",
    "backup",
    "select",
    "start-web",
    "start-host",
    "verify",
    "complete",
  ]);
  expect(f.calls).toEqual([
    "preflight",
    "drain-idle",
    "stop:global/ompweb",
    "stop:global/ompweb-host",
    "backup",
    "select:new",
    "start:global/ompweb",
    "start:global/ompweb-host",
    "status",
  ]);
});

test("failure before admission restores the old release and restarts both services", async () => {
  const f = fixture();
  f.options.onPhase = (phase) => {
    f.phases.push(phase);
    if (phase === "start-web") throw new Error("reporter failure");
  };
  await expect(activateRelease(f.options, f.deps)).rejects.toThrow(
    "reporter failure",
  );
  expect(f.selected()).toBe("old");
  expect(f.calls.slice(-3)).toEqual([
    "select:old",
    "start:global/ompweb",
    "start:global/ompweb-host",
  ]);
});

test("a failed host stop still attempts to restart both services", async () => {
  const f = fixture();
  f.fail("stop:global/ompweb-host");
  await expect(activateRelease(f.options, f.deps)).rejects.toThrow(
    "injected failure",
  );
  expect(f.calls.slice(-2)).toEqual([
    "start:global/ompweb",
    "start:global/ompweb-host",
  ]);
});

test("configured grace forces cutover after ten seconds", async () => {
  const f = fixture();
  f.setBusy();
  await activateRelease({ ...f.options, timeoutMs: 10_000 }, f.deps);
  expect(f.clock()).toBe(10_000);
  expect(f.calls).toContain("drain-force");
});

test("busy and legacy daemons receive the full grace before forced cutover", async () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    if (legacy) f.setLegacy();
    else f.setBusy();
    await activateRelease(f.options, f.deps);
    expect(f.clock()).toBe(60_000);
    expect(f.calls.indexOf("drain-force")).toBeGreaterThan(
      f.calls.indexOf("stop:global/ompweb"),
    );
    expect(f.calls.indexOf("drain-force")).toBeLessThan(
      f.calls.indexOf("stop:global/ompweb-host"),
    );
  }
});

test("failure after web start retains candidate and attempts both candidate services", async () => {
  const f = fixture();
  f.fail("start:global/ompweb");
  await expect(activateRelease(f.options, f.deps)).rejects.toThrow(
    "injected failure",
  );
  expect(f.selected()).toBe("new");
  expect(f.calls.slice(-2)).toEqual([
    "start:global/ompweb",
    "start:global/ompweb-host",
  ]);
});

test("readiness failure does not roll back an admitted candidate", async () => {
  const f = fixture();
  f.deps.readiness = async () => false;
  await expect(activateRelease(f.options, f.deps)).rejects.toThrow(
    "readiness failed",
  );
  expect(f.selected()).toBe("new");
  expect(f.phases.at(-1)).toBe("verify");
});
