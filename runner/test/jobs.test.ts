import { afterEach, beforeEach, expect, it } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalProjectDir,
  daemonClient,
  isolateDaemonForSmokeTest,
} from "@oh-my-pi/pi-coding-agent/daemon/client";
import { unitLogDir } from "@oh-my-pi/pi-coding-agent/daemon/paths";
import { projectScope } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { TextTap } from "@oh-my-pi/pi-coding-agent/job-widgets/text-tap";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { JobSnapshot, JobDetail } from "../../lib/jobs-types";
import { jobsCommands } from "../src/commands/jobs";
import type { CommandContext } from "../src/commands/types";
import { subscribeJobEvents } from "../src/job-events";

let restoreDaemon: () => Promise<void>;
beforeEach(async () => {
  restoreDaemon = await isolateDaemonForSmokeTest();
});
afterEach(async () => {
  await restoreDaemon();
});

it("scopes managed jobs, reads bounded live output, and cancels only the owner", async () => {
  const manager = new AsyncJobManager({});
  const tap = new TextTap("out", "output", 4);
  const pending = ({ signal }: { signal: AbortSignal }) => {
    const { promise, resolve } = Promise.withResolvers<string>();
    if (signal.aborted) resolve("cancelled");
    else
      signal.addEventListener("abort", () => resolve("cancelled"), {
        once: true,
      });
    return promise;
  };
  const id = manager.register("bash", "command", pending, {
    ownerId: "root",
    process: { command: "echo hello", cwd: "/tmp", pids: () => [42] },
    widgetInputs: { sources: () => [tap], brief: () => ({ kind: "bash" }) },
  });
  manager.register("task", "child", pending, {
    ownerId: "root",
    agentId: "child",
  });
  const child = manager.register("eval", "nested", pending, {
    ownerId: "child",
  });
  const other = manager.register("eval", "other", pending, {
    ownerId: "unrelated",
  });
  const ctx = {
    session: {
      asyncJobManager: manager,
      getAgentId: () => "root",
      sessionManager: { getCwd: () => "/nonexistent/jobs-test" },
    } as unknown as AgentSession,
    send() {},
  } satisfies CommandContext;
  try {
    const snapshot = (await jobsCommands.get_jobs(ctx, {})) as JobSnapshot;
    const token = snapshot.jobs.find((job) => job.id === id)!.incarnation;
    const childToken = snapshot.jobs.find(
      (job) => job.id === child,
    )!.incarnation;
    expect(snapshot.jobs.map((job) => job.id)).toContain(child);
    expect(snapshot.jobs.map((job) => job.id)).not.toContain(other);
    expect(snapshot.jobs.find((job) => job.id === child)?.canCancel).toBe(
      false,
    );
    await expect(
      jobsCommands.cancel_job(ctx, {
        id: child,
        incarnation: childToken,
        kind: "eval",
        generation: snapshot.generation,
      }),
    ).rejects.toThrow();
    await expect(
      jobsCommands.get_job_output(ctx, {
        id: other,
        incarnation: "not-visible",
        kind: "eval",
        generation: snapshot.generation,
      }),
    ).rejects.toThrow();
    await expect(
      jobsCommands.cancel_job(ctx, {
        id,
        kind: "bash",
        incarnation: token,
        generation: "old",
      }),
    ).rejects.toThrow();
    tap.append("abcdef");
    const first = (await jobsCommands.get_job_output(ctx, {
      id,
      incarnation: token,
      kind: "bash",
      generation: snapshot.generation,
    })) as JobDetail;
    expect(first).toMatchObject({
      output: "cdef",
      start: 2,
      cursor: 6,
      truncated: true,
      pids: [42],
    });
    tap.append("gh");
    const next = (await jobsCommands.get_job_output(ctx, {
      id,
      incarnation: token,
      kind: "bash",
      generation: snapshot.generation,
      cursor: first.cursor,
    })) as JobDetail;
    expect(next).toMatchObject({
      output: "gh",
      start: 6,
      cursor: 8,
      truncated: false,
    });
    expect(
      await jobsCommands.cancel_job(ctx, {
        id,
        incarnation: token,
        kind: "bash",
        generation: snapshot.generation,
      }),
    ).toEqual({ requested: true });
  } finally {
    manager.cancelAll();
    await manager.waitForAll();
  }
});

it("inspects and cancels a native async bash job", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keylime-bash-job-"));
  const manager = new AsyncJobManager({});
  const tool = new BashTool({
    cwd,
    hasUI: false,
    settings: Settings.isolated({ "async.enabled": true }),
    asyncJobManager: manager,
    getAgentId: () => "root",
    getSessionFile: () => null,
    getSessionSpawns: () => null,
  } satisfies ToolSession);
  const ctx = {
    session: {
      asyncJobManager: manager,
      getAgentId: () => "root",
      sessionManager: { getCwd: () => cwd },
    } as unknown as AgentSession,
    send() {},
  } satisfies CommandContext;
  try {
    const outputReady = Promise.withResolvers<void>();
    await tool.execute(
      "job-test",
      { command: "printf native-output; sleep 30", async: true },
      undefined,
      (update) => {
        if (
          update.content.some(
            (part) =>
              part.type === "text" && part.text.includes("native-output"),
          )
        )
          outputReady.resolve();
      },
    );
    await outputReady.promise;
    const snapshot = (await jobsCommands.get_jobs(ctx, {})) as JobSnapshot;
    const job = snapshot.jobs.find((job) => job.kind === "bash");
    expect(job).toBeDefined();
    const detail = (await jobsCommands.get_job_output(ctx, {
      id: job!.id,
      incarnation: job!.incarnation,
      kind: "bash",
      generation: snapshot.generation,
    })) as JobDetail;
    expect(detail.output).toContain("native-output");
    expect(
      await jobsCommands.cancel_job(ctx, {
        id: job!.id,
        incarnation: job!.incarnation,
        kind: "bash",
        generation: snapshot.generation,
      }),
    ).toEqual({ requested: true });
    await manager.waitForAll();
  } finally {
    manager.cancelAll();
    await manager.waitForAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("does not stop a replacement service sharing the old name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keylime-jobs-"));
  const manager = new AsyncJobManager({});
  const ctx = {
    session: {
      asyncJobManager: manager,
      getAgentId: () => "root",
      sessionManager: { getCwd: () => cwd },
    } as unknown as AgentSession,
    send() {},
  } satisfies CommandContext;
  try {
    const client = await daemonClient();
    const spec = {
      op: "open" as const,
      kind: "proc",
      scope: projectScope(await canonicalProjectDir(cwd)),
      key: "jobs-test",
      proc: {
        application: "/bin/sleep",
        args: ["60"],
        env: {},
        cwd,
        pty: false,
      },
      awaitReady: false,
    };
    const first = await client.request(spec);
    const snapshot = (await jobsCommands.get_jobs(ctx, {})) as JobSnapshot;
    expect(
      snapshot.services.some((service) => service.id === first.unit.id),
    ).toBe(true);
    const replacement = await client.request({ ...spec, replace: true });
    expect(replacement.unit.generation).not.toBe(first.unit.generation);
    await expect(
      jobsCommands.cancel_job(ctx, {
        kind: "service",
        id: first.unit.id,
        incarnation: first.unit.generation,
        generation: snapshot.generation,
      }),
    ).rejects.toThrow();
    const current = await client.request({
      op: "describe",
      unit: replacement.unit.id,
    });
    expect(current.unit.generation).toBe(replacement.unit.generation);
    expect(
      await jobsCommands.cancel_job(ctx, {
        kind: "service",
        id: replacement.unit.id,
        incarnation: replacement.unit.generation,
        generation: snapshot.generation,
      }),
    ).toEqual({ requested: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("rejects stale managed identities after a preferred id is reused", async () => {
  const manager = new AsyncJobManager({});
  const ctx = {
    session: {
      asyncJobManager: manager,
      getAgentId: () => "root",
      sessionManager: { getCwd: () => "/nonexistent/jobs-test" },
    } as unknown as AgentSession,
    send() {},
  } satisfies CommandContext;
  try {
    const id = manager.register("eval", "first", async () => "done", {
      id: "reused",
      ownerId: "root",
    });
    const first = (await jobsCommands.get_jobs(ctx, {})) as JobSnapshot;
    const old = first.jobs.find((job) => job.id === id)!;
    const again = (await jobsCommands.get_jobs(ctx, {})) as JobSnapshot;
    expect(again.jobs.find((job) => job.id === id)!.incarnation).toBe(
      old.incarnation,
    );
    await manager.waitForAll();
    expect(manager.evictCompletedJobs()).toBe(1);
    const replacement = manager.register(
      "eval",
      "replacement",
      ({ signal }) => {
        const { promise, resolve } = Promise.withResolvers<string>();
        if (signal.aborted) resolve("cancelled");
        else
          signal.addEventListener("abort", () => resolve("cancelled"), {
            once: true,
          });
        return promise;
      },
      { id, ownerId: "root" },
    );
    expect(replacement).toBe(id);
    const current = (await jobsCommands.get_jobs(ctx, {})) as JobSnapshot;
    const fresh = current.jobs.find((job) => job.id === id)!;
    expect(fresh.incarnation).not.toBe(old.incarnation);
    const stale = {
      id,
      kind: "eval",
      incarnation: old.incarnation,
      generation: first.generation,
    };
    await expect(jobsCommands.get_job_output(ctx, stale)).rejects.toThrow();
    await expect(jobsCommands.cancel_job(ctx, stale)).rejects.toThrow();
    await expect(
      jobsCommands.get_job_output(ctx, {
        id,
        kind: "eval",
        generation: first.generation,
      }),
    ).rejects.toThrow();
    await expect(
      jobsCommands.cancel_job(ctx, {
        id,
        kind: "eval",
        generation: first.generation,
      }),
    ).rejects.toThrow();
    expect(manager.getAllJobs().find((job) => job.id === id)?.status).toBe(
      "running",
    );
    const detail = (await jobsCommands.get_job_output(ctx, {
      ...stale,
      incarnation: fresh.incarnation,
    })) as JobDetail;
    expect(detail.incarnation).toBe(fresh.incarnation);
  } finally {
    manager.cancelAll();
    await manager.waitForAll();
  }
});

it("invalidates on job lifecycle, progress, and service output without leaking content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keylime-job-events-"));
  const manager = new AsyncJobManager({});
  const session = {
    asyncJobManager: manager,
    getAgentId: () => "root",
    sessionManager: { getCwd: () => cwd },
  } as unknown as AgentSession;
  const ctx = { session, send() {} } satisfies CommandContext;
  let changed = Promise.withResolvers<void>();
  const payloads: unknown[][] = [];
  const unsubscribe = subscribeJobEvents(session, (...args: unknown[]) => {
    payloads.push(args);
    changed.resolve();
  });
  const completion = Promise.withResolvers<string>();
  const progress = Promise.withResolvers<(text: string) => Promise<void>>();
  try {
    manager.register(
      "task",
      "private label",
      async ({ reportProgress }) => {
        progress.resolve(reportProgress);
        return completion.promise;
      },
      { ownerId: "root" },
    );
    await changed.promise;
    changed = Promise.withResolvers<void>();
    await (
      await progress.promise
    )("private output");
    await changed.promise;
    changed = Promise.withResolvers<void>();
    completion.resolve("finished");
    await manager.waitForAll();
    await changed.promise;

    await jobsCommands.get_jobs(ctx, {});
    const client = await daemonClient();
    const scope = projectScope(await canonicalProjectDir(cwd));
    const service = await client.request({
      op: "open",
      kind: "proc",
      scope,
      key: "service",
      proc: {
        application: "/bin/sh",
        args: ["-c", "sleep 60"],
        env: {},
        cwd,
        pty: false,
      },
      awaitReady: true,
    });
    await jobsCommands.get_jobs(ctx, {});
    changed = Promise.withResolvers<void>();
    await appendFile(
      join(unitLogDir(service.unit.id), "output.log"),
      "private service output\n",
    );
    await changed.promise;
    changed = Promise.withResolvers<void>();
    await client.request({
      op: "stop",
      unit: service.unit.id,
      timeoutMs: 5000,
    });
    await changed.promise;
    expect(payloads.every((args) => args.length === 0)).toBe(true);
    unsubscribe();
  } finally {
    unsubscribe();
    completion.resolve("finished");
    manager.cancelAll();
    await manager.waitForAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("reports service truncation from captured log windows, not raw byte counts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keylime-job-logs-"));
  const manager = new AsyncJobManager({});
  const ctx = {
    session: {
      asyncJobManager: manager,
      getAgentId: () => "root",
      sessionManager: { getCwd: () => cwd },
    } as unknown as AgentSession,
    send() {},
  } satisfies CommandContext;
  try {
    const client = await daemonClient();
    const scope = projectScope(await canonicalProjectDir(cwd));
    for (const [name, command, truncated] of [
      ["short", "printf '\\033[31mred\\033[0m\\001done\\n'; sleep 60", false],
      [
        "long",
        "i=0; while [ $i -lt 1200 ]; do echo repeated-line; i=$((i+1)); done; echo END-MARKER; sleep 60",
        true,
      ],
    ] as const) {
      const started = await client.request({
        op: "open",
        kind: "proc",
        scope,
        key: name,
        proc: {
          application: "/bin/sh",
          args: ["-c", command],
          env: {},
          cwd,
          pty: false,
        },
        awaitReady: false,
      });
      let cursor = 0;
      for (;;) {
        const logs = await client.request({
          op: "logs",
          unit: started.unit.id,
          lines: 1000,
          head: false,
          follow: true,
          cursor,
          timeoutMs: 5000,
        });
        if (logs.text.includes(name === "short" ? "done" : "END-MARKER")) break;
        if (logs.cursor === cursor) throw new Error("Service output timed out");
        cursor = logs.cursor;
      }
      const snapshot = (await jobsCommands.get_jobs(ctx, {})) as JobSnapshot;
      const service = snapshot.services.find(
        (job) => job.id === started.unit.id,
      )!;
      expect(service.incarnation).toBe(started.unit.generation);
      const detail = (await jobsCommands.get_job_output(ctx, {
        id: service.id,
        kind: "service",
        incarnation: service.incarnation,
        generation: snapshot.generation,
      })) as JobDetail;
      expect(detail.truncated).toBe(truncated);
      expect(detail.output).toContain(name === "short" ? "done" : "END-MARKER");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
