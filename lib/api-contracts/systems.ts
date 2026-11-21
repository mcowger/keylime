import { Type, type Static } from "@sinclair/typebox";
import { WorkspaceBranchesSchema } from "./workspace-models";

const text = Type.String();
const optional = Type.Optional;
const choice = <T extends string>(...options: T[]) =>
  Type.Union(options.map((option) => Type.Literal(option)));

const serviceDefinition = Type.Object({
  id: text,
  name: text,
  command: Type.String({
    description: "Foreground shell command run as the host daemon user.",
  }),
});
const systemDefinition = Type.Object({
  name: text,
  repoPaths: Type.Array(
    Type.String({
      description:
        "Existing Git checkout path on the selected daemon; stored Systems use canonical Repo paths.",
    }),
  ),
  services: Type.Array(serviceDefinition),
  instructions: Type.String({
    description: "User-written AGENTS.md body, copied at Effort creation.",
  }),
});
export const SystemSchema = Type.Composite(
  [
    systemDefinition,
    Type.Object({
      id: text,
      slug: text,
      archived: Type.Boolean(),
    }),
  ],
  { description: "A host-owned, reusable multi-repo definition." },
);
const memberPlan = Type.Object({
  repoPath: text,
  name: text,
  path: text,
  baseRef: text,
  baseCommit: text,
  skipsCustomCreate: Type.Boolean(),
  branches: optional(WorkspaceBranchesSchema),
});
export const EffortPlanSchema = Type.Object(
  {
    systemId: text,
    name: text,
    slug: text,
    root: text,
    branch: text,
    members: Type.Array(memberPlan),
    confirmation: Type.String({
      description:
        "Opaque fingerprint of the previewed definition, paths, and resolved Git commits.",
    }),
  },
  {
    description:
      "Non-mutating preview for creating one branch and worktree in each System member.",
  },
);
const effortMember = Type.Composite([
  memberPlan,
  Type.Object({
    status: choice(
      "pending",
      "running",
      "complete",
      "failed",
      "interrupted",
      "removed",
    ),
    jobId: optional(text),
    stage: optional(text),
    currentBranch: optional(Type.String({ description: "Current checked-out member branch, omitted when unavailable or detached." })),
    defaultBranch: optional(Type.String({ description: "Observed default branch of the member Repo, omitted when unknown." })),
    error: optional(text),
  }),
]);
const effortService = Type.Composite([
  serviceDefinition,
  Type.Object({
    status: choice("stopped", "running", "exited"),
    terminalId: optional(text),
    error: optional(text),
  }),
]);
export const EffortSchema = Type.Composite(
  [
    Type.Omit(EffortPlanSchema, ["members", "confirmation"]),
    Type.Object({
      id: text,
      systemName: text,
      status: choice(
        "creating",
        "failed",
        "ready",
        "cleaning",
        "cleanup_failed",
        "cleaned",
      ),
      members: Type.Array(effortMember),
      services: Type.Array(effortService),
      sessionIds: Type.Array(text),
      retainedPaths: optional(
        Type.Array(
          Type.String({
            description:
              "Files deliberately preserved at the Effort root after cleanup.",
          }),
        ),
      ),
      error: optional(text),
    }),
  ],
  {
    description:
      "Persisted Effort identity and member progress with current daemon terminal and chat ownership.",
  },
);
export const EffortCleanupPreviewSchema = Type.Object(
  {
    confirmation: text,
    processes: Type.Array(text),
    repos: Type.Array(
      Type.Object({
        path: text,
        dirty: Type.Array(text, {
          description:
            "Worktree-relative paths requiring force removal, including Git-ignored files or grouped ignored directories.",
        }),
        publication: text,
        openPrs: Type.Array(text),
      }),
    ),
  },
  {
    description:
      "Cleanup review. File paths and running processes are host-owned; publication and PR evidence can be unavailable.",
  },
);
const effortId = { effortId: text };
const planInput = {
  systemId: text,
  name: text,
  bases: optional(Type.Array(Type.Object({ repoPath: text, ref: text }))),
  branchKey: optional(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" })),
};
export const SystemsRequestSchema = Type.Union(
  [
    Type.Object({ action: Type.Literal("list") }),
    Type.Object({ action: Type.Literal("setRoot"), root: text }),
    Type.Object({
      action: Type.Literal("saveSystem"),
      id: optional(text),
      definition: systemDefinition,
    }),
    Type.Object({
      action: Type.Literal("archiveSystem"),
      id: text,
      archived: Type.Boolean(),
    }),
    Type.Object({
      action: Type.Literal("preview"),
      ...planInput,
      allowUnresolved: optional(Type.Boolean()),
    }),
    Type.Object({
      action: Type.Literal("create"),
      ...planInput,
      creationId: optional(
        Type.String({
          pattern: "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$",
          description:
            "Stable launch identity for idempotent Effort admission.",
        }),
      ),
      planningVersion: optional(
        Type.Integer({
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description:
            "Current planning launch version; required with a planned creation ID.",
        }),
      ),
      confirmation: text,
    }),
    Type.Object({
      action: Type.Literal("retry"),
      ...effortId,
      attempt: optional(Type.Integer({ minimum: 0 })),
    }),
    Type.Object({
      action: Type.Literal("renameEffort"),
      ...effortId,
      name: text,
    }),
    Type.Object({
      action: Type.Literal("service"),
      ...effortId,
      serviceId: text,
      operation: choice("start", "stop", "restart"),
    }),
    Type.Object({ action: Type.Literal("cleanupPreview"), ...effortId }),
    Type.Object({
      action: Type.Literal("cleanup"),
      ...effortId,
      mode: choice("stop", "remove", "force"),
      confirmation: text,
    }),
  ],
  {
    description:
      "Read or mutate Systems and Efforts on a single daemon. Creation and removal require matching previews.",
  },
);
export const SystemsResultSchema = Type.Object(
  {
    root: text,
    systems: Type.Array(SystemSchema),
    efforts: Type.Array(EffortSchema),
    preview: optional(EffortPlanSchema),
    cleanup: optional(EffortCleanupPreviewSchema),
    effortId: optional(text),
  },
  {
    description:
      "Current host state and the requested preview or admitted Effort ID, where applicable.",
  },
);
export const SystemsHttpPostSchema = Type.Object(
  { host: optional(text), input: SystemsRequestSchema },
  {
    description:
      "Send a Systems operation to the selected daemon. Omit host for this machine.",
  },
);

export type SystemsRequest = Static<typeof SystemsRequestSchema>;
export type SystemsResult = Static<typeof SystemsResultSchema>;
export type SystemDefinition = Static<typeof systemDefinition>;
export type SystemRecord = Static<typeof SystemSchema>;
export type EffortPlan = Static<typeof EffortPlanSchema>;
export type EffortRecord = Static<typeof EffortSchema>;
export type EffortCleanupPreview = Static<typeof EffortCleanupPreviewSchema>;
