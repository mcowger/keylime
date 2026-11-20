import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  PlanningBoard,
  PlanningLaunch,
  PlanningOperation,
} from "./api-contracts/planning";
import type { SystemsRequest } from "./api-contracts/systems";
import type { WorkspaceCreateRequest } from "./workspace-creation-types";
import type { Host } from "./hosts/host";
import { HostOpError } from "./hosts/link-protocol";
import { checkPlanningAdmission, planningOperation } from "./hosts/planning";
import {
  systemsOperation,
  waitForSystemsSetup,
  type SystemsRuntime,
} from "./hosts/systems";
import { TerminalManager } from "./hosts/terminals";
import { workspaceCreationSettings } from "./hosts/workspace-creation";
import { runPlanningLaunch } from "./planning-launch";

const owner = { kind: "repo", id: "repo-1" } as const;
const prompt = "  inspect this\r\nwithout rewriting it\n";
const taskId = "task-1";
const launchId = "12345678-abcd-4abc-8abc-1234567890ab";
const ok = <T>(value: T) => ({ ok: true as const, value });

function fixture(defaultRef = "refs/heads/main", existing?: PlanningLaunch) {
  const board: PlanningBoard = {
    name: "Repo",
    canLaunch: true,
    notes: "",
    notesRevision: 0,
    tasks: [
      {
        id: taskId,
        revision: 2,
        brief: "Inspect",
        prompt,
        status: "ready",
        launch: existing,
      },
    ],
  };
  const events: string[] = [];
  const requests: WorkspaceCreateRequest[] = [];
  const host = {
    id: `host-${Math.random()}`,
    status: () => "online",
    workspaceOps: {
      async planning({ input }: PlanningOperation) {
        const task = board.tasks[0];
        if (input.action === "begin") {
          assert.equal(input.revision, task.revision);
          if (task.launch)
            throw new HostOpError(409, "launch_conflict", "Already claimed");
          task.launch = {
            id: input.id,
            phase: "creating",
            version: 0,
            name: task.brief,
            prompt: task.prompt,
            setup: input.setup,
          };
          events.push("begin");
        } else if (input.action === "updateLaunch") {
          if (task.launch?.version !== input.expected.version)
            throw new HostOpError(409, "launch_conflict", "Stale worker");
          assert.equal(input.next.version, input.expected.version + 1);
          assert.equal(input.next.prompt, prompt);
          task.launch = input.next;
          events.push(input.next.phase);
        }
        return structuredClone(board);
      },
      hierarchy: async () =>
        ok({ projects: [{ id: owner.id, path: "/repo" }] }),
      workspaceBranches: async () =>
        ok({
          defaultRef,
          local: ["feature"],
          remote: [],
          originAheadRef: null,
          otherRefs: ["refs/heads/feature"],
          pullRequests: [],
        }),
      workspaceCreationStatus: async () => ({
        ok: false,
        status: 404,
        code: "job_not_found",
        error: "Not found",
      }),
      async createWorkspace(request: WorkspaceCreateRequest) {
        requests.push(request);
        assert.equal(events[0], existing ? "creating" : "begin");
        return ok({
          id: request.creationId,
          status: "running",
          stage: "postNonBlocking",
          workspaceId: "workspace",
          workspacePath: "/repo-worktrees/task",
        });
      },
    },
    sessionOps: {
      async validateCwd() {
        assert.equal(board.tasks[0].launch?.phase, "ready");
        return {
          ok: false,
          status: 404,
          code: "start_refused",
          error: "Chat unavailable",
        };
      },
    },
  } as unknown as Host;
  return { host, board, events, requests };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(5);
  assert.ok(predicate());
}

test("Repo launch claims and snapshots before setup and records a known spawn refusal", async () => {
  const { host, board, events, requests } = fixture();
  const result = await runPlanningLaunch(host, owner, {
    action: "launch",
    taskId,
    revision: 2,
  });
  assert.equal(result.board?.tasks[0].launch?.phase, "creating");
  await until(() => board.tasks[0].launch?.phase === "delivery_failed");
  assert.deepEqual(events, ["begin", "creating", "ready", "delivery_failed"]);
  const launch = board.tasks[0].launch!;
  assert.equal(launch.prompt, prompt);
  assert.equal(launch.path, "/repo-worktrees/task");
  assert.equal(requests[0].creationId, launch.id);
  assert.equal(requests[0].baseRef, "refs/heads/main");
});

test("Repo without a default waits for review and uses the chosen full ref", async () => {
  const { host, events, requests } = fixture("");
  const review = await runPlanningLaunch(host, owner, {
    action: "launch",
    taskId,
    revision: 2,
  });
  assert.ok(review.review);
  assert.equal(events.length, 0);
  await runPlanningLaunch(host, owner, {
    action: "launch",
    taskId,
    revision: 2,
    review: {
      confirmation: review.review.confirmation,
      baseRef: "refs/heads/feature",
    },
  });
  await until(() => events.includes("delivery_failed"));
  assert.equal(requests[0].baseRef, "refs/heads/feature");
});

test("Resume retries the same setup identity and refresh never resends an unresolved handoff", async () => {
  const launch: PlanningLaunch = {
    id: launchId,
    version: 3,
    phase: "setup_failed",
    prompt,
    name: "Inspect",
    jobId: launchId,
    setup: {
      kind: "repo",
      projectPath: "/repo",
      baseRef: "refs/heads/main",
      branch: "plan-123",
    },
  };
  const { host, events, requests } = fixture(undefined, launch);
  await runPlanningLaunch(host, owner, { action: "resume", taskId });
  await until(() => events.includes("delivery_failed"));
  assert.equal(requests[0].creationId, launchId);
  assert.equal(requests[0].retryAttempt, 4);

  const uncertain = fixture(undefined, {
    ...launch,
    phase: "sending",
    sendingSince: 0,
    sessionId: "session-1",
  });
  const refreshed = await runPlanningLaunch(uncertain.host, owner, {
    action: "refresh",
    taskId,
  });
  assert.equal(refreshed.board?.tasks[0].launch?.phase, "delivery_unknown");
  const resumed = await runPlanningLaunch(uncertain.host, owner, {
    action: "resume",
    taskId,
  });
  assert.equal(resumed.board?.tasks[0].launch?.sessionId, "session-1");
  assert.deepEqual(uncertain.events, ["delivery_unknown"]);
  assert.deepEqual(uncertain.requests, []);
});

test("a moved Effort base requires fresh approval before admitting the same launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "planning-recheck-"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  const runtime: SystemsRuntime = {
    terminals: new TerminalManager(() => {}),
    processes: {
      fence: () => () => {},
      inspect: async () => [],
      stop: async () => {},
    },
    sessionsChanged() {},
    checkPlanningAdmission,
  };
  const systemOp = (input: SystemsRequest) => systemsOperation(input, runtime);
  try {
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          repo,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          `core.hooksPath=${join(dir, "no-hooks")}`,
          ...args,
        ],
        { encoding: "utf8" },
      ).trim();
    git("commit", "--allow-empty", "-qm", "first base");
    const firstBase = git("rev-parse", "HEAD");
    await systemOp({ action: "setRoot", root: join(dir, "worktrees") });
    const {
      systems: [system],
    } = await systemOp({
      action: "saveSystem",
      definition: {
        name: "Test System",
        repoPaths: [repo],
        instructions: "",
        services: [],
      },
    });
    const systemOwner = { kind: "system", id: system.id } as const;
    await workspaceCreationSettings({
      projectPath: repo,
      override: {
        pre: [],
        create: ["exit 90"],
        postBlocking: [],
        postNonBlocking: [],
      },
    });
    const plan = (input: PlanningOperation["input"]) =>
      planningOperation({ owner: systemOwner, input }, () =>
        systemOp({ action: "list" }),
      );
    const {
      tasks: [task],
    } = await plan({
      action: "saveTask",
      brief: "Inspect base",
      prompt,
      status: "ready",
    });
    const readLaunch = async () =>
      (await plan({ action: "read" })).tasks[0].launch;
    const attempts: Extract<SystemsRequest, { action: "create" }>[] = [];
    const host = {
      id: system.id,
      status: () => "online",
      sessionOps: {
        validateCwd: async () => ({
          ok: false,
          status: 404,
          code: "start_refused",
          error: "Chat disabled in fixture",
        }),
      },
      workspaceOps: {
        planning: ({ input }: PlanningOperation) => plan(input),
        async systems(input: SystemsRequest) {
          if (input.action === "create") {
            if (!attempts.length)
              git("commit", "--allow-empty", "-qm", "moved base");
            else
              await assert.rejects(systemOp(attempts[0]), {
                code: "launch_conflict",
              });
            attempts.push(input);
          }
          try {
            const result = await systemOp(input);
            if (input.action === "create") {
              const expected = (await readLaunch())!;
              assert.equal(expected.effortId, undefined);
              await assert.rejects(
                plan({
                  action: "updateLaunch",
                  taskId: task.id,
                  expected,
                  next: {
                    ...expected,
                    phase: "review_required",
                    version: expected.version + 1,
                  },
                }),
                { code: "launch_conflict" },
              );
            }
            return ok(result);
          } catch (error) {
            if (!(error instanceof HostOpError)) throw error;
            return {
              ok: false,
              status: error.status,
              code: error.code,
              error: error.message,
            };
          }
        },
      },
    } as unknown as Host;
    const launchInput = {
      action: "launch",
      taskId: task.id,
      revision: task.revision,
    } as const;
    const resumeInput = { action: "resume", taskId: task.id } as const;
    const initial = (await runPlanningLaunch(host, systemOwner, launchInput))
      .review!;
    assert.equal(initial.effort?.members[0].baseCommit, firstBase);
    await runPlanningLaunch(host, systemOwner, {
      ...launchInput,
      review: { confirmation: initial.confirmation },
    });
    const waitForPhase = async (phase: PlanningLaunch["phase"]) => {
      for (let i = 0; i < 250; i++) {
        const launch = await readLaunch();
        if (launch?.phase === phase) return launch;
        await delay(10);
      }
      assert.fail(`Expected ${phase}, saw ${(await readLaunch())?.phase}`);
    };
    const rejected = await waitForPhase("review_required");
    assert.deepEqual((await systemOp({ action: "list" })).efforts, []);
    const replacement = (
      await runPlanningLaunch(host, systemOwner, resumeInput)
    ).review!;
    const movedBase = git("rev-parse", "HEAD");
    assert.equal(replacement.effort?.members[0].baseCommit, movedBase);
    assert.notEqual(replacement.confirmation, initial.confirmation);
    const stale = await runPlanningLaunch(host, systemOwner, {
      ...resumeInput,
      review: { confirmation: initial.confirmation },
    });
    assert.equal(stale.review?.confirmation, replacement.confirmation);
    assert.deepEqual(await readLaunch(), rejected);
    await runPlanningLaunch(host, systemOwner, {
      ...resumeInput,
      review: { confirmation: replacement.confirmation },
    });
    const resumed = await waitForPhase("delivery_failed");
    assert.equal(resumed.id, rejected.id);
    assert.equal(resumed.prompt, prompt);
    const { efforts } = await systemOp({ action: "list" });
    assert.deepEqual(
      efforts.map(({ id, members }) => [id, members[0].baseCommit]),
      [[rejected.id, movedBase]],
    );
  } finally {
    await waitForSystemsSetup();
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(dir, { recursive: true, force: true });
  }
});
