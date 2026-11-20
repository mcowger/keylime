import { Type, type Static } from "@sinclair/typebox";
import { EffortPlanSchema } from "./systems";
import { WorkspaceBranchesSchema } from "./workspace-models";
import {
  MAX_ATTACHED_IMAGES,
  MAX_TOTAL_ATTACHED_IMAGE_BYTES,
} from "../image-attachments";

const text = Type.String();
const id = Type.String({ minLength: 1, maxLength: 128 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const notes = Type.String({
  maxLength: 128 * 1024,
  description: "Free-form Markdown saved verbatim outside the checkout.",
});
const prompt = Type.String({
  maxLength: 32 * 1024,
  description:
    "Full task brief, including line breaks, sent verbatim. If empty, the one-line task description is sent instead.",
});
const brief = Type.String({
  minLength: 1,
  maxLength: 240,
  pattern: "^[^\\r\\n]+$",
  description: "One-line task description.",
});
const choice = <T extends string>(...options: T[]) =>
  Type.Union(options.map((option) => Type.Literal(option)));
const optional = Type.Optional;

const imageName = Type.String({ minLength: 1, maxLength: 255 });
const imageMime = choice("image/png", "image/jpeg", "image/gif", "image/webp");
const imageData = Type.String({
  minLength: 4,
  maxLength: 4 * Math.ceil(MAX_TOTAL_ATTACHED_IMAGE_BYTES / 3),
  description: "Base64 image bytes, without a data URL prefix.",
});
const uploadImage = Type.Object(
  { name: imageName, mimeType: imageMime, data: imageData },
  { additionalProperties: false },
);
const imageRef = Type.Object({
  id,
  name: imageName,
  mimeType: imageMime,
  bytes: Type.Integer({ minimum: 1, maximum: MAX_TOTAL_ATTACHED_IMAGE_BYTES }),
});
const imageRefs = Type.Array(imageRef, { maxItems: MAX_ATTACHED_IMAGES });
const imageEdits = Type.Array(Type.Union([id, uploadImage]), {
  maxItems: MAX_ATTACHED_IMAGES,
  description:
    "Replacement attachment list. Use IDs to keep existing images, or include new image bytes. Omit to keep the list unchanged.",
});
const imagePayload = Type.Object({
  type: Type.Literal("image"),
  mimeType: imageMime,
  data: imageData,
});
const imageIds = Type.Array(id, {
  minItems: 1,
  maxItems: MAX_ATTACHED_IMAGES,
  uniqueItems: true,
});
export const PlanningImageQuerySchema = Type.Object(
  {
    host: optional(id),
    kind: choice("repo", "system"),
    ownerId: id,
    imageId: id,
  },
  {
    description:
      "Read one image currently attached to the selected board or a retained launch on its owning daemon.",
  },
);

export const PlanningOwnerSchema = Type.Object(
  { kind: choice("repo", "system"), id },
  {
    description:
      "Stable Repo or System registration ID on the selected daemon, never a path.",
    additionalProperties: false,
  },
);
export const PlanningStatusSchema = Type.Union(
  [
    Type.Literal("backlog"),
    Type.Literal("ready"),
    Type.Literal("in_progress"),
    Type.Literal("done"),
  ],
  {
    description:
      "Board column. Launch moves a task to In progress; Done is always set manually.",
  },
);
const bases = Type.Array(
  Type.Object({ repoPath: text, ref: text }, { additionalProperties: false }),
  { maxItems: 200 },
);
const setup = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal("repo"),
        projectPath: text,
        baseRef: text,
        branch: text,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("system"), name: text, confirmation: id, bases },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Host-derived setup choices captured at admission for recovery of the same launch.",
  },
);
export const PlanningLaunchSchema = Type.Object(
  {
    id,
    version: revision,
    phase: choice(
      "creating",
      "setup_failed",
      "review_required",
      "ready",
      "sending",
      "sent",
      "delivery_failed",
      "delivery_unknown",
    ),
    prompt,
    images: optional(imageRefs),
    taskImagesOnly: optional(
      Type.Literal(true, {
        description:
          "The launch image snapshot contains only proven task attachments.",
      }),
    ),
    name: brief,
    setup: optional(setup),
    jobId: optional(id),
    effortId: optional(id),
    path: optional(text),
    sessionId: optional(id),
    sendingSince: optional(
      Type.Integer({
        minimum: 0,
        description: "First-message claim time in epoch milliseconds.",
      }),
    ),
    retrySetup: optional(
      Type.Boolean({
        description:
          "An explicit setup retry is pending acknowledgement from the owning daemon.",
      }),
    ),
    error: optional(text),
  },
  {
    description:
      "Durable launch with the literal prompt and pinned task image snapshot. Legacy records without taskImagesOnly are not eligible for first-message delivery. Unknown delivery is never retried.",
    additionalProperties: false,
  },
);
export const PlanningTaskSchema = Type.Object(
  {
    id,
    revision,
    brief,
    prompt,
    images: optional(imageRefs),
    status: PlanningStatusSchema,
    launch: optional(PlanningLaunchSchema),
  },
  {
    description:
      "A planned task. Done is a manual board status, independent of launch and chat status.",
  },
);
export const PlanningBoardSchema = Type.Object(
  {
    name: text,
    canLaunch: Type.Boolean(),
    notes,
    notesImages: optional(imageRefs),
    notesRevision: revision,
    tasks: Type.Array(PlanningTaskSchema),
    imagePayloads: optional(
      Type.Array(imagePayload, {
        maxItems: MAX_ATTACHED_IMAGES,
        description:
          "Returned only when reading specific attached images; never included in board listings.",
      }),
    ),
  },
  {
    description:
      "Host-owned Markdown notebook and task board. Revisions detect concurrent edits.",
  },
);

const read = Type.Object(
  { action: Type.Literal("read") },
  { additionalProperties: false },
);
const saveNotes = Type.Object(
  {
    action: Type.Literal("saveNotes"),
    notes,
    revision,
    images: optional(imageEdits),
  },
  { additionalProperties: false },
);
const taskId = { taskId: id };
const saveTask = Type.Object(
  {
    action: Type.Literal("saveTask"),
    taskId: optional(id),
    revision: optional(revision),
    brief,
    prompt,
    images: optional(imageEdits),
    status: PlanningStatusSchema,
  },
  { additionalProperties: false },
);
const deleteTask = Type.Object(
  { action: Type.Literal("deleteTask"), ...taskId, revision },
  { additionalProperties: false },
);
const crud = [read, saveNotes, saveTask, deleteTask] as const;
const readImages = Type.Object(
  { action: Type.Literal("readImages"), ids: imageIds },
  { additionalProperties: false },
);
const readTaskImages = Type.Object(
  { action: Type.Literal("readTaskImages"), ...taskId, ids: imageIds },
  { additionalProperties: false },
);
const readLaunchImages = Type.Object(
  {
    action: Type.Literal("readLaunchImages"),
    ...taskId,
    id,
    version: revision,
  },
  { additionalProperties: false },
);
const prepareLaunch = Type.Object(
  {
    action: Type.Literal("prepareLaunch"),
    ...taskId,
    id,
    version: revision,
  },
  { additionalProperties: false },
);
const begin = Type.Object(
  { action: Type.Literal("begin"), ...taskId, revision, id, setup },
  { additionalProperties: false },
);
const updateLaunch = Type.Object(
  {
    action: Type.Literal("updateLaunch"),
    ...taskId,
    expected: PlanningLaunchSchema,
    next: PlanningLaunchSchema,
  },
  { additionalProperties: false },
);
export const PlanningOperationSchema = Type.Object(
  {
    owner: PlanningOwnerSchema,
    input: Type.Union([
      ...crud,
      readImages,
      readTaskImages,
      readLaunchImages,
      prepareLaunch,
      begin,
      updateLaunch,
    ]),
  },
  {
    description:
      "Daemon planning operation. Launch lifecycle mutations are internal to the web server.",
    additionalProperties: false,
  },
);
const reviewInput = Type.Object(
  { confirmation: id, baseRef: optional(text), bases: optional(bases) },
  { additionalProperties: false },
);
const httpInput = Type.Union([
  ...crud,
  Type.Object(
    {
      action: Type.Literal("draft"),
      brief: Type.String({
        minLength: 1,
        maxLength: 32 * 1024,
        description: "Current contents of the Brief editor to improve.",
      }),
      taskId: optional(id),
      images: optional(
        Type.Array(Type.Union([id, uploadImage]), {
          maxItems: MAX_ATTACHED_IMAGES,
          description:
            "Task editor images in order: saved IDs from this task or unsaved uploads. Notes images are not included.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("launch"),
      ...taskId,
      revision,
      review: optional(reviewInput),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("resume"),
      ...taskId,
      review: optional(reviewInput),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("refresh"), ...taskId },
    { additionalProperties: false },
  ),
]);
export const PlanningHttpRequestSchema = Type.Object(
  { host: optional(id), owner: PlanningOwnerSchema, input: httpInput },
  {
    description:
      "Read or edit a board, ask for an unsaved draft, or launch a saved task. Omit host for this machine.",
    additionalProperties: false,
  },
);
export const PlanningLaunchReviewSchema = Type.Object(
  {
    confirmation: id,
    name: text,
    repo: optional(
      Type.Object({ branches: WorkspaceBranchesSchema, baseRef: text }),
    ),
    effort: optional(EffortPlanSchema),
  },
  {
    description:
      "Review required before creating a Workspace or Effort. Echo the confirmation and any chosen refs to continue.",
  },
);
export const PlanningResultSchema = Type.Object(
  {
    board: optional(PlanningBoardSchema),
    draft: optional(prompt),
    review: optional(PlanningLaunchReviewSchema),
  },
  {
    description:
      "Board snapshot, unsaved model suggestion, or one-time setup review, depending on the operation.",
  },
);

export type PlanningOwner = Static<typeof PlanningOwnerSchema>;
export type PlanningStatus = Static<typeof PlanningStatusSchema>;
export type PlanningTask = Static<typeof PlanningTaskSchema>;
export type PlanningBoard = Static<typeof PlanningBoardSchema>;
export type PlanningLaunch = Static<typeof PlanningLaunchSchema>;
export type PlanningOperation = Static<typeof PlanningOperationSchema>;
export type PlanningLaunchReview = Static<typeof PlanningLaunchReviewSchema>;
export type PlanningHttpInput = Static<typeof httpInput>;
export type PlanningResult = Static<typeof PlanningResultSchema>;
export type PlanningImageRef = Static<typeof imageRef>;
export type PlanningImageEdit = Static<typeof imageEdits>[number];
