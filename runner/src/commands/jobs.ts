import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { truncateTail } from "@oh-my-pi/pi-tui/tools/streaming-output";
import {
  canonicalProjectDir,
  daemonRuntimeDir,
} from "@oh-my-pi/pi-coding-agent/launch/paths";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type {
  JobActivity,
  JobDetail,
  JobSnapshot,
} from "../../../lib/jobs-types";
import { CommandError, type CommandContext, type CommandTable } from "./types";

// A runner's identities must never be accepted by a replacement process.
const generation = randomUUID();
const incarnations = new WeakMap<AsyncJob, string>();
function incarnation(job: AsyncJob): string {
  let token = incarnations.get(job);
  if (!token) {
    token = randomUUID();
    incarnations.set(job, token);
  }
  return token;
}
const OUTPUT_LIMIT = 256 * 1024;
const LOG_READ_LIMIT = 2 * 1024 * 1024;

async function serviceOutput(
  cwd: string,
  name: string,
): Promise<{ output: string; truncated: boolean }> {
  const dir = join(
    daemonRuntimeDir(await canonicalProjectDir(cwd)),
    "daemons",
    name,
  );
  const handles: (FileHandle | undefined)[] = [];
  try {
    for (const file of ["output.previous.log", "output.log"]) {
      try {
        handles.push(await open(join(dir, file), "r"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        handles.push(undefined);
      }
    }
    const stats = await Promise.all(handles.map((handle) => handle?.stat()));
    // Rotation can expose the same inode under both names while the handles open.
    if (
      stats[0] &&
      stats[1] &&
      stats[0].dev === stats[1].dev &&
      stats[0].ino === stats[1].ino
    ) {
      stats[0] = undefined;
    }
    let remaining = LOG_READ_LIMIT;
    const parts = ["", ""];
    let omitted = false;
    for (let i = 1; i >= 0; i--) {
      const handle = handles[i];
      const size = stats[i]?.size ?? 0;
      if (!handle || !size) continue;
      const length = Math.min(size, remaining);
      omitted ||= length < size;
      if (!length) continue;
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(
          buffer,
          read,
          length - read,
          size - length + read,
        );
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      parts[i] = buffer.subarray(0, read).toString("utf8");
      remaining -= read;
    }
    const text =
      parts[0] +
      (parts[0] && parts[1] && !parts[0].endsWith("\n") ? "\n" : "") +
      parts[1];
    const tail = truncateTail(sanitizeText(text), {
      maxLines: 1000,
      maxBytes: OUTPUT_LIMIT,
    });
    const output = tail.content.slice(-OUTPUT_LIMIT);
    return {
      output,
      truncated:
        omitted || !!tail.truncated || output.length < tail.content.length,
    };
  } finally {
    await Promise.all(handles.map((handle) => handle?.close()));
  }
}
const active = (status: string) =>
  !["exited", "failed", "completed", "cancelled"].includes(status);

function scopedJobs(
  ctx: CommandContext,
): { jobs: AsyncJob[]; root: string | undefined } | null {
  const manager = ctx.session.asyncJobManager;
  if (!manager) return null;
  const root = ctx.session.getAgentId();
  const jobs = manager.getAllJobs();
  const parents = new Map<string, string>();
  for (const job of jobs)
    if (job.agentId && job.ownerId) parents.set(job.agentId, job.ownerId);
  for (const ref of AgentRegistry.global().list())
    if (ref.parentId) parents.set(ref.id, ref.parentId);
  return {
    root,
    jobs: jobs.filter((job) => {
      if (!root) return true;
      const seen = new Set<string>();
      for (let id = job.ownerId; id && !seen.has(id); id = parents.get(id)) {
        if (id === root) return true;
        seen.add(id);
      }
      return false;
    }),
  };
}

function activity(job: AsyncJob, root: string | undefined): JobActivity {
  return {
    id: job.id,
    incarnation: incarnation(job),
    kind: job.type,
    status: job.queued ? "queued" : job.status,
    label: job.intent || job.label,
    command: job.process?.command,
    ownerId: job.ownerId,
    agentId: job.agentId,
    startTime: job.startTime,
    endTime: job.endTime,
    canCancel: job.status === "running" && job.ownerId === root,
  };
}

function serviceActivity(daemon: DaemonSnapshot): JobActivity {
  return {
    id: daemon.id,
    incarnation: daemon.id,
    kind: "service",
    status: daemon.state,
    label: daemon.name,
    ownerId: daemon.owner,
    startTime: daemon.startedAt || daemon.createdAt,
    endTime: daemon.exitedAt,
    canCancel: active(daemon.state),
  };
}

function parseArgs(args: Record<string, unknown>): {
  id: string;
  incarnation: string;
  kind: JobActivity["kind"];
  cursor: number;
} {
  if (args.generation !== generation)
    throw new CommandError("Job generation is stale", "stale_generation");
  if (
    typeof args.id !== "string" ||
    !args.id ||
    typeof args.incarnation !== "string" ||
    !args.incarnation ||
    !["bash", "task", "eval", "service"].includes(args.kind as string)
  )
    throw new CommandError("Invalid job identity", "invalid_args");
  if (
    args.cursor !== undefined &&
    (typeof args.cursor !== "number" ||
      !Number.isSafeInteger(args.cursor) ||
      args.cursor < 0)
  )
    throw new CommandError("Invalid output cursor", "invalid_args");
  return {
    id: args.id,
    incarnation: args.incarnation as string,
    kind: args.kind as JobActivity["kind"],
    cursor: (args.cursor as number | undefined) ?? 0,
  };
}

function findJob(
  ctx: CommandContext,
  id: string,
  kind: JobActivity["kind"],
  token: string,
): { job: AsyncJob; root: string | undefined } {
  const scope = scopedJobs(ctx);
  const job = scope?.jobs.find((job) => job.id === id && job.type === kind);
  if (!job || !scope) throw new CommandError("Job not found", "job_not_found");
  if (incarnation(job) !== token)
    throw new CommandError("Job replaced", "stale_generation");
  return { job, root: scope.root };
}

async function service(ctx: CommandContext, id: string) {
  const client = await daemonClientForProject(
    ctx.session.sessionManager.getCwd(),
  );
  const list = await client.request({ op: "list" });
  if (list.op !== "list") throw new Error("Unexpected service list response");
  const daemon = list.daemons.find((item) => item.id === id);
  if (!daemon) throw new CommandError("Service not found", "job_not_found");
  return { client, daemon };
}

/** Jobs are scoped to the current session. Snapshot generation and incarnation tokens fence
 * output and cancellation against a restarted runner or a replaced job; cancellation is only a request. */
export const jobsCommands: CommandTable = {
  /** @apiCommand get_jobs */
  async get_jobs(ctx): Promise<JobSnapshot> {
    const scope = scopedJobs(ctx);
    const snapshot: JobSnapshot = {
      generation,
      available: !!scope,
      jobs: scope?.jobs.map((job) => activity(job, scope.root)) ?? [],
      services: [],
    };
    try {
      const client = await daemonClientForProject(
        ctx.session.sessionManager.getCwd(),
      );
      const result = await client.request({ op: "list" });
      if (result.op !== "list")
        throw new Error("Unexpected service list response");
      snapshot.services = result.daemons.map(serviceActivity);
    } catch (error) {
      snapshot.servicesError =
        error instanceof Error ? error.message : String(error);
    }
    return snapshot;
  },
  /** @apiCommand get_job_output */
  async get_job_output(ctx, args): Promise<JobDetail> {
    const { id, kind, incarnation: token, cursor } = parseArgs(args);
    if (kind === "service") {
      if (token !== id)
        throw new CommandError("Service replaced", "stale_generation");
      const { client, daemon } = await service(ctx, id);
      const description = await client.request({
        op: "describe",
        name: daemon.name,
      });
      if (description.op !== "describe" || description.daemon.id !== id)
        throw new CommandError("Service replaced", "stale_generation");
      const { output, truncated } = await serviceOutput(
        ctx.session.sessionManager.getCwd(),
        daemon.name,
      );
      const check = await client.request({ op: "describe", name: daemon.name });
      if (check.op !== "describe" || check.daemon.id !== id)
        throw new CommandError("Service replaced", "stale_generation");
      return {
        id,
        incarnation: token,
        kind,
        generation,
        command: [description.spec.application, ...description.spec.args].join(
          " ",
        ),
        cwd: description.spec.cwd,
        pids:
          check.daemon.pid && active(check.daemon.state)
            ? [check.daemon.pid]
            : [],
        exitCode: check.daemon.exitCode,
        output,
        start: 0,
        cursor: output.length,
        open: active(check.daemon.state),
        truncated,
      };
    }
    const { job } = findJob(ctx, id, kind, token);
    const source =
      kind === "bash"
        ? job.widgetInputs?.sources().find((source) => source.id === "out")
        : undefined;
    let output: string,
      start: number,
      end: number,
      open: boolean,
      truncated: boolean;
    if (source) {
      const chunk = source.read(cursor);
      output = chunk.text;
      start = chunk.start;
      end = chunk.end;
      open = chunk.open;
      truncated = chunk.start > cursor || (cursor === 0 && chunk.start > 0);
    } else {
      const text =
        job.status === "running"
          ? (job.progressText ?? "")
          : (job.resultText ?? job.errorText ?? job.progressText ?? "");
      output = text.slice(-OUTPUT_LIMIT);
      start = 0;
      end = output.length;
      open = job.status === "running";
      truncated = text.length > output.length;
    }
    const reported = job.latestDetails?.exitCode;
    return {
      id,
      incarnation: token,
      kind,
      generation,
      command: job.process?.command,
      cwd: job.process?.cwd,
      pids: job.status === "running" ? [...(job.process?.pids() ?? [])] : [],
      exitCode:
        typeof reported === "number"
          ? reported
          : kind === "bash" && job.status === "completed"
            ? 0
            : undefined,
      output,
      start,
      cursor: end,
      open,
      truncated,
    };
  },
  /** @apiCommand cancel_job */
  async cancel_job(ctx, args): Promise<{ requested: boolean }> {
    const { id, kind, incarnation: token } = parseArgs(args);
    if (kind === "service") {
      if (token !== id)
        throw new CommandError("Service replaced", "stale_generation");
      const { client, daemon } = await service(ctx, id);
      if (!active(daemon.state)) return { requested: false };
      const result = await client.request({
        op: "stop",
        name: daemon.name,
        id,
        timeoutMs: 5000,
      });
      if (result.op !== "stop" || result.daemon.id !== id)
        throw new CommandError("Service replaced", "stale_generation");
      return { requested: true };
    }
    const { job, root } = findJob(ctx, id, kind, token);
    if (job.ownerId !== root)
      throw new CommandError("Job belongs to another agent", "forbidden");
    return {
      requested: ctx.session.asyncJobManager!.cancel(id, { ownerId: root }),
    };
  },
};
