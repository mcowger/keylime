import { Value } from "@sinclair/typebox/value";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  PlanningBoardSchema,
  PlanningOperationSchema,
  type PlanningBoard,
  type PlanningLaunch,
  type PlanningImageEdit,
  type PlanningImageRef,
  type PlanningOwner,
} from "../api-contracts/planning";
import type { SystemsRequest, SystemsResult } from "../api-contracts/systems";
import {
  getBase64DecodedByteLength,
  MAX_ATTACHED_IMAGES,
  MAX_TOTAL_ATTACHED_IMAGE_BYTES,
} from "../image-attachments";
import { imageMimeType } from "../media-cache";
import { getAgentDir } from "../omp/paths";
import { HostOpError, LINK_LIMITS } from "./link-protocol";
import { canonicalRepoPath, readHierarchy } from "./project-hierarchy";
import { hasAdmittedEffort, isEffortPath } from "./systems";

type OwnerInfo = Pick<PlanningBoard, "name" | "canLaunch"> & { path?: string };
type SavedBoard = Pick<
  PlanningBoard,
  "notes" | "notesRevision" | "notesImages" | "tasks"
>;

async function ownerInfo(
  owner: PlanningOwner,
  listSystems: () => Promise<SystemsResult>,
): Promise<OwnerInfo> {
  if (owner.kind === "system") {
    const system = (await listSystems()).systems.find(
      ({ id }) => id === owner.id,
    );
    if (system) return { name: system.name, canLaunch: !system.archived };
  } else {
    const repo = readHierarchy().projects.find(({ id }) => id === owner.id);
    if (repo && !repo.hidden && !repo.effortRoot && !isEffortPath(repo.path)) {
      let canLaunch = false;
      if (repo.kind === "git") {
        try {
          canLaunch = canonicalRepoPath(repo.path) === repo.path;
        } catch {
          // Keep the board readable when a checkout disappears or stops being a Repo.
        }
      }
      return { name: repo.alias ?? repo.name, canLaunch, path: repo.path };
    }
  }
  throw new HostOpError(
    404,
    "planning_owner_not_found",
    "Planning owner not registered on this host",
  );
}

function database(): Database {
  const dir = join(getAgentDir(), "keylime");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "planning.sqlite");
  closeSync(openSync(path, "a", 0o600));
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA synchronous = FULL");
    db.run(`
      CREATE TABLE IF NOT EXISTS boards (
        kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (kind, owner_id)
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS completed_efforts (
        effort_id TEXT PRIMARY KEY
      );
    `);
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}

function invalid(message: string): never {
  throw new HostOpError(400, "invalid_request", message);
}

function checkRevision(actual: number, expected: number | undefined): void {
  if (expected !== actual)
    throw new HostOpError(
      409,
      "revision_conflict",
      "The saved revision changed. Read the board and try again.",
    );
}

function launchConflict(): never {
  throw new HostOpError(
    409,
    "launch_conflict",
    "The task launch changed. Read the board and try again.",
  );
}

function boardImageRefs(board: SavedBoard): PlanningImageRef[] {
  return [
    ...(board.notesImages ?? []),
    ...board.tasks.flatMap((task) => [
      ...(task.images ?? []),
      ...(task.launch?.images ?? []),
    ]),
  ];
}

function cutOverTaskImages(
  board: SavedBoard,
  task: SavedBoard["tasks"][number],
  launch: PlanningLaunch,
): void {
  const notesIds = new Set(board.notesImages?.map(({ id }) => id));
  // Legacy snapshots mixed Notes and task refs. IDs can only be kept on
  // their original attachment list; removed refs have no proven origin.
  const taskIds = new Set(task.images?.map(({ id }) => id));
  const images = launch.images?.filter(
    ({ id }) => taskIds.has(id) && !notesIds.has(id),
  );
  if (images?.length) launch.images = images;
  else delete launch.images;
  launch.taskImagesOnly = true;
  launch.version++;
}

function checkImageBudget(
  images: readonly PlanningImageRef[],
  context: string,
): void {
  if (
    images.length > MAX_ATTACHED_IMAGES ||
    images.reduce((sum, image) => sum + image.bytes, 0) >
      MAX_TOTAL_ATTACHED_IMAGE_BYTES
  )
    throw new HostOpError(
      413,
      "planning_images_too_large",
      `${context} can include up to ${MAX_ATTACHED_IMAGES} images totaling 5 MiB.`,
    );
}

function replaceImages(
  db: Database,
  existing: PlanningImageRef[] | undefined,
  edits: PlanningImageEdit[],
): PlanningImageRef[] {
  const kept = new Set<string>();
  const images = edits.map((edit) => {
    if (typeof edit === "string") {
      const image = existing?.find(({ id }) => id === edit);
      if (!image || kept.has(edit))
        invalid("Image not attached here or listed twice");
      kept.add(edit);
      return image;
    }
    const bytes = getBase64DecodedByteLength(edit.data);
    if (
      !bytes ||
      bytes > MAX_TOTAL_ATTACHED_IMAGE_BYTES ||
      imageMimeType(Buffer.from(edit.data, "base64")) !== edit.mimeType
    )
      invalid("Attach a valid PNG, JPEG, GIF or WebP image");
    const id = randomUUID();
    db.run("INSERT INTO images (id, data) VALUES (?, ?)", [id, edit.data]);
    return { id, name: edit.name, mimeType: edit.mimeType, bytes };
  });
  checkImageBudget(images, "An attachment list");
  return images;
}

/** Checked synchronously at the point of Effort admission, after Git preview awaits. */
export function checkPlanningAdmission(
  input: Extract<SystemsRequest, { action: "create" }>,
): void {
  const db = database();
  try {
    const row = db
      .query<{ data: string }, [string]>(
        "SELECT data FROM boards WHERE kind = 'system' AND owner_id = ?",
      )
      .get(input.systemId);
    const board: SavedBoard | undefined = row && JSON.parse(row.data);
    const launch = board?.tasks.find(
      ({ id }) => id === input.branchKey,
    )?.launch;
    if (
      !launch ||
      launch.id !== input.creationId ||
      launch.version !== input.planningVersion ||
      launch.phase !== "creating" ||
      launch.setup?.kind !== "system" ||
      launch.setup.name !== input.name ||
      launch.setup.confirmation !== input.confirmation ||
      !isDeepStrictEqual(launch.setup.bases, input.bases)
    )
      launchConflict();
  } finally {
    db.close(true);
  }
}

const transitions: Record<
  PlanningLaunch["phase"],
  readonly PlanningLaunch["phase"][]
> = {
  creating: ["creating", "setup_failed", "review_required", "ready"],
  setup_failed: ["creating"],
  review_required: ["creating"],
  ready: ["sending", "delivery_failed"],
  sending: ["sent", "delivery_failed", "delivery_unknown"],
  sent: [],
  delivery_failed: ["ready"],
  delivery_unknown: [],
};

function checkTransition(previous: PlanningLaunch, next: PlanningLaunch): void {
  const replan = previous.phase === "review_required";
  if (replan || next.phase === "review_required") {
    if (
      previous.setup?.kind !== "system" ||
      next.setup?.kind !== "system" ||
      previous.setup.name !== next.setup.name ||
      previous.jobId ||
      previous.effortId ||
      previous.path ||
      previous.sessionId
    )
      invalid("Only an unadmitted Effort can review a new plan");
    if (hasAdmittedEffort(previous.id)) launchConflict();
  }
  if (
    next.version !== previous.version + 1 ||
    next.id !== previous.id ||
    next.prompt !== previous.prompt ||
    !isDeepStrictEqual(next.images, previous.images) ||
    next.taskImagesOnly !== previous.taskImagesOnly ||
    (next.phase === "sending" && !previous.taskImagesOnly) ||
    next.name !== previous.name ||
    (!replan && !isDeepStrictEqual(next.setup, previous.setup)) ||
    !transitions[previous.phase].includes(next.phase)
  )
    invalid("Invalid launch transition");

  for (const key of ["jobId", "effortId", "path", "sessionId"] as const) {
    if (previous[key] !== undefined && next[key] !== previous[key])
      invalid(`Cannot change a saved launch ${key}`);
  }
  if (
    (next.path !== undefined &&
      (!isAbsolute(next.path) || next.path.includes("\0"))) ||
    (next.jobId !== undefined && next.setup?.kind !== "repo") ||
    (next.effortId !== undefined && next.setup?.kind !== "system") ||
    (previous.phase !== "creating" &&
      (next.path !== previous.path ||
        next.jobId !== previous.jobId ||
        next.effortId !== previous.effortId)) ||
    (next.phase !== "sending" && next.sessionId !== previous.sessionId) ||
    (next.phase === "ready" && !next.path) ||
    (next.phase === "sending" &&
      (!next.sessionId || next.sendingSince === undefined)) ||
    (next.phase !== "sending" &&
      next.sendingSince !==
        (next.phase === "ready" ? undefined : previous.sendingSince)) ||
    (next.retrySetup === true &&
      (next.phase !== "creating" ||
        (previous.phase !== "setup_failed" && previous.retrySetup !== true)))
  )
    invalid("Invalid launch destination or identifier");
}

function completePlanningTasks(
  kind: PlanningOwner["kind"],
  ownerId: string | undefined,
  matches: (launch: PlanningLaunch) => boolean,
  effortId?: string,
): void {
  if (!existsSync(join(getAgentDir(), "keylime", "planning.sqlite"))) return;
  const db = database();
  try {
    const complete = db.transaction(() => {
      if (
        effortId !== undefined &&
        db
          .query("SELECT 1 FROM completed_efforts WHERE effort_id = ?")
          .get(effortId)
      )
        return;
      let matched = false;
      const boards =
        ownerId === undefined
          ? db
              .query<{ owner_id: string; data: string }, [string]>(
                "SELECT owner_id, data FROM boards WHERE kind = ?",
              )
              .all(kind)
          : db
              .query<{ owner_id: string; data: string }, [string, string]>(
                "SELECT owner_id, data FROM boards WHERE kind = ? AND owner_id = ?",
              )
              .all(kind, ownerId);
      const update = db.query(
        "UPDATE boards SET data = ? WHERE kind = ? AND owner_id = ?",
      );
      for (const { owner_id, data } of boards) {
        const board: SavedBoard = JSON.parse(data);
        let changed = false;
        for (const task of board.tasks) {
          if (!task.launch || !matches(task.launch)) continue;
          matched = true;
          if (task.status === "done") continue;
          task.status = "done";
          task.revision++;
          changed = true;
        }
        if (changed) update.run(JSON.stringify(board), kind, owner_id);
      }
      if (matched && effortId !== undefined)
        db.run("INSERT INTO completed_efforts (effort_id) VALUES (?)", [
          effortId,
        ]);
    });
    // Match the writer locking used by planningOperation, including across processes.
    complete.immediate();
  } finally {
    db.close(true);
  }
}

/** Match the registered creation ID, even before the launch path is saved. */
export function completePlanningWorkspace(
  projectPath: string,
  workspacePath: string,
): void {
  const project = readHierarchy().projects.find(
    ({ path }) => path === projectPath,
  );
  const workspace = project?.workspaces?.find(
    ({ path }) => path === workspacePath,
  );
  const jobId = workspace?.setup?.jobId;
  if (!project || !jobId) return;
  completePlanningTasks(
    "repo",
    project.id,
    (launch) =>
      launch.id === jobId &&
      launch.setup?.kind === "repo" &&
      launch.setup.projectPath === projectPath &&
      (launch.path === undefined || launch.path === workspacePath),
  );
}

/** Effort creation uses the launch ID before its result is saved to the board. */
export function completePlanningEffort(effortId: string): void {
  completePlanningTasks(
    "system",
    undefined,
    (launch) =>
      launch.effortId === effortId ||
      (launch.effortId === undefined && launch.id === effortId),
    effortId,
  );
}

/** This daemon owns every board mutation; never write notes or launch state into a checkout. */
export async function planningOperation(
  operation: unknown,
  listSystems: () => Promise<SystemsResult>,
): Promise<PlanningBoard> {
  if (!Value.Check(PlanningOperationSchema, operation))
    invalid("Invalid planning request");
  const { owner, input } = operation;
  const { name, canLaunch, path } = await ownerInfo(owner, listSystems);
  const readsOnly =
    input.action === "read" ||
    input.action === "readImages" ||
    input.action === "readTaskImages" ||
    input.action === "readLaunchImages";
  const db = database();
  try {
    const run = db.transaction((): PlanningBoard => {
      const saved = db
        .query<{ data: string }, [string, string]>(
          "SELECT data FROM boards WHERE kind = ? AND owner_id = ?",
        )
        .get(owner.kind, owner.id);
      const initial: SavedBoard = saved
        ? JSON.parse(saved.data)
        : { notes: "", notesRevision: 0, tasks: [] };
      const board = { ...initial, name, canLaunch };
      const changesImages =
        input.action === "saveNotes" || input.action === "saveTask"
          ? input.images !== undefined
          : input.action === "deleteTask" || input.action === "prepareLaunch";
      const beforeImages = changesImages ? boardImageRefs(board) : [];
      const task =
        "taskId" in input
          ? board.tasks.find(({ id }) => id === input.taskId)
          : undefined;
      if ("taskId" in input && input.taskId !== undefined && !task)
        throw new HostOpError(
          404,
          "planning_task_not_found",
          "Planned task not found",
        );
      switch (input.action) {
        case "read":
          return board;
        case "readImages":
        case "readTaskImages":
        case "readLaunchImages": {
          const launch = task?.launch;
          let images: PlanningImageRef[];
          if (input.action === "readLaunchImages") {
            if (
              !launch?.taskImagesOnly ||
              launch.phase !== "ready" ||
              launch.id !== input.id ||
              launch.version !== input.version
            )
              launchConflict();
            images = launch.images ?? [];
          } else {
            const visible =
              input.action === "readTaskImages"
                ? (task?.images ?? [])
                : boardImageRefs(board);
            const refs = new Map(visible.map((image) => [image.id, image]));
            images = input.ids.map((id) => {
              const ref = refs.get(id);
              if (!ref)
                throw new HostOpError(
                  404,
                  "planning_image_not_found",
                  "Image not found in this attachment list",
                );
              return ref;
            });
          }
          checkImageBudget(images, "A request");
          const select = db.query<{ data: string }, [string]>(
            "SELECT data FROM images WHERE id = ?",
          );
          return {
            ...board,
            imagePayloads: images.map(({ id, mimeType }) => {
              const row = select.get(id);
              if (!row)
                throw new HostOpError(
                  404,
                  "planning_image_not_found",
                  "Saved image is missing",
                );
              return { type: "image" as const, mimeType, data: row.data };
            }),
          };
        }
        case "saveNotes":
          checkRevision(board.notesRevision, input.revision);
          board.notes = input.notes;
          if (input.images !== undefined)
            board.notesImages = replaceImages(
              db,
              board.notesImages,
              input.images,
            );
          board.notesRevision++;
          break;
        case "saveTask": {
          const { brief, prompt, status } = input;
          if (!brief.trim()) invalid("A task brief is required");
          if (task) {
            checkRevision(task.revision, input.revision);
            Object.assign(task, {
              brief,
              prompt,
              status,
              ...(input.images === undefined
                ? {}
                : { images: replaceImages(db, task.images, input.images) }),
              revision: task.revision + 1,
            });
          } else {
            if (input.revision !== undefined)
              invalid("A new task must not specify a revision");
            board.tasks.push({
              id: randomUUID(),
              revision: 0,
              brief,
              prompt,
              ...(input.images === undefined
                ? {}
                : { images: replaceImages(db, undefined, input.images) }),
              status,
            });
          }
          break;
        }
        case "deleteTask": {
          if (!task) invalid("A task ID is required");
          checkRevision(task.revision, input.revision);
          if (
            task.launch &&
            ["creating", "ready", "sending"].includes(task.launch.phase)
          )
            launchConflict();
          board.tasks.splice(board.tasks.indexOf(task), 1);
          break;
        }
        case "begin":
          if (!task) invalid("A task ID is required");
          if (task.launch?.id === input.id) return board;
          if (
            task.launch ||
            board.tasks.some((other) => other.launch?.id === input.id)
          )
            launchConflict();
          checkRevision(task.revision, input.revision);
          if (!canLaunch)
            throw new HostOpError(
              409,
              "planning_launch_unavailable",
              "This owner cannot launch tasks",
            );
          if (
            input.setup.kind !== owner.kind ||
            (input.setup.kind === "repo" && input.setup.projectPath !== path)
          )
            invalid("Launch setup does not belong to this owner");
          const contextImages = task.images ?? [];
          checkImageBudget(contextImages, "A launch");
          task.launch = {
            id: input.id,
            version: 0,
            phase: "creating",
            prompt: task.prompt.trim() ? task.prompt : task.brief,
            ...(contextImages.length ? { images: contextImages } : {}),
            taskImagesOnly: true,
            name: input.name,
            setup: input.setup,
          };
          if (task.status !== "done") task.status = "in_progress";
          task.revision++;
          break;
        case "prepareLaunch": {
          const launch = task?.launch;
          if (
            !task ||
            !launch ||
            launch.id !== input.id ||
            launch.version !== input.version ||
            launch.phase === "sending" ||
            launch.phase === "sent" ||
            launch.phase === "delivery_unknown"
          )
            launchConflict();
          if (launch.taskImagesOnly) return board;
          cutOverTaskImages(board, task, launch);
          break;
        }
        case "updateLaunch":
          if (!task?.launch || !isDeepStrictEqual(task.launch, input.expected))
            launchConflict();
          if (task.launch.phase === "review_required" && !canLaunch)
            throw new HostOpError(
              409,
              "planning_launch_unavailable",
              "Restore this System before resuming the launch",
            );
          checkTransition(task.launch, input.next);
          task.launch = input.next;
          task.revision++;
          break;
      }
      if (!Value.Check(PlanningBoardSchema, board))
        invalid("Invalid planning board state");
      const data: SavedBoard = {
        notes: board.notes,
        notesImages: board.notesImages,
        notesRevision: board.notesRevision,
        tasks: board.tasks,
      };
      if (Buffer.byteLength(JSON.stringify(board)) > LINK_LIMITS.blobBytes)
        throw new HostOpError(
          413,
          "planning_board_too_large",
          "The planning board is too large to return over the host link",
        );
      db.run(
        `INSERT INTO boards (kind, owner_id, data) VALUES (?, ?, ?)
        ON CONFLICT (kind, owner_id) DO UPDATE SET data = excluded.data`,
        [owner.kind, owner.id, JSON.stringify(data)],
      );
      if (beforeImages.length) {
        const retained = new Set(boardImageRefs(board).map(({ id }) => id));
        const remove = db.query("DELETE FROM images WHERE id = ?");
        for (const { id } of beforeImages)
          if (!retained.has(id)) remove.run(id);
      }
      return board;
    });
    // Hold the writer lock from before the read through commit, including across daemon processes.
    return readsOnly ? run() : run.immediate();
  } finally {
    db.close(true);
  }
}
