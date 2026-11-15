import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { TextTap } from "@oh-my-pi/pi-coding-agent/job-widgets/text-tap";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { JobSnapshot, JobDetail } from "../../lib/jobs-types";
import { jobsCommands } from "../src/commands/jobs";
import type { CommandContext } from "../src/commands/types";

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
  const cwd = await mkdtemp(join(tmpdir(), "ompweb-bash-job-"));
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
  const cwd = await mkdtemp(join(tmpdir(), "ompweb-jobs-"));
  const manager = new AsyncJobManager({});
  const ctx = {
    session: {
      asyncJobManager: manager,
      getAgentId: () => "root",
      sessionManager: { getCwd: () => cwd },
    } as unknown as AgentSession,
    send() {},
  } satisfies CommandContext;
  const client = await daemonClientForProject(cwd);
  try {
    const spec = {
      name: "jobs-test",
      application: "/bin/sleep",
      args: ["60"],
      env: {},
      cwd,
      pty: false,
      restart: "no" as const,
      persist: false,
      detached: false,
    };
    const first = await client.request({
      op: "start",
      spec,
      awaitReady: false,
    });
    if (first.op !== "start") throw new Error("Unexpected start result");
    const snapshot = (await jobsCommands.get_jobs(ctx, {})) as JobSnapshot;
    expect(
      snapshot.services.some((service) => service.id === first.daemon.id),
    ).toBe(true);
    const replacement = await client.request({
      op: "start",
      spec,
      replace: true,
      awaitReady: false,
    });
    if (replacement.op !== "start") throw new Error("Unexpected start result");
    expect(replacement.daemon.id).not.toBe(first.daemon.id);
    await expect(
      jobsCommands.cancel_job(ctx, {
        kind: "service",
        id: first.daemon.id,
        incarnation: first.daemon.id,
        generation: snapshot.generation,
      }),
    ).rejects.toThrow();
    const current = await client.request({ op: "describe", name: spec.name });
    expect(current.op === "describe" && current.daemon.id).toBe(
      replacement.daemon.id,
    );
    expect(
      await jobsCommands.cancel_job(ctx, {
        kind: "service",
        id: replacement.daemon.id,
        incarnation: replacement.daemon.id,
        generation: snapshot.generation,
      }),
    ).toEqual({ requested: true });
  } finally {
    await client.request({ op: "shutdown" }).catch(() => {});
    client.close();
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

it("reports service truncation from captured log windows, not raw byte counts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ompweb-job-logs-"));
  const manager = new AsyncJobManager({});
  const ctx = {
    session: {
      asyncJobManager: manager,
      getAgentId: () => "root",
      sessionManager: { getCwd: () => cwd },
    } as unknown as AgentSession,
    send() {},
  } satisfies CommandContext;
  const client = await daemonClientForProject(cwd);
  try {
    for (const [name, command, truncated] of [
      ["short", "printf '\\033[31mred\\033[0m\\001done\\n'; sleep 60", false],
      [
        "long",
        "i=0; while [ $i -lt 1200 ]; do echo repeated-line; i=$((i+1)); done; echo END-MARKER; sleep 60",
        true,
      ],
    ] as const) {
      const started = await client.request({
        op: "start",
        spec: {
          name,
          application: "/bin/sh",
          args: ["-c", command],
          env: {},
          cwd,
          pty: false,
          restart: "no",
          persist: false,
          detached: false,
        },
        awaitReady: false,
      });
      if (started.op !== "start") throw new Error("Unexpected start result");
      let cursor = 0;
      for (;;) {
        const logs = await client.request({
          op: "logs",
          name,
          lines: 1000,
          head: false,
          follow: true,
          cursor,
          timeoutMs: 5000,
        });
        if (logs.op !== "logs") throw new Error("Unexpected logs result");
        if (logs.text.includes(name === "short" ? "done" : "END-MARKER")) break;
        if (logs.timedOut) throw new Error("Service output timed out");
        cursor = logs.cursor;
      }
      const snapshot = (await jobsCommands.get_jobs(ctx, {})) as JobSnapshot;
      const service = snapshot.services.find(
        (job) => job.id === started.daemon.id,
      )!;
      expect(service.incarnation).toBe(service.id);
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
    await client.request({ op: "shutdown" }).catch(() => {});
    client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
