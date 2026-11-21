import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PlanningOperation,
  PlanningOwner,
  PlanningBoard,
  PlanningLaunch,
  PlanningTask,
} from "../api-contracts/planning";
import type { SystemsResult } from "../api-contracts/systems";
import { MAX_ATTACHED_IMAGES } from "../image-attachments";
import {
  completePlanningEffort,
  completePlanningWorkspace,
  planningOperation,
} from "./planning";

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
    name: setup.name,
    setup,
  } as const;
  const started = await op(system, begin);
  const expected = started.tasks[0].launch!;
  expect(expected).toMatchObject({
    id: "launch",
    phase: "creating",
    name: setup.name,
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
      name: setup.name,
      setup,
    }),
  ).rejects.toMatchObject({ code: "planning_launch_unavailable" });
});

test("browser previews Notes, but launch pins only task images and retains them after edits", async () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+NmWQAAAAASUVORK5CYII=";
  const png = { mimeType: "image/png", data } as const;
  const notes = await op(system, {
    action: "saveNotes",
    notes: "Context",
    revision: 0,
    images: Array.from({ length: MAX_ATTACHED_IMAGES }, (_, index) => ({
      ...png,
      name: `notes-${index}.png`,
    })),
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
  const notesId = notes.notesImages![0].id;
  const taskImageId = task.images![0].id;
  const started = await op(system, {
    action: "begin",
    taskId: task.id,
    revision: task.revision,
    id: "launch",
    name: setup.name,
    setup,
  });
  expect(started.tasks[0].launch).toMatchObject({
    prompt: "Task",
    taskImagesOnly: true,
    images: task.images,
  });
  expect(
    (await op(system, { action: "readImages", ids: [notesId] })).imagePayloads,
  ).toEqual([{ ...png, type: "image" }]);
  await expect(
    op(system, { action: "readTaskImages", taskId: task.id, ids: [notesId] }),
  ).rejects.toMatchObject({ code: "planning_image_not_found" });
  expect(
    (
      await op(system, {
        action: "readTaskImages",
        taskId: task.id,
        ids: [taskImageId],
      })
    ).imagePayloads,
  ).toEqual([{ ...png, type: "image" }]);
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
  const expected = started.tasks[0].launch!;
  const ready = {
    ...expected,
    version: expected.version + 1,
    phase: "ready" as const,
    path: dir,
  };
  await op(system, {
    action: "updateLaunch",
    taskId: task.id,
    expected,
    next: ready,
  });
  const readLaunch = {
    action: "readLaunchImages",
    taskId: task.id,
    id: ready.id,
    version: ready.version,
  } as const;
  expect((await op(system, readLaunch)).imagePayloads).toEqual([
    { ...png, type: "image" },
  ]);
  await expect(
    op(system, { ...readLaunch, version: expected.version }),
  ).rejects.toMatchObject({ code: "launch_conflict" });
  expect(
    (await op(system, { action: "readImages", ids: [taskImageId] }))
      .imagePayloads,
  ).toEqual([{ ...png, type: "image" }]);
  await expect(
    op(system, { action: "readImages", ids: [notesId] }),
  ).rejects.toMatchObject({
    code: "planning_image_not_found",
  });
  await expect(
    op(repo, { action: "readImages", ids: [taskImageId] }),
  ).rejects.toMatchObject({
    code: "planning_image_not_found",
  });
  expect((await op(system, { action: "read" })).imagePayloads).toBeUndefined();
});

test("preparing a stored legacy launch drops Notes and ambiguous IDs without changing the board editors", async () => {
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+NmWQAAAAASUVORK5CYII=";
  const png = { mimeType: "image/png", data } as const;
  await op(system, {
    action: "saveNotes",
    revision: 0,
    notes: "Private",
    images: [{ ...png, name: "notes.png" }],
  });
  const board = await op(system, {
    action: "saveTask",
    brief: "Task",
    prompt: "Literal task prompt",
    status: "ready",
    images: [
      { ...png, name: "kept.png" },
      { ...png, name: "removed.png" },
    ],
  });
  const saved = board.tasks[0];
  const [kept, removed] = saved.images!;
  const [note] = board.notesImages!;
  const legacy = {
    id: "legacy",
    version: 4,
    phase: "ready" as const,
    path: dir,
    prompt: saved.prompt,
    name: saved.brief,
    setup,
    images: [note, kept, removed],
  };
  const db = new Database(join(dir, "keylime", "planning.sqlite"));
  try {
    db.run(
      "UPDATE boards SET data = ? WHERE kind = 'system' AND owner_id = ?",
      [
        JSON.stringify({
          notes: board.notes,
          notesRevision: board.notesRevision,
          notesImages: board.notesImages,
          tasks: [{ ...saved, images: [kept], launch: legacy }],
        }),
        system.id,
      ],
    );
    const claim = { taskId: saved.id, id: legacy.id, version: legacy.version };
    expect((await op(system, { action: "read" })).tasks[0].launch).toEqual(
      legacy,
    );
    await expect(
      op(system, { action: "readLaunchImages", ...claim }),
    ).rejects.toMatchObject({ code: "launch_conflict" });
    await expect(
      op(system, {
        action: "updateLaunch",
        taskId: saved.id,
        expected: legacy,
        next: {
          ...legacy,
          version: 5,
          phase: "sending",
          sessionId: "chat",
          sendingSince: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const prepared = await op(system, { action: "prepareLaunch", ...claim });
    expect(prepared).toMatchObject({
      notes: "Private",
      notesRevision: 1,
      notesImages: [note],
    });
    expect(prepared.tasks[0]).toEqual({
      ...saved,
      images: [kept],
      launch: { ...legacy, version: 5, taskImagesOnly: true, images: [kept] },
    });
    expect(
      (await op(system, { action: "readLaunchImages", ...claim, version: 5 }))
        .imagePayloads,
    ).toEqual([{ ...png, type: "image" }]);
    expect(
      (await op(system, { action: "readImages", ids: [note.id] }))
        .imagePayloads,
    ).toEqual([{ ...png, type: "image" }]);
    expect(
      db.query("SELECT id FROM images WHERE id = ?").get(removed.id),
    ).toBeNull();
  } finally {
    db.close(true);
  }
});

type StoredBoard = Pick<
  PlanningBoard,
  "notes" | "notesRevision" | "notesImages" | "tasks"
>;

function completionTask(id: string, launch?: PlanningLaunch): PlanningTask {
  return {
    id,
    revision: 3,
    brief: `Brief ${id}`,
    prompt: `Prompt ${id}`,
    status: "in_progress",
    ...(launch ? { launch } : {}),
  };
}

function completionBoard(tasks: PlanningTask[]): StoredBoard {
  return {
    notes: "Keep notes",
    notesRevision: 7,
    notesImages: [
      { id: "image", name: "image.png", mimeType: "image/png", bytes: 1 },
    ],
    tasks,
  };
}

function writeCompletionBoard(
  db: Database,
  owner: PlanningOwner,
  board: StoredBoard,
): void {
  db.run("INSERT INTO boards (kind, owner_id, data) VALUES (?, ?, ?)", [
    owner.kind,
    owner.id,
    JSON.stringify(board),
  ]);
}

function readCompletionBoard(
  db: Database,
  owner: PlanningOwner,
): StoredBoard | undefined {
  const row = db
    .query<{ data: string }, [string, string]>(
      "SELECT data FROM boards WHERE kind = ? AND owner_id = ?",
    )
    .get(owner.kind, owner.id);
  return row ? JSON.parse(row.data) : undefined;
}

test("completion does not create a missing planning database", () => {
  const workspacePath = join(dir, "workspace");
  writeFileSync(
    join(dir, "hierarchy.json"),
    JSON.stringify({
      projects: [
        {
          id: repo.id,
          path: dir,
          workspaces: [{ path: workspacePath, setup: { jobId: "job" } }],
        },
      ],
    }),
  );
  completePlanningWorkspace(dir, workspacePath);
  completePlanningEffort("missing");
  expect(existsSync(join(dir, "keylime", "planning.sqlite"))).toBe(false);
});

test("workspace completion matches the registered creation and preserves unrelated tasks", async () => {
  const projectPath = dir;
  const workspacePath = join(dir, "workspace");
  writeFileSync(
    join(dir, "hierarchy.json"),
    JSON.stringify({
      projects: [
        {
          id: repo.id,
          path: projectPath,
          kind: "directory",
          name: "Repo",
          workspaces: [{ path: workspacePath, setup: { jobId: "job" } }],
        },
      ],
    }),
  );
  await op(repo, { action: "read" });
  const launch: PlanningLaunch = {
    id: "job",
    version: 0,
    phase: "creating",
    prompt: "saved prompt",
    name: "workspace",
    setup: { kind: "repo", projectPath, baseRef: "main", branch: "branch" },
  };
  const matching = completionTask("matching", launch);
  const done = { ...completionTask("done", launch), status: "done" as const };
  const board = completionBoard([
    matching,
    done,
    completionTask("other-job", {
      ...launch,
      id: "other",
      path: workspacePath,
    }),
    completionTask("other-path", { ...launch, path: join(dir, "other") }),
    completionTask("other-repo", {
      ...launch,
      setup: {
        kind: "repo",
        projectPath: "/other",
        baseRef: "main",
        branch: "branch",
      },
    }),
    completionTask("no-launch"),
  ]);
  const otherOwner: PlanningOwner = { kind: "repo", id: "other" };
  const otherBoard = completionBoard([completionTask("other-owner", launch)]);
  const systemBoard = completionBoard([completionTask("system-owner", launch)]);
  const db = new Database(join(dir, "keylime", "planning.sqlite"));
  try {
    writeCompletionBoard(db, repo, board);
    writeCompletionBoard(db, otherOwner, otherBoard);
    writeCompletionBoard(db, system, systemBoard);
    completePlanningWorkspace(projectPath, workspacePath);
    const expected: StoredBoard = {
      ...board,
      tasks: [
        { ...matching, status: "done", revision: 4 },
        ...board.tasks.slice(1),
      ],
    };
    expect(readCompletionBoard(db, repo)).toEqual(expected);
    expect(readCompletionBoard(db, otherOwner)).toEqual(otherBoard);
    expect(readCompletionBoard(db, system)).toEqual(systemBoard);
    completePlanningWorkspace(projectPath, workspacePath);
    completePlanningWorkspace(projectPath, join(dir, "missing"));
    completePlanningWorkspace("/missing", workspacePath);
    expect(readCompletionBoard(db, repo)).toEqual(expected);
    await expect(
      op(repo, {
        action: "saveTask",
        taskId: matching.id,
        revision: matching.revision,
        brief: matching.brief,
        prompt: matching.prompt,
        status: "ready",
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    writeFileSync(
      join(dir, "hierarchy.json"),
      JSON.stringify({
        projects: [
          {
            id: repo.id,
            path: projectPath,
            kind: "directory",
            name: "Repo",
            workspaces: [{ path: workspacePath, setup: { jobId: "other" } }],
          },
        ],
      }),
    );
    completePlanningWorkspace(projectPath, workspacePath);
    const reused: StoredBoard = {
      ...expected,
      tasks: expected.tasks.map((item) =>
        item.id === "other-job"
          ? { ...item, status: "done", revision: 4 }
          : item,
      ),
    };
    expect(readCompletionBoard(db, repo)).toEqual(reused);
    const withoutTask = { ...reused, tasks: reused.tasks.slice(1) };
    db.run("UPDATE boards SET data = ? WHERE kind = ? AND owner_id = ?", [
      JSON.stringify(withoutTask),
      repo.kind,
      repo.id,
    ]);
    completePlanningWorkspace(projectPath, workspacePath);
    expect(readCompletionBoard(db, repo)).toEqual(withoutTask);
    db.run("DELETE FROM boards WHERE kind = ? AND owner_id = ?", [
      repo.kind,
      repo.id,
    ]);
    completePlanningWorkspace(projectPath, workspacePath);
    expect(readCompletionBoard(db, repo)).toBeUndefined();
  } finally {
    db.close(true);
  }
});

test("Effort completion matches saved IDs and creation IDs without changing other boards", async () => {
  await op(system, { action: "read" });
  const launch: PlanningLaunch = {
    id: "launch",
    version: 1,
    phase: "ready",
    prompt: "saved prompt",
    name: "effort",
    setup,
    effortId: "effort",
    path: dir,
  };
  const matching = completionTask("matching", launch);
  const creating = completionTask("creating", {
    id: "effort",
    version: 0,
    phase: "creating",
    prompt: "saved prompt",
    name: "effort",
    setup,
  });
  const board = completionBoard([
    matching,
    creating,
    { ...completionTask("done", launch), status: "done" },
    completionTask("different", { ...launch, effortId: "other" }),
    completionTask("different-saved-id", {
      ...launch,
      id: "effort",
      effortId: "other",
    }),
    completionTask("no-launch"),
  ]);
  const repoBoard = completionBoard([completionTask("repo", launch)]);
  const db = new Database(join(dir, "keylime", "planning.sqlite"));
  try {
    writeCompletionBoard(db, system, board);
    writeCompletionBoard(db, repo, repoBoard);
    completePlanningEffort("effort");
    const expected: StoredBoard = {
      ...board,
      tasks: [
        { ...matching, status: "done", revision: 4 },
        { ...creating, status: "done", revision: 4 },
        ...board.tasks.slice(2),
      ],
    };
    expect(readCompletionBoard(db, system)).toEqual(expected);
    expect(readCompletionBoard(db, repo)).toEqual(repoBoard);
    completePlanningEffort("effort");
    completePlanningEffort("missing");
    expect(readCompletionBoard(db, system)).toEqual(expected);
    db.run("DELETE FROM boards WHERE kind = ? AND owner_id = ?", [
      system.kind,
      system.id,
    ]);
    completePlanningEffort("effort");
    expect(readCompletionBoard(db, system)).toBeUndefined();
  } finally {
    db.close(true);
  }
});

test("Effort completion replay preserves a later manual status edit", async () => {
  await op(system, { action: "read" });
  const launch: PlanningLaunch = {
    id: "launch",
    version: 1,
    phase: "sent",
    prompt: "saved prompt",
    name: "effort",
    setup,
    effortId: "effort",
  };
  const saved = completionTask("task", launch);
  const db = new Database(join(dir, "keylime", "planning.sqlite"));
  try {
    // A completion observed before its task is stored must remain retryable.
    completePlanningEffort("effort");
    writeCompletionBoard(db, system, completionBoard([saved]));
    completePlanningEffort("effort");
    const completed = (await op(system, { action: "read" })).tasks[0];
    expect(completed).toMatchObject({ status: "done", revision: 4 });
    const edited = await op(system, {
      action: "saveTask",
      taskId: saved.id,
      revision: completed.revision,
      brief: saved.brief,
      prompt: saved.prompt,
      status: "ready",
    });
    expect(edited.tasks[0]).toMatchObject({ status: "ready", revision: 5 });
    completePlanningEffort("effort");
    expect((await op(system, { action: "read" })).tasks[0]).toEqual(
      edited.tasks[0],
    );
  } finally {
    db.close(true);
  }
});

test("an already Done Effort task is still protected from completion replay", async () => {
  await op(system, { action: "read" });
  const launch: PlanningLaunch = {
    id: "effort",
    version: 0,
    phase: "creating",
    prompt: "saved prompt",
    name: "effort",
    setup,
  };
  const saved = {
    ...completionTask("task", launch),
    status: "done" as const,
  };
  const db = new Database(join(dir, "keylime", "planning.sqlite"));
  try {
    writeCompletionBoard(db, system, completionBoard([saved]));
    completePlanningEffort("effort");
    const edited = await op(system, {
      action: "saveTask",
      taskId: saved.id,
      revision: saved.revision,
      brief: saved.brief,
      prompt: saved.prompt,
      status: "ready",
    });
    completePlanningEffort("effort");
    expect((await op(system, { action: "read" })).tasks[0]).toEqual(
      edited.tasks[0],
    );
  } finally {
    db.close(true);
  }
});
