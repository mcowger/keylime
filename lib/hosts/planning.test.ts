import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PlanningOperation,
  PlanningOwner,
} from "../api-contracts/planning";
import type { SystemsResult } from "../api-contracts/systems";
import { planningOperation } from "./planning";

let dir: string;
let previousDir: string | undefined;
const repo: PlanningOwner = { kind: "repo", id: "same-id" };
const system: PlanningOwner = { kind: "system", id: "same-id" };
let systems: SystemsResult;

beforeEach(() => {
  previousDir = process.env.PI_CODING_AGENT_DIR;
  dir = mkdtempSync(join(tmpdir(), "keylime-planning-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(
    join(dir, "hierarchy.json"),
    JSON.stringify({
      projects: [
        { id: repo.id, path: dir, kind: "directory", name: "Repo" },
        { id: "hidden", path: dir, kind: "git", name: "Hidden", hidden: true },
      ],
    }),
  );
  systems = {
    root: join(dir, "efforts"),
    efforts: [],
    systems: [
      {
        id: system.id,
        name: "System",
        slug: "system",
        archived: false,
        instructions: "",
        repoPaths: [],
        services: [],
      },
    ],
  };
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

const op = (owner: PlanningOwner, input: PlanningOperation["input"]) =>
  planningOperation({ owner, input }, async () => systems);

const setup: Extract<PlanningOperation["input"], { action: "begin" }>["setup"] =
  {
    kind: "system",
    name: "my-effort",
    confirmation: "confirmed",
    bases: [],
  };

async function task(owner: PlanningOwner) {
  const result = await op(owner, {
    action: "saveTask",
    brief: "Task brief",
    prompt: "  Exact prompt\n",
    status: "done",
  });
  return result.tasks[0];
}

test("boards are scoped by canonical kind and ID; stale notes revisions lose", async () => {
  const changes = await Promise.allSettled([
    op(repo, { action: "saveNotes", notes: "# One\n", revision: 0 }),
    op(repo, { action: "saveNotes", notes: "# Two\n", revision: 0 }),
  ]);
  expect(changes[0].status).toBe("fulfilled");
  expect(changes[1]).toMatchObject({
    status: "rejected",
    reason: { status: 409, code: "revision_conflict" },
  });
  expect(await op(repo, { action: "read" })).toMatchObject({
    name: "Repo",
    notes: "# One\n",
    notesRevision: 1,
    canLaunch: false,
  });
  expect(await op(system, { action: "read" })).toMatchObject({
    name: "System",
    notes: "",
    notesRevision: 0,
  });
  await expect(
    op({ kind: "repo", id: "hidden" }, { action: "read" }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    op({ kind: "repo", id: dir }, { action: "read" }),
  ).rejects.toMatchObject({ status: 404 });
});

test("begin snapshots exact saved content; concurrent full launch CAS admits one claim", async () => {
  const saved = await task(system);
  const begin = {
    action: "begin",
    taskId: saved.id,
    revision: saved.revision,
    id: "launch",
    setup,
  } as const;
  const started = await op(system, begin);
  const expected = started.tasks[0].launch!;
  expect(expected).toMatchObject({
    id: "launch",
    phase: "creating",
    name: saved.brief,
    prompt: saved.prompt,
    version: 0,
  });
  expect(started.tasks[0].status).toBe("done");
  expect(await op(system, begin)).toEqual(started);
  await expect(
    op(system, {
      action: "saveTask",
      taskId: saved.id,
      revision: saved.revision,
      brief: "Stale",
      prompt: "Stale",
      status: "ready",
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  const next = {
    ...expected,
    version: 1,
    effortId: "effort",
    phase: "ready",
    path: dir,
  } as const;
  const cas = {
    action: "updateLaunch",
    taskId: saved.id,
    expected,
    next,
  } as const;
  await expect(
    op(system, { ...cas, expected: { ...expected, name: "Wrong" } }),
  ).rejects.toMatchObject({ code: "launch_conflict" });
  await expect(
    op(system, { ...cas, next: { ...next, prompt: "Wrong" } }),
  ).rejects.toMatchObject({ status: 400 });
  const attempts = await Promise.allSettled([op(system, cas), op(system, cas)]);
  expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  expect(attempts.find(({ status }) => status === "rejected")).toMatchObject({
    reason: { code: "launch_conflict" },
  });
  expect((await op(system, { action: "read" })).tasks[0].launch).toEqual(next);

  const sending = {
    ...next,
    version: 2,
    phase: "sending",
    sessionId: "session",
    sendingSince: 100,
  } as const;
  const failed = {
    ...sending,
    version: 3,
    phase: "delivery_failed",
    error: "Refused",
  } as const;
  const readyAgain = { ...next, version: 4, sessionId: "session" } as const;
  const sendingAgain = { ...sending, version: 5 } as const;
  for (const [before, after] of [
    [next, sending],
    [sending, failed],
    [failed, readyAgain],
    [readyAgain, sendingAgain],
  ] as const)
    await op(system, { ...cas, expected: before, next: after });
  await expect(
    op(system, {
      ...cas,
      expected: sending,
      next: { ...sending, version: 3, phase: "sent" },
    }),
  ).rejects.toMatchObject({ code: "launch_conflict" });
});

test("archived Systems can edit notes and tasks but cannot begin a launch", async () => {
  systems.systems[0].archived = true;
  const saved = await task(system);
  const board = await op(system, {
    action: "saveNotes",
    notes: "Still writable",
    revision: 0,
  });
  expect(board.canLaunch).toBe(false);
  await expect(
    op(system, {
      action: "begin",
      taskId: saved.id,
      revision: saved.revision,
      id: "launch",
      setup,
    }),
  ).rejects.toMatchObject({ code: "planning_launch_unavailable" });
});

test("launch keeps its original Notes and task images after edits and isolates them by board", async () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+NmWQAAAAASUVORK5CYII=";
  const png = { mimeType: "image/png", data } as const;
  const notes = await op(system, {
    action: "saveNotes",
    notes: "Context",
    revision: 0,
    images: [{ ...png, name: "notes.png" }],
  });
  const {
    tasks: [task],
  } = await op(system, {
    action: "saveTask",
    brief: "Task",
    prompt: "",
    status: "ready",
    images: [{ ...png, name: "task.png" }],
  });
  const ids = [notes.notesImages![0].id, task.images![0].id];
  const started = await op(system, {
    action: "begin",
    taskId: task.id,
    revision: task.revision,
    id: "launch",
    setup,
  });
  expect(started.tasks[0].launch?.images?.map(({ name }) => name)).toEqual([
    "notes.png",
    "task.png",
  ]);
  await op(system, {
    action: "saveNotes",
    notes: "New context",
    revision: notes.notesRevision,
    images: [],
  });
  await op(system, {
    action: "saveTask",
    taskId: task.id,
    revision: started.tasks[0].revision,
    brief: "Task",
    prompt: "",
    status: "in_progress",
    images: [],
  });
  expect(
    (await op(system, { action: "readImages", ids })).imagePayloads,
  ).toEqual([
    { ...png, type: "image" },
    { ...png, type: "image" },
  ]);
  await expect(op(repo, { action: "readImages", ids })).rejects.toMatchObject({
    code: "planning_image_not_found",
  });
  expect((await op(system, { action: "read" })).imagePayloads).toBeUndefined();
});
