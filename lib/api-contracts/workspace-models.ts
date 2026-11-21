import { Type, type TSchema } from "@sinclair/typebox";
import { ProjectLaunchConfigSchema, SessionInfoSchema } from "./domain";
import { ShipPrDigestSchema } from "./host-schemas";
export { TerminalEventSchema, WorkspaceFileEventSchema } from "./host-schemas";

// Bootstrapped from the workspace TypeScript declarations using TypeScriptToTypeBox.
const nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const strings = () => Type.Array(Type.String());
const literals = <T extends string>(...values: T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
export const WorkspaceBranchModeSchema = Type.Union(
  [Type.Literal("local"), Type.Literal("remote"), Type.Literal("new")],
  {
    description:
      "Choose an existing local or remote branch, or create a new branch from a base ref.",
  },
);
export const WorkspacePipelineSchema = Type.Object(
  {
    pre: strings(),
    create: strings(),
    postBlocking: strings(),
    postNonBlocking: strings(),
  },
  {
    description:
      "Ordered shell commands run before creation, during creation, and in blocking and non-blocking post-creation phases.",
  },
);
export const WorkspacePaseoPreviewSchema = Type.Object(
  {
    path: Type.String(),
    setup: strings(),
    teardown: strings(),
    includePath: Type.String(),
    includePatterns: strings(),
    unsupportedFeatures: strings(),
    fingerprint: Type.Optional(Type.String()),
    missing: Type.Optional(Type.Boolean()),
    error: Type.Optional(Type.String()),
  },
  {
    description:
      "Preview of a host Paseo configuration, including setup, teardown, include patterns, unsupported features and fingerprint or read error.",
  },
);
const paseoBlocking = Type.Array(
  Type.Object({ index: Type.Number(), command: Type.String() }),
);
const source = literals("manual", "paseo");
export const WorkspaceCreationSettingsSchema = Type.Object(
  {
    defaults: WorkspacePipelineSchema,
    override: nullable(WorkspacePipelineSchema),
    source,
    paseoBlocking,
    paseo: nullable(WorkspacePaseoPreviewSchema),
  },
  {
    description:
      "Creation pipeline defaults and nullable project override, with their source and optional Paseo preview.",
  },
);
export const WorkspaceSettingsRequestSchema = Type.Object(
  {
    projectPath: Type.Optional(Type.String()),
    defaults: Type.Optional(WorkspacePipelineSchema),
    override: Type.Optional(
      Type.Union([WorkspacePipelineSchema, Type.Null()], {
        description:
          "Omit to leave unchanged; null clears the project pipeline override.",
      }),
    ),
    source: Type.Optional(source),
    paseoBlocking: Type.Optional(paseoBlocking),
  },
  {
    description:
      "Partial creation-settings update; omitted fields are unchanged and a null override clears the project override.",
  },
);
export const WorkspaceCreateRequestSchema = Type.Object(
  {
    projectPath: Type.String(),
    branch: Type.String(),
    mode: WorkspaceBranchModeSchema,
    baseRef: Type.String(),
    name: Type.String(),
    creationId: Type.Optional(Type.String({ format: "uuid" })),
    retryAttempt: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  {
    description:
      "Request to create a workspace under a host project using a branch mode, branch, base ref and name.",
  },
);
export const workspaceBaseRefPattern =
  /^(?:refs\/(?:heads|remotes)\/[^\s]+|refs\/pull\/[1-9]\d*\/head)$/;
export const WorkspacePrepareRequestSchema = Type.Object(
  {
    projectPath: Type.String({
      description: "Registered project path on the owning host.",
    }),
    prompt: Type.String({
      description:
        "First chat prompt, used to name the workspace and its branch.",
    }),
    baseRef: Type.String({
      pattern: workspaceBaseRefPattern.source,
      description:
        "Selected full local or remote-tracking ref, or refs/pull/<number>/head for a GitHub pull request.",
    }),
  },
  {
    description:
      "Start a new chat workspace from a selected Git source on the owning host.",
  },
);
export const WorkspaceCreationJobSchema = Type.Object(
  {
    id: Type.String(),
    input: WorkspaceCreateRequestSchema,
    pipeline: WorkspacePipelineSchema,
    source: Type.Optional(source),
    paseo: Type.Optional(
      Type.Object({ path: Type.String(), fingerprint: Type.String() }),
    ),
    status: Type.Union(
      [
        Type.Literal("running"),
        Type.Literal("complete"),
        Type.Literal("failed"),
        Type.Literal("interrupted"),
      ],
      {
        description:
          "Overall job state; running jobs recovered after daemon restart become interrupted.",
      },
    ),
    stage: Type.Union(
      [
        Type.Literal("pre"),
        Type.Literal("create"),
        Type.Literal("postBlocking"),
        Type.Literal("postNonBlocking"),
      ],
      {
        description:
          "Current pipeline phase, independent of overall job status.",
      },
    ),
    logs: Type.String({
      description: "Captured command output for this creation job.",
    }),
    error: Type.Optional(Type.String()),
    workspacePath: Type.Optional(
      Type.String({
        description: "Created workspace path on the host, when available.",
      }),
    ),
    workspaceId: Type.Optional(Type.String()),
    nextCommand: Type.Optional(Type.Integer({ minimum: 0 })),
    includesDone: Type.Optional(Type.Boolean()),
    retryAttempt: Type.Optional(Type.Integer({ minimum: 0 })),
    baseCommit: Type.Optional(Type.String()),
  },
  {
    description:
      "Recorded asynchronous creation job, including its captured pipeline, current stage, logs, outcome and eventual workspace identity.",
  },
);
export const WorkspaceBranchesSchema = Type.Object(
  {
    local: strings(),
    remote: strings(),
    defaultRef: Type.String({
      description:
        "Full Git ref for the default base, or an empty string if no default is available.",
    }),
    originAheadRef: Type.Union([Type.String(), Type.Null()], {
      description:
        "Full origin default ref if it contains commits missing from its local counterpart, otherwise null.",
    }),
    otherRefs: Type.Array(Type.String(), {
      description:
        "Full local and remote-tracking refs not checked out in a worktree, excluding the primary choices. Local refs appear first.",
    }),
    pullRequests: Type.Union(
      [
        Type.Array(
          Type.Object({
            number: Type.Integer({ minimum: 1 }),
            title: Type.String(),
            isDraft: Type.Boolean(),
          }),
        ),
        Type.Null(),
      ],
      {
        description:
          "Open GitHub pull requests, including drafts. Null if GitHub is configured but the host couldn't load the list.",
      },
    ),
  },
  {
    description:
      "Point-in-time local and remote branch choices and default base ref for a host project.",
  },
);
export const WorkspaceDeleteRequestSchema = Type.Object(
  {
    projectPath: Type.String(),
    path: Type.String(),
    stopProcesses: Type.Boolean({
      description: "Permit stopping processes associated with the worktree.",
    }),
    discardChanges: Type.Boolean({
      description: "Permit deletion despite uncommitted worktree changes.",
    }),
    keepBranch: Type.Optional(
      Type.Boolean({
        description:
          "When supplied, choose whether to retain the worktree branch.",
      }),
    ),
    cancel: Type.Optional(Type.Boolean()),
  },
  {
    description:
      "Worktree removal request with explicit choices for running processes, dirty changes and branch retention.",
  },
);
export const WorkspaceDeleteResultSchema = Type.Object(
  {
    status: literals("deleted", "processes", "dirty", "branch", "cancelled"),
    processes: Type.Optional(
      Type.Array(Type.Object({ id: Type.String(), cwd: Type.String() })),
    ),
    branch: Type.Optional(Type.String()),
  },
  {
    description:
      "Removal outcome or a decision required for processes, dirty changes or the branch; cancellation is distinct from deletion.",
  },
);
export const VcsHunkSelectionSchema = Type.Union(
  [
    Type.Object(
      { path: Type.String({ minLength: 1 }), kind: Type.Literal("all") },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        path: Type.String({ minLength: 1 }),
        kind: Type.Literal("indices"),
        indices: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        path: Type.String({ minLength: 1 }),
        kind: Type.Literal("lines"),
        start: Type.Integer({ minimum: 1 }),
        end: Type.Integer({
          minimum: 1,
          description: "Inclusive end line; must be at least start.",
        }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Select all changes, one-based hunk indices, or an inclusive line range in a repository-relative file.",
  },
);
export const CommitPlanCommitSchema = Type.Object(
  {
    message: Type.String(),
    files: strings(),
    changes: Type.Optional(Type.Array(VcsHunkSelectionSchema)),
    dependencies: Type.Optional(Type.Array(Type.Number())),
  },
  {
    description:
      "Proposed commit message and files, optionally narrowing changes to hunks and declaring dependencies on other commits.",
  },
);
export const CommitPlanChangelogSchema = Type.Object(
  {
    path: Type.String(),
    entries: Type.Record(Type.String(), strings()),
    deletions: Type.Optional(Type.Record(Type.String(), strings())),
  },
  {
    description:
      "Proposed changelog entries and optional deletions grouped by section for a repository path.",
  },
);
export const CommitPlanSchema = Type.Object(
  {
    kind: literals("single", "split"),
    commits: Type.Array(CommitPlanCommitSchema),
    changelog: Type.Array(CommitPlanChangelogSchema),
    warnings: strings(),
    usedFallback: Type.Boolean(),
  },
  {
    description:
      "Generated single or split commit plan, its changelog edits, warnings and fallback indicator.",
  },
);
export const CommitApplyResultSchema = Type.Object(
  {
    commits: Type.Array(
      Type.Object({ sha: Type.String(), subject: Type.String() }),
    ),
    changelogFiles: strings(),
  },
  {
    description:
      "Created commit hashes and subjects and the changelog files affected by applying a plan.",
  },
);
export const PrDescriptionSchema = Type.Object(
  {
    title: Type.String(),
    body: Type.String(),
  },
  { description: "Title and body used when creating a pull request." },
);
export const ShipModeSchema = Type.Union(
  [Type.Literal("local"), Type.Literal("pr"), Type.Literal("pr-auto")],
  {
    description:
      "Land locally, create a pull request, or enable auto-merge on a new or existing pull request.",
  },
);
export const ShipMergeMethodSchema = Type.Union(
  [Type.Literal("squash"), Type.Literal("merge"), Type.Literal("rebase")],
  {
    description:
      "GitHub pull-request merge strategy: squash, merge commit or rebase.",
  },
);
export const ShipPrMonitorSchema = Type.Object(
  {
    id: Type.String({
      description:
        "Watch generation ID used to stop this watch without affecting a replacement.",
    }),
    state: Type.Union(
      [
        Type.Literal("watching"),
        Type.Literal("error"),
        Type.Literal("delivery-expired"),
      ],
      {
        description:
          "Active watch health: watching, polling error, or expired delivery.",
      },
    ),
  },
  {
    description:
      "Public state of an existing PR feedback watch. No routing or chat details.",
  },
);
export const ShipPrSchema = Type.Object(
  {
    number: Type.Number(),
    url: Type.String(),
    state: literals("open", "merged", "closed"),
    checks: literals("pending", "passing", "failing", "none"),
    autoMerge: Type.Boolean(),
    cleanup: Type.Boolean(),
    checkedAt: Type.String({ description: "ISO time of the last gh pr view." }),
    monitor: Type.Optional(ShipPrMonitorSchema),
  },
  {
    description:
      "Last observed pull-request identity, merge/check state, auto-merge and cleanup settings.",
  },
);
export const ShipPreviewSchema = Type.Object(
  {
    branch: Type.Union([Type.String(), Type.Null()], {
      description: "Checked-out workspace branch, or null for detached HEAD.",
    }),
    base: Type.String(),
    baseCheckout: Type.String(),
    ahead: Type.Number({
      description:
        "Number of commits the workspace branch is ahead of the base.",
    }),
    behind: Type.Number({
      description: "Number of commits the workspace branch is behind the base.",
    }),
    dirty: Type.Boolean(),
    baseDirty: Type.Boolean(),
    issues: strings(),
    github: Type.Object({
      repo: nullable(Type.String()),
      gh: literals("ok", "missing", "unauthenticated"),
      prLookupError: Type.Union([Type.String(), Type.Null()], {
        description:
          "Pull request discovery error, or null if discovery did not fail. A failed lookup leaves the existence of a PR unknown.",
      }),
    }),
    pr: Type.Union([ShipPrSchema, Type.Null()], {
      description:
        "Open pull request for the branch when found; null when none was found or discovery failed. Check github.prLookupError before interpreting null.",
    }),
  },
  {
    description:
      "Point-in-time shipping preflight for a registered worktree, base checkout, GitHub availability and pull request.",
  },
);
export const ShipRequestSchema = Type.Object(
  {
    projectPath: Type.String(),
    path: Type.String(),
    mode: ShipModeSchema,
    rebase: Type.Boolean(),
    monitorSessionId: Type.Optional(
      Type.String({
        description:
          "Chat to notify about new PR feedback. Omit to leave monitoring off. Only valid in PR modes; monitoring does not gate merges.",
      }),
    ),
    pr: Type.Optional(
      Type.Object(PrDescriptionSchema.properties, {
        description:
          "Required with nonempty title and body when creating a pull request; not required when auto-merging an existing open pull request.",
      }),
    ),
    mergeMethod: Type.Optional(
      Type.Union(
        [Type.Literal("squash"), Type.Literal("merge"), Type.Literal("rebase")],
        { description: "Auto-merge method; defaults to squash when omitted." },
      ),
    ),
    cleanup: Type.Boolean({
      description:
        "Request eventual cleanup; local cleanup stops processes, archives sessions and removes the worktree and branch.",
    }),
  },
  {
    description:
      "Start shipping a registered host worktree with mode, optional rebase and PR options, and cleanup choice.",
  },
);
export const SHIP_MONITOR_GRANT_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export const ShipStartInputSchema = Type.Object(
  {
    ...ShipRequestSchema.properties,
    monitorGrantId: Type.Optional(
      Type.String({ pattern: SHIP_MONITOR_GRANT_ID_PATTERN }),
    ),
  },
  {
    description:
      "Start a Ship job on the host. For PR monitoring, pair the server-issued grant ID with the target chat ID.",
  },
);

const monitorPath = Type.String({ minLength: 1, pattern: "^[^\\x00]+$" });
export const ShipStartMonitorRequestSchema = Type.Object(
  {
    projectPath: monitorPath,
    path: monitorPath,
    prUrl: ShipPrDigestSchema.properties.prUrl,
    sessionId: ShipPrDigestSchema.properties.sessionId,
  },
  {
    additionalProperties: false,
    description:
      "Start watching the exact recorded open PR from a chat in its workspace.",
  },
);
export const ShipStartMonitorHttpRequestSchema = Type.Object(
  {
    host: Type.Optional(Type.String({ minLength: 1 })),
    ...ShipStartMonitorRequestSchema.properties,
  },
  {
    additionalProperties: false,
    description:
      "Start a watch on the selected host (this machine when omitted) for an open PR and its target chat.",
  },
);
export const ShipStartMonitorInputSchema = Type.Object(
  {
    ...ShipStartMonitorRequestSchema.properties,
    monitorId: Type.String({ pattern: SHIP_MONITOR_GRANT_ID_PATTERN }),
  },
  {
    additionalProperties: false,
    description:
      "Start the watch on the owning daemon under the initiating server's grant ID.",
  },
);

export const ShipMonitorStatusResultSchema = Type.Object(
  {
    watch: Type.Union([
      Type.Null(),
      Type.Object(
        { sessionId: Type.String(), prUrl: Type.String() },
        { additionalProperties: false },
      ),
    ]),
  },
  {
    additionalProperties: false,
    description:
      "Current PR watch for the requesting server and exact monitor generation, or null when no matching watch has a live chat.",
  },
);

export const ShipStopMonitorRequestSchema = Type.Object(
  {
    projectPath: Type.String(),
    path: Type.String(),
    monitorId: Type.String({
      description: "Monitor generation shown on the workspace pull request.",
    }),
  },
  {
    description:
      "Stop the named PR monitor generation for a registered workspace on the selected host.",
  },
);

export const ShipStopMonitorResultSchema = Type.Object(
  {
    stopped: Type.Boolean({
      description:
        "False if the monitor was already absent or a different generation is active.",
    }),
  },
  { description: "Result of a request to stop monitoring PR feedback." },
);

export const ShipStepNameSchema = Type.Union(
  [
    Type.Literal("rebase"),
    Type.Literal("fastForward"),
    Type.Literal("push"),
    Type.Literal("createPr"),
    Type.Literal("autoMerge"),
    Type.Literal("pullBase"),
    Type.Literal("archiveSessions"),
    Type.Literal("removeWorkspace"),
  ],
  {
    description:
      "Named stage in the ship or finish sequence, including potentially destructive workspace cleanup.",
  },
);
export const ShipStepSchema = Type.Object(
  {
    name: ShipStepNameSchema,
    status: literals("pending", "running", "done", "skipped", "failed"),
    detail: Type.Optional(Type.String()),
  },
  {
    description:
      "Recorded progress and optional detail for one ship sequence step.",
  },
);
const shipKind = literals("ship", "finish"),
  shipStatus = literals(
    "running",
    "complete",
    "failed",
    "conflict",
    "interrupted",
  );
export const ShipJobSchema = Type.Object(
  {
    id: Type.String(),
    kind: shipKind,
    projectPath: Type.String(),
    path: Type.String(),
    mode: Type.Optional(ShipModeSchema),
    status: shipStatus,
    steps: Type.Array(ShipStepSchema, {
      description:
        "Ordered step states; failed or interrupted jobs may have already applied earlier steps.",
    }),
    logs: Type.String(),
    error: Type.Optional(Type.String()),
    conflictFiles: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Files with conflicts observed when the rebase step failed, when available.",
      }),
    ),
    pr: Type.Optional(ShipPrSchema),
    landedSha: Type.Optional(Type.String()),
  },
  {
    description:
      "Persisted asynchronous ship or finish job with ordered steps, logs, outcome and optional conflict or landed commit details.",
  },
);
export const WorkspaceShipStateSchema = Type.Object(
  {
    pr: Type.Optional(ShipPrSchema),
    job: Type.Optional(
      Type.Object({ id: Type.String(), kind: shipKind, status: shipStatus }),
    ),
  },
  {
    description:
      "Most recent recorded PR and job summary attached to a workspace in the hierarchy.",
  },
);
export const GitFileStatusKindSchema = Type.Union(
  [
    Type.Literal("modified"),
    Type.Literal("added"),
    Type.Literal("deleted"),
    Type.Literal("renamed"),
    Type.Literal("untracked"),
    Type.Literal("conflict"),
  ],
  {
    description:
      "Normalized Git file change category, including unresolved conflict and untracked file.",
  },
);
export const GitCollapseReasonSchema = Type.Union(
  [
    Type.Literal("generated"),
    Type.Literal("vendored"),
    Type.Literal("documentation"),
    Type.Literal("no-diff"),
  ],
  {
    description:
      "Reason the UI can initially collapse a file's diff, such as generated or vendored content.",
  },
);
export const GitFileStatusSchema = Type.Object(
  {
    filePath: Type.String(),
    status: GitFileStatusKindSchema,
    code: literals("M", "A", "D", "R", "U", "C"),
    indexStatus: Type.String(),
    worktreeStatus: Type.String(),
    collapseReason: Type.Optional(GitCollapseReasonSchema),
  },
  {
    description:
      "Git status for a file, including normalized category and separate raw index and worktree status codes.",
  },
);
export const GitStatusResponseSchema = Type.Object(
  {
    isGitRepository: Type.Boolean(),
    repositoryRoot: nullable(Type.String()),
    files: Type.Array(GitFileStatusSchema),
  },
  {
    description:
      "Git status snapshot for a host directory, with nullable repository root and changed files.",
  },
);
export const GitFileDiffResponseSchema = Type.Object(
  {
    supported: Type.Boolean(),
    status: Type.Optional(GitFileStatusKindSchema),
    patch: Type.Optional(Type.String()),
  },
  {
    description:
      "File diff observation; unsupported files need not have a patch or status.",
  },
);
export const WorkspaceTerminalSchema = Type.Object(
  {
    id: Type.String(),
    cwd: Type.String(),
    title: Type.String(),
    cols: Type.Number({ description: "Terminal width in character columns." }),
    rows: Type.Number({ description: "Terminal height in character rows." }),
  },
  {
    description:
      "Host-daemon terminal identity, working directory, title and dimensions in columns and rows.",
  },
);
export const TerminalSnapshotSchema = Type.Object(
  {
    terminal: WorkspaceTerminalSchema,
    snapshot: Type.String(),
    cursor: Type.Number({
      description: "Output-stream position associated with this snapshot.",
    }),
  },
  {
    description:
      "Terminal screen snapshot and output cursor for continuing the terminal stream.",
  },
);
export const HierarchyWorkspaceSchema = Type.Object(
  {
    id: Type.String(),
    projectId: Type.String(),
    path: Type.String(),
    name: Type.String(),
    isDefault: Type.Boolean(),
    branch: Type.Optional(Type.String()),
    sessionIds: strings(),
    unavailable: Type.Optional(Type.Boolean()),
    ship: Type.Optional(WorkspaceShipStateSchema),
    setup: Type.Optional(
      Type.Object({
        status: literals("running", "failed", "complete", "interrupted"),
        jobId: Type.String(),
        stage: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
      }),
    ),
  },
  {
    description:
      "Canonically registered workspace within a project, with attached session ids and optional setup or ship state.",
  },
);
export const HierarchyProjectSchema = Type.Object(
  {
    id: Type.String(),
    path: Type.String(),
    name: Type.String(),
    kind: literals("git", "directory"),
    defaultBranch: Type.Optional(
      Type.String({
        description:
          "Unqualified Git default branch, when known from local remote metadata.",
      }),
    ),
    addedAt: Type.String(),
    launchConfig: Type.Optional(ProjectLaunchConfigSchema),
    icon: Type.Optional(
      Type.String({
        description:
          "Project icon as a base64 image data URL, including SVG; render as an image rather than inline markup.",
      }),
    ),
    alias: Type.Optional(Type.String()),
    sortOrder: Type.Optional(Type.Number()),
    pinOrder: Type.Optional(Type.Number()),
    workspaces: Type.Array(HierarchyWorkspaceSchema),
  },
  {
    description:
      "Registered host project and its workspaces, including display and ordering metadata.",
  },
);
export const HierarchySnapshotSchema = Type.Object(
  {
    selectedProjectId: Type.Optional(Type.String()),
    projects: Type.Array(HierarchyProjectSchema),
    iconCandidates: Type.Optional(
      Type.Array(Type.Object({ path: Type.String(), icon: Type.String() })),
    ),
    workspaceCandidates: Type.Optional(
      Type.Array(
        Type.Object({
          path: Type.String(),
          name: Type.String(),
          branch: Type.Optional(Type.String()),
          isDefault: Type.Boolean(),
        }),
        {
          description:
            "Discovered worktrees awaiting import, not canonical registrations.",
        },
      ),
    ),
    sessionCandidates: Type.Optional(
      Type.Array(SessionInfoSchema, {
        description:
          "Discovered sessions awaiting import, not canonical registrations.",
      }),
    ),
  },
  {
    description:
      "Registered hierarchy snapshot; optional discovery candidates are not registered until imported.",
  },
);
export const HierarchyRequestSchema = Type.Object(
  {
    action: literals(
      "list",
      "registerProject",
      "unregisterProject",
      "updateProject",
      "setProjectIcon",
      "listProjectIcons",
      "discoverWorkspaces",
      "importWorkspaces",
      "discoverSessions",
      "importSessions",
      "unregisterSession",
      "registerSession",
      "moveSession",
    ),
    projectId: Type.Optional(Type.String()),
    workspaceId: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    paths: Type.Optional(strings()),
    sessionId: Type.Optional(Type.String()),
    sessionIds: Type.Optional(strings()),
    cwd: Type.Optional(Type.String()),
    from: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    icon: Type.Optional(
      nullable(
        Type.String({
          description:
            "Base64 image data URL, including SVG, up to 256 KiB decoded; null clears the project icon.",
        }),
      ),
    ),
    alias: Type.Optional(nullable(Type.String())),
    sortOrder: Type.Optional(nullable(Type.Number())),
    pinOrder: Type.Optional(nullable(Type.Number())),
    launchConfig: Type.Optional(nullable(ProjectLaunchConfigSchema)),
  },
  {
    description:
      "Action-specific hierarchy query or mutation; ids and host paths select registrations, while nullable project metadata clears values.",
  },
);
export const FileIndexEntrySchema = Type.Object(
  {
    path: Type.String(),
    isDir: Type.Boolean(),
  },
  {
    description:
      "A matched indexed workspace path and whether it denotes a directory.",
  },
);
export const BrowsableDirectorySchema = Type.Object(
  {
    name: Type.String(),
    path: Type.String(),
  },
  {
    description:
      "Directory name and host filesystem path suitable for a directory picker.",
  },
);
export const WorktreeInfoSchema = Type.Object(
  {
    path: Type.String(),
    branch: nullable(Type.String()),
    isMain: Type.Boolean(),
  },
  {
    description:
      "Git worktree host path, nullable checked-out branch and main-checkout flag.",
  },
);
export const WorkspaceFileSourceSchema = Type.Object(
  {
    hostId: Type.String(),
    cwd: nullable(Type.String()),
    sessionId: nullable(Type.String()),
  },
  {
    description:
      "Host and optional session context from which a workspace file is addressed.",
  },
);
export const WorkspaceOwnerSchema = Type.Object(
  { sessionId: Type.String(), cwd: Type.String() },
  {
    description:
      "Derived from a live wrapper or durable creation journal, never browser cwd.",
  },
);
export const WorkspaceFileRequestSchema = Type.Object(
  {
    segments: Type.Array(Type.String(), {
      description: "Segments used to resolve the file path on the host.",
    }),
    sessionId: nullable(Type.String()),
    sessionFile: Type.Optional(nullable(Type.String())),
    owner: Type.Optional(
      Type.Object(WorkspaceOwnerSchema.properties, {
        description:
          "Derived session owner for host access checks, not a browser-supplied cwd authority.",
      }),
    ),
  },
  {
    description:
      "Workspace file path segments and nullable session context, with optional derived owner used for access checks.",
  },
);
export const WorkspaceFileInfoSchema = Type.Object(
  {
    path: Type.String(),
    name: Type.String(),
    size: Type.Number({ description: "File size in bytes." }),
    mtimeMs: Type.Number({
      description:
        "Last modification time in milliseconds since the Unix epoch.",
    }),
    isDirectory: Type.Boolean(),
    language: Type.String(),
    mime: Type.String(),
    previewKind: nullable(literals("pdf", "docx")),
  },
  {
    description:
      "Host file metadata snapshot including byte size, modification time, inferred content type and supported preview kind.",
  },
);
export const WorkspaceDirectoryListingSchema = Type.Object(
  {
    path: Type.String(),
    entries: Type.Array(
      Type.Object({
        name: Type.String(),
        isDir: Type.Boolean(),
        size: Type.Number(),
        modified: Type.String(),
        linkTarget: Type.Optional(Type.String()),
        outsideRoot: Type.Optional(Type.Boolean()),
      }),
    ),
  },
  {
    description:
      "Host directory snapshot with entry metadata and optional symlink target and root-boundary indication.",
  },
);
export const WorkspaceReadSchema = Type.Object(
  {
    id: Type.String(),
    info: WorkspaceFileInfoSchema,
  },
  {
    description:
      "Open host file reader handle and metadata for chunked reads; close the handle when finished.",
  },
);
export const WorkspaceIndexSchema = Type.Union(
  [
    Type.Object({ files: strings(), truncated: Type.Boolean() }),
    Type.Object({
      matches: Type.Array(FileIndexEntrySchema),
      truncated: Type.Optional(Type.Boolean()),
    }),
  ],
  {
    description:
      "Indexed paths or search matches, with truncation indicating that the returned list is incomplete.",
  },
);
export const WorkspaceBashOutputSchema = Type.Union(
  [
    Type.Object({
      tooLarge: Type.Literal(true),
      size: Type.Number(),
      maxBytes: Type.Number(),
    }),
    Type.Object({ tooLarge: Type.Literal(false), output: Type.String() }),
  ],
  {
    description:
      "Session bash output text or an oversized result with actual and permitted byte counts.",
  },
);
export const WorkspaceUploadResultSchema = Type.Object(
  {
    path: Type.String(),
    name: Type.String(),
    skipped: Type.Boolean({
      description:
        "True when an existing destination was retained under the skip conflict strategy.",
    }),
  },
  {
    description:
      "Published destination path and name, or a skipped existing target when conflict policy requests it.",
  },
);
export const WorkspaceWorktreesSchema = Type.Object(
  {
    projectRoot: Type.String(),
    projectKey: Type.String(),
    isGit: Type.Boolean(),
    isTopLevel: Type.Boolean(),
    currentWorktreePath: nullable(Type.String()),
    worktrees: Type.Array(WorktreeInfoSchema),
  },
  {
    description:
      "Git worktree discovery for a host path, including project identity, current worktree and main-checkout information.",
  },
);
export const GitOriginSchema = Type.Object(
  {
    path: Type.String(),
    origin: nullable(Type.String()),
    mainCheckout: Type.Boolean(),
  },
  {
    description:
      "Resolved origin for an input host path, nullable if unavailable, and whether it is the main checkout.",
  },
);
export const WorkspaceDirectoryBrowseSchema = Type.Union(
  [
    Type.Object({
      path: Type.String(),
      parentPath: nullable(Type.String()),
      directories: Type.Array(BrowsableDirectorySchema),
    }),
    Type.Object({
      path: Type.Literal(""),
      parentPath: Type.Null(),
      directories: Type.Tuple([]),
      drives: Type.Array(BrowsableDirectorySchema),
    }),
  ],
  {
    description:
      "Host directory picker snapshot or platform drive listing when browsing the drive root.",
  },
);
export const UploadConflictStrategySchema = Type.Union(
  [Type.Literal("error"), Type.Literal("overwrite"), Type.Literal("skip")],
  {
    description:
      "Existing upload target policy: reject, overwrite a replaceable file, or skip it.",
  },
);
export const UploadTargetInspectionSchema = Type.Object(
  {
    conflicts: strings(),
    nonReplaceable: Type.Array(Type.String(), {
      description:
        "Conflicting names that are not regular files, including symbolic links and directories.",
    }),
  },
  {
    description:
      "Existing destination basenames and the subset that cannot be replaced, including directories and symlinks.",
  },
);
export const CloneFrameSchema = Type.Union(
  [
    Type.Object({ type: Type.Literal("output"), text: Type.String() }),
    Type.Object({ type: Type.Literal("done"), path: Type.String() }),
    Type.Object({ type: Type.Literal("cancelled"), path: Type.String() }),
    Type.Object({
      type: Type.Literal("error"),
      error: Type.String(),
      code: Type.String(),
    }),
  ],
  {
    description:
      "Incremental clone output or terminal done, cancelled, or error frame.",
  },
);
export const CloneProgressSchema = Type.Object(
  {
    cursor: Type.Number({
      description:
        "UTF-8 output byte position to supply on the next progress read.",
    }),
    reset: Type.Boolean({
      description:
        "Replace previously retained progress when true; the requested cursor fell outside retained history.",
    }),
    frames: Type.Array(CloneFrameSchema),
    terminal: Type.Boolean(),
  },
  {
    description:
      "Retained clone frames and continuation cursor; reset means earlier requested history is no longer retained.",
  },
);
