import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Value } from "@sinclair/typebox/value";
import type {
  PlanningBoard,
  PlanningHttpInput,
  PlanningLaunch,
  PlanningOperation,
  PlanningOwner,
  PlanningResult,
} from "./api-contracts/planning";
import { LiteralPromptReceiptSchema } from "./api-contracts/runner-lifecycle";
import { workspaceBaseRefPattern } from "./api-contracts/workspace-models";
import { isLinkUp, type Host } from "./hosts/host";
import { HostOpError } from "./hosts/link-protocol";
import { RpcCommandError } from "./omp/rpc-process";
import { startNewRpcSession, WebRpcError } from "./rpc-manager";

type Input = Extract<
  PlanningHttpInput,
  { action: "launch" | "resume" | "refresh" }
>;
type Setup = NonNullable<PlanningLaunch["setup"]>;
declare global {
  var __keylimePlanningWorkers: Set<string> | undefined;
}
const workers = (globalThis.__keylimePlanningWorkers ??= new Set());
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const hasCode = (error: unknown, code: string) =>
  error instanceof HostOpError && error.code === code;

function unwrap<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; status: number; code: string; error: string },
): T {
  if (!result.ok)
    throw new HostOpError(result.status, result.code, result.error);
  return result.value;
}

async function planSetup(
  host: Host,
  owner: PlanningOwner,
  board: PlanningBoard,
  task: PlanningBoard["tasks"][number],
  review: Extract<Input, { action: "launch" }>["review"],
  id: string,
  prior?: Extract<Setup, { kind: "system" }>,
): Promise<Setup | PlanningResult> {
  const ops = host.workspaceOps;
  if (owner.kind === "repo") {
    const { projects } = unwrap(await ops.hierarchy({ action: "list" }));
    const repo = projects.find((project) => project.id === owner.id);
    if (!repo) throw new HostOpError(404, "repo_not_found", "Repo not found");
    const branches = unwrap(await ops.workspaceBranches(repo.path));
    const confirmation = createHash("sha256")
      .update(
        JSON.stringify([
          host.id,
          owner.id,
          repo.path,
          task.id,
          task.revision,
          branches.defaultRef,
        ]),
      )
      .digest("hex");
    const baseRef = review?.baseRef ?? branches.defaultRef;
    if (
      (!branches.defaultRef || review) &&
      (!workspaceBaseRefPattern.test(baseRef) ||
        review?.confirmation !== confirmation)
    )
      return {
        board,
        review: {
          name: task.brief,
          confirmation,
          repo: { branches, baseRef: branches.defaultRef },
        },
      };
    return {
      kind: "repo",
      projectPath: repo.path,
      baseRef,
      branch: `plan-${id}`,
    };
  }
  const name =
    prior?.name ??
    task.brief
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 120)
      .trim();
  const preview = unwrap(
    await ops.systems({
      action: "preview",
      systemId: owner.id,
      name,
      bases: review?.bases,
      allowUnresolved: true,
      branchKey: task.id,
    }),
  ).preview;
  if (!preview)
    throw new HostOpError(
      502,
      "missing_effort_preview",
      "Host did not return an Effort preview",
    );
  if (
    preview.members.some((member) => !member.baseCommit) ||
    ((prior ||
      review ||
      preview.members.some((member) => member.skipsCustomCreate)) &&
      review?.confirmation !== preview.confirmation)
  )
    return {
      board,
      review: {
        name: preview.name,
        confirmation: preview.confirmation,
        effort: preview,
      },
    };
  return {
    kind: "system",
    name,
    confirmation: preview.confirmation,
    bases: preview.members.map(({ repoPath, baseRef }) => ({
      repoPath,
      ref: baseRef,
    })),
  };
}

export async function runPlanningLaunch(
  host: Host,
  owner: PlanningOwner,
  input: Input,
): Promise<PlanningResult> {
  const op = (command: PlanningOperation["input"]) =>
    host.workspaceOps.planning({ owner, input: command });
  const taskId = input.taskId;
  const read = () => op({ action: "read" });
  const taskIn = (board: PlanningBoard) => {
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    if (!task)
      throw new HostOpError(404, "task_not_found", "Planned task not found");
    return task;
  };
  let board = await read();
  const task = taskIn(board);
  let launch = task.launch;
  const update = async (
    expected: PlanningLaunch,
    change: Partial<PlanningLaunch>,
  ) => {
    const next = { ...expected, ...change, version: expected.version + 1 };
    for (const key of ["error", "sendingSince", "retrySetup"] as const)
      if (next[key] === undefined) delete next[key];
    return op({ action: "updateLaunch", taskId, expected, next });
  };
  if (input.action === "launch") {
    if (launch || task.revision !== input.revision)
      throw new HostOpError(
        409,
        launch ? "launch_conflict" : "revision_conflict",
        "This task has changed; reload the board",
      );
    if (!board.canLaunch)
      throw new HostOpError(
        400,
        "launch_unavailable",
        "This owner cannot launch tasks",
      );
    const id = randomUUID();
    const setup = await planSetup(host, owner, board, task, input.review, id);
    if (!("kind" in setup)) return setup;
    board = await op({
      action: "begin",
      taskId,
      id,
      revision: input.revision,
      setup,
    });
    launch = taskIn(board).launch;
  }
  if (!launch) return { board };
  const key = JSON.stringify([host.id, owner.kind, owner.id, launch.id]);
  if (workers.has(key)) return { board };
  if (launch.phase === "sending") {
    if (
      launch.sendingSince !== undefined &&
      Date.now() - launch.sendingSince < 5 * 60_000
    )
      return { board };
    // The preceding process did not record an acknowledgement. Never resend.
    try {
      return {
        board: await update(launch, {
          phase: "delivery_unknown",
          error:
            "The first message may have been delivered. Check the linked chat.",
        }),
      };
    } catch (error) {
      if (hasCode(error, "launch_conflict")) return { board: await read() };
      throw error;
    }
  }
  if (
    input.action === "resume" &&
    launch.phase === "review_required" &&
    launch.setup?.kind === "system"
  ) {
    const setup = await planSetup(
      host,
      owner,
      board,
      task,
      input.review,
      launch.id,
      launch.setup,
    );
    if (!("kind" in setup)) return setup;
    try {
      board = await update(launch, {
        phase: "creating",
        setup,
        error: undefined,
      });
    } catch (error) {
      if (hasCode(error, "launch_conflict")) return { board: await read() };
      throw error;
    }
    launch = taskIn(board).launch!;
  }
  if (
    input.action === "resume" &&
    ["setup_failed", "delivery_failed"].includes(launch.phase)
  ) {
    const phase = launch.phase === "setup_failed" ? "creating" : "ready";
    try {
      board = await update(launch, {
        phase,
        error: undefined,
        sendingSince: undefined,
        retrySetup: phase === "creating" ? true : undefined,
      });
    } catch (error) {
      if (hasCode(error, "launch_conflict")) return { board: await read() };
      throw error;
    }
    launch = taskIn(board).launch!;
  }
  if (launch.phase === "creating" || launch.phase === "ready") {
    workers.add(key);
    void advance(launch)
      .catch((error) => {
        if (
          !hasCode(error, "launch_conflict") &&
          !hasCode(error, "host_offline")
        )
          console.error("Planning launch reconciliation failed", launch!.id);
      })
      .finally(() => workers.delete(key));
  }
  return { board };

  async function advance(current: PlanningLaunch) {
    const move = async (change: Partial<PlanningLaunch>) => {
      current = taskIn(await update(current, change)).launch!;
    };
    const ops = host.workspaceOps;
    while (current.phase === "creating") {
      try {
        const setup = current.setup;
        if (!setup) throw new Error("Launch setup details are missing");
        const retryAttempt = current.retrySetup ? current.version : undefined;
        if (setup.kind === "repo") {
          const status = await ops.workspaceCreationStatus(current.id);
          const job =
            retryAttempt === undefined &&
            (status.ok || status.code !== "job_not_found")
              ? unwrap(status)
              : unwrap(
                  await ops.createWorkspace({
                    projectPath: setup.projectPath,
                    branch: setup.branch,
                    baseRef: setup.baseRef,
                    mode: "new",
                    name: current.name,
                    creationId: current.id,
                    retryAttempt,
                  }),
                );
          if (!current.jobId || current.retrySetup)
            await move({ jobId: job.id, retrySetup: undefined });
          if (
            job.workspaceId &&
            job.workspacePath &&
            job.stage === "postNonBlocking"
          )
            await move({ phase: "ready", path: job.workspacePath });
          else if (job.status !== "running")
            await move({
              phase: "setup_failed",
              error: job.error ?? "Workspace setup did not complete",
            });
        } else {
          let state = unwrap(await ops.systems({ action: "list" }));
          let effort = state.efforts.find(({ id }) => id === current.id);
          if (!effort) {
            state = unwrap(
              await ops.systems({
                action: "create",
                systemId: owner.id,
                name: setup.name,
                confirmation: setup.confirmation,
                bases: setup.bases,
                creationId: current.id,
                planningVersion: current.version,
                branchKey: taskId,
              }),
            );
          } else if (retryAttempt !== undefined && effort.status === "failed") {
            state = unwrap(
              await ops.systems({
                action: "retry",
                effortId: effort.id,
                attempt: retryAttempt,
              }),
            );
          }
          effort = state.efforts.find(({ id }) => id === current.id);
          if (!effort)
            throw new Error("Host did not return the admitted Effort");
          if (!current.effortId || current.retrySetup)
            await move({ effortId: effort.id, retrySetup: undefined });
          if (effort.status === "ready")
            await move({ phase: "ready", path: effort.root });
          else if (effort.status !== "creating")
            await move({
              phase: "setup_failed",
              error: effort.error ?? "Effort setup did not complete",
            });
        }
      } catch (error) {
        if (hasCode(error, "launch_conflict")) throw error;
        if (!hasCode(error, "host_offline") && isLinkUp(host.status()))
          await move({
            phase:
              current.setup?.kind === "system" &&
              !current.effortId &&
              hasCode(error, "effort_preview_changed")
                ? "review_required"
                : "setup_failed",
            error: errorMessage(error),
            retrySetup: undefined,
          });
      }
      if (current.phase === "creating")
        await delay(1000, undefined, { ref: false });
    }
    if (current.phase !== "ready" || !current.path) return;
    // A fresh RPC session's creation ID makes spawn/registration idempotent.
    // It automatically attaches to the registered Workspace or Effort root.
    const cwd = current.path;
    let result;
    for (;;) {
      try {
        result = await startNewRpcSession(
          host,
          cwd,
          undefined,
          false,
          true,
          current.id,
        );
        if (
          result.ok ||
          (result.code !== "host_offline" && isLinkUp(host.status()))
        )
          break;
      } catch (error) {
        const offline =
          error instanceof WebRpcError && error.code === "host_offline";
        if (!offline && isLinkUp(host.status())) {
          result = { ok: false as const, error: errorMessage(error) };
          break;
        }
      }
      await delay(1000, undefined, { ref: false });
    }
    if (!result.ok) {
      // Spawn failure cannot have delivered a prompt.
      await move({ phase: "delivery_failed", error: result.error });
      return;
    }
    const { session, realSessionId } = result.value;
    if (current.sessionId && current.sessionId !== realSessionId) {
      await move({
        phase: "delivery_failed",
        error: "The original launch chat is no longer running",
      });
      return;
    }
    let images: PlanningBoard["imagePayloads"];
    if (current.images?.length) {
      try {
        const context = await op({
          action: "readImages",
          ids: current.images.map(({ id }) => id),
        });
        images = context.imagePayloads;
        if (images?.length !== current.images.length)
          throw new Error("The daemon did not return all saved launch images");
      } catch (error) {
        await move({ phase: "delivery_failed", error: errorMessage(error) });
        return;
      }
    }
    await move({
      phase: "sending",
      sessionId: realSessionId,
      sendingSince: Date.now(),
    });
    let receipt: unknown;
    try {
      receipt = await session.withPendingCommand(
        () =>
          session.send({
            type: "prompt_literal",
            message: current.prompt,
            images,
          }),
        true,
      );
    } catch (error) {
      const refused =
        error instanceof RpcCommandError ||
        (error instanceof WebRpcError && error.delivery === "refused");
      await settle(
        refused ? "delivery_failed" : "delivery_unknown",
        refused
          ? errorMessage(error)
          : "The first message may have been delivered. Check the linked chat.",
      );
      return;
    }
    if (Value.Check(LiteralPromptReceiptSchema, receipt)) await settle("sent");
    else
      await settle(
        "delivery_unknown",
        "The first message may have been delivered. Check the linked chat.",
      );

    async function settle(
      phase: "sent" | "delivery_failed" | "delivery_unknown",
      error?: string,
    ) {
      for (;;) {
        try {
          await move({ phase, error });
          return;
        } catch (cause) {
          if (!hasCode(cause, "host_offline") && isLinkUp(host.status()))
            throw cause;
          await delay(1000, undefined, { ref: false });
        }
      }
    }
  }
}
