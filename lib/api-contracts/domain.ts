import { Type } from "@sinclair/typebox";

export const SessionTitleSourceSchema = Type.Union(
  [Type.Literal("auto"), Type.Literal("user")],
  {
    description:
      "Origin of the current session title: automatically generated or explicitly chosen by a user.",
  },
);

export const SessionEntryBaseSchema = Type.Object(
  {
    type: Type.String(),
    id: Type.String({
      description: "Entry identity within this session's append history.",
    }),
    parentId: Type.Union([Type.String(), Type.Null()], {
      description: "Parent entry ID; null denotes a root in the session tree.",
    }),
    timestamp: Type.String({
      description: "Entry timestamp as an ISO date-time string.",
    }),
    clientMessageId: {
      ...Type.Optional(Type.String()),
      description:
        "Client intent metadata stored on native message/custom-message entries, never sent to the model.",
    },
  },
  {
    description:
      "Shared append-history identity and parent linkage for a session entry.",
  },
);

export const TextContentSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { description: "Plain text block within a message or tool result." },
);

export const ImageContentSchema = {
  ...Type.Object({
    type: Type.Literal("image"),
    data: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    source: Type.Optional(
      Type.Object({
        type: Type.Union([Type.Literal("base64"), Type.Literal("url")]),
        media_type: Type.Optional(Type.String()),
        data: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
      }),
    ),
  }),
  description:
    "Image block. omp persists the flat {data, mimeType} shape (data may be a\n`blob:sha256:` reference until resolved); legacy pi entries used the nested\nAnthropic-style `source` shape. The UI handles both. Tool-result images\nreach the browser as `url` (`/api/media/<sha256>`, `?thumb=1` for a small\npreview) instead of inline base64.",
};

export const ThinkingContentSchema = Type.Object(
  {
    type: Type.Literal("thinking"),
    thinking: Type.String(),
    deferred: {
      ...Type.Optional(Type.Boolean()),
      description:
        "Historical content omitted from the initial response and loaded on demand.",
    },
  },
  {
    description:
      "Assistant reasoning block; historical text may be deferred until requested.",
  },
);

export const ToolCallContentSchema = Type.Object(
  {
    type: Type.Literal("toolCall"),
    toolCallId: Type.String(),
    toolName: Type.String(),
    intent: Type.Optional(
      Type.String({
        description: "Native tool-call intent, when supplied by the runner.",
      }),
    ),
    input: Type.Record(
      Type.String(),
      Type.Unknown({
        description:
          "Extensible JSON data supplied by the provider, tool, or extension.",
      }),
    ),
  },
  {
    description:
      "Assistant request to invoke a named tool; toolCallId correlates its result.",
  },
);

export const BashExecutionMessageSchema = Type.Object(
  {
    role: Type.Literal("bashExecution"),
    command: Type.String(),
    output: Type.String(),
    exitCode: Type.Optional(Type.Number()),
    cancelled: Type.Optional(Type.Boolean()),
    truncated: Type.Optional(Type.Boolean()),
    fullOutputPath: Type.Optional(
      Type.String({
        description:
          "Local path to full command output when retained separately.",
      }),
    ),
    excludeFromContext: Type.Optional(Type.Boolean()),
    timestamp: Type.Optional(
      Type.Number({ description: "Message time in Unix epoch milliseconds." }),
    ),
  },
  {
    description:
      "User-initiated shell execution and its captured output, optionally excluded from model context.",
  },
);

export const PythonExecutionMessageSchema = {
  ...Type.Object({
    role: Type.Literal("pythonExecution"),
    code: Type.String(),
    output: Type.String(),
    exitCode: Type.Optional(Type.Number()),
    cancelled: Type.Optional(Type.Boolean()),
    truncated: Type.Optional(Type.Boolean()),
    excludeFromContext: Type.Optional(Type.Boolean()),
    timestamp: Type.Optional(
      Type.Number({ description: "Message time in Unix epoch milliseconds." }),
    ),
  }),
  description: "User-initiated Python execution via the $ command (omp-only).",
};

export const UiDialogOptionsSchema = {
  ...Type.Object({
    timeout: Type.Optional(
      Type.Number({ description: "Dialog timeout in milliseconds." }),
    ),
    secret: {
      ...Type.Optional(Type.Boolean()),
      description: "`input`: mask the entered text.",
    },
    selectionMarker: {
      ...Type.Optional(
        Type.Union([Type.Literal("radio"), Type.Literal("checkbox")]),
      ),
      description:
        "omp's checkbox list (ask multi-select): `checkedIndices` is the authoritative checked state.",
    },
    checkedIndices: Type.Optional(Type.Array(Type.Number())),
    markableCount: {
      ...Type.Optional(Type.Number()),
      description:
        "Leading options that get a marker; the rest are actions such as Other and Done.",
    },
  }),
  description:
    "omp's `ExtensionUIDialogOptions` as the runner sends them (no signal or callbacks).",
};

export const UiSelectItemSchema = Type.Union(
  [
    Type.String(),
    Type.Object({
      label: Type.String(),
      description: Type.Optional(Type.String()),
    }),
  ],
  {
    description:
      "Select option supplied either as a label string or a label with descriptive text.",
  },
);

export const UiApprovalPromptSchema = {
  ...Type.Object({
    full: Type.String(),
    compact: Type.String(),
    session: Type.Optional(Type.String()),
    grants: Type.Optional(
      Type.Array(
        Type.Object({
          scope: Type.Union([Type.Literal("folder"), Type.Literal("target")]),
          label: Type.String(),
          alwaysLabel: Type.String(),
        }),
      ),
    ),
  }),
  description: "omp's `ExtensionApprovalPrompt`: a title line then details.",
};

export const UiApprovalAnswerSchema = Type.Union(
  [
    Type.Literal("once"),
    Type.Literal("session"),
    Type.Literal("deny"),
    Type.Object({
      grant: Type.Union([Type.Literal("folder"), Type.Literal("target")]),
      always: Type.Boolean(),
    }),
  ],
  {
    description:
      "Approval decision: once, session, deny, or a folder/target grant with persistence choice.",
  },
);

export const UiAskDialogResultSchema = {
  ...Type.Object({
    kind: Type.Literal("submit"),
    results: Type.Array(
      Type.Object({
        id: Type.String(),
        question: Type.String(),
        options: Type.Array(Type.String()),
        multi: Type.Boolean(),
        selectedOptions: Type.Array(Type.String()),
        customInput: Type.Optional(Type.String()),
      }),
    ),
  }),
  description:
    "Submitted ask dialog results, preserving question IDs, selections and optional custom input.",
};

export const UiPresentationFrameSchema = {
  ...Type.Intersect([
    Type.Object({
      type: Type.Literal("ui"),
    }),
    Type.Union([
      Type.Object({
        method: Type.Literal("notify"),
        message: Type.String(),
        notifyType: Type.Optional(
          Type.Union([
            Type.Literal("info"),
            Type.Literal("warning"),
            Type.Literal("error"),
          ]),
        ),
      }),
      Type.Object({
        method: Type.Literal("setStatus"),
        statusKey: Type.String(),
        statusText: Type.Optional(Type.String()),
      }),
      Type.Object({
        method: Type.Literal("setWidget"),
        widgetKey: Type.String(),
        widgetLines: Type.Optional(Type.Array(Type.String())),
        widgetPlacement: Type.Optional(
          Type.Union([
            Type.Literal("aboveEditor"),
            Type.Literal("belowEditor"),
          ]),
        ),
      }),
      Type.Object({
        method: Type.Literal("setTitle"),
        title: Type.String(),
      }),
      Type.Object({
        method: Type.Literal("set_editor_text"),
        text: Type.String(),
      }),
      Type.Object({
        method: Type.Literal("setWorkingMessage"),
        message: Type.Optional(Type.String()),
      }),
      Type.Object({
        method: Type.Literal("custom"),
        id: Type.Number(),
        lines: Type.Array(Type.String()),
        closed: Type.Optional(Type.Boolean()),
      }),
    ]),
  ]),
  description:
    "Runner presentation update for notifications, status, widgets, title, editor text or custom UI; not a dialog answer.",
};

export const UiCustomFrameSchema = Type.Intersect(
  [
    Type.Object({ type: Type.Literal("ui") }),
    Type.Object({
      method: Type.Literal("custom"),
      id: Type.Number(),
      lines: Type.Array(Type.String()),
      closed: Type.Optional(Type.Boolean()),
    }),
  ],
  {
    description:
      "Runner custom UI presentation update identified by numeric dialog ID; closed marks its end.",
  },
);

export const ExtensionStatusItemSchema = Type.Object(
  {
    key: Type.String(),
    text: Type.String(),
  },
  {
    description:
      "Current extension status text indexed by its extension-provided key.",
  },
);

export const ExtensionWidgetItemSchema = Type.Object(
  {
    key: Type.String(),
    lines: Type.Array(Type.String()),
    placement: Type.Union([
      Type.Literal("aboveEditor"),
      Type.Literal("belowEditor"),
    ]),
  },
  {
    description:
      "Current keyed extension widget lines and their placement relative to the editor.",
  },
);

export const BranchPreviewSchema = Type.Object(
  {
    role: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    ),
    text: Type.String(),
  },
  {
    description:
      "Text and optional conversational role used to preview a session branch.",
  },
);

export const SessionInfoSchema = Type.Object(
  {
    path: Type.String({
      description: "Session file path local to its owning host.",
    }),
    id: Type.String({
      description:
        "Session identifier; hostId identifies the owner in cross-host lists.",
    }),
    cwd: Type.String({ description: "Working directory on the owning host." }),
    name: Type.Optional(Type.String()),
    created: Type.String({
      description: "Session creation time as an ISO date-time string.",
    }),
    modified: Type.String({
      description: "Session file modification time as an ISO date-time string.",
    }),
    lastMessageAt: {
      ...Type.Optional(Type.String()),
      description:
        "ISO time of the last message entry (absent when the tail scan found none).",
    },
    messageCount: Type.Number(),
    firstMessage: Type.String(),
    parentSessionId: Type.Optional(Type.String()),
    projectRoot: {
      ...Type.Optional(Type.String()),
      description:
        "Main repo root shared by all worktrees of this cwd (cwd itself for non-git dirs).\nAlways set by the server; optional because the client builds transient\nSessionInfo objects before the first refresh. Fall back to cwd.",
    },
    projectKey: {
      ...Type.Optional(Type.String()),
      description: "Stable identity key for grouping and comparison.",
    },
    worktreeBranch: {
      ...Type.Optional(Type.String()),
      description:
        "Branch name when cwd is a linked git worktree (not the main checkout)",
    },
    hostId: {
      ...Type.Optional(Type.String()),
      description:
        "Host the session's file lives on (\"local\" for this machine). Set by the\nall-hosts session list; a host's own list leaves it out.",
    },
  },
  {
    description:
      "Session listing snapshot combining file metadata, project grouping and optional cross-host ownership.",
  },
);

export const ArchivedSessionInfoSchema = {
  ...Type.Object({
    key: Type.String(),
    id: Type.String(),
    cwd: Type.String(),
    name: Type.Optional(Type.String()),
    created: Type.String(),
    archivedAt: Type.String(),
    messageCount: Type.Number(),
    firstMessage: Type.String(),
    size: Type.Number(),
    status: Type.Optional(
      Type.Union([
        Type.Literal("complete"),
        Type.Literal("interrupted"),
        Type.Literal("aborted"),
        Type.Literal("error"),
        Type.Literal("pending"),
        Type.Literal("unknown"),
      ]),
    ),
    restorePending: {
      ...Type.Optional(Type.Literal(true)),
      description:
        "In-progress/interrupted restore evidence; its unique capture key is not an actionable restore target.",
    },
    hostId: {
      ...Type.Optional(Type.String()),
      description:
        'Host whose archive holds it ("local" for this machine). Set by the all-hosts list; a host\'s own list leaves it out.',
    },
  }),
  description:
    "Metadata for a gzip-compressed session in the owning host's archive tree; restorePending identifies incomplete restore evidence rather than an actionable archive.",
};

export const ProjectLaunchConfigSchema = {
  ...Type.Object({
    profile: {
      ...Type.Optional(Type.String()),
      description: "The OMP profile to use.",
    },
    advisor: {
      ...Type.Optional(Type.Boolean()),
      description: "Whether to launch with advisor mode.",
    },
    extraArgs: {
      ...Type.Optional(Type.Array(Type.String())),
      description: "Extra OMP CLI args, stored as an array.",
    },
  }),
  description:
    "Workspace-level omp launch configuration; only affects omp children spawned for that workspace.",
};

export const CrossSessionHostToolCallSchema = {
  ...Type.Object({
    sessionId: Type.String(),
    hostId: Type.String(),
    cwd: Type.String(),
    id: Type.String(),
    toolName: Type.String(),
    arguments: Type.Record(
      Type.String(),
      Type.Unknown({
        description:
          "Extensible JSON data supplied by the provider, tool, or extension.",
      }),
    ),
  }),
  description:
    "A host tool call for a session no tab is watching, sent to every open tab.",
};

export const ExitedRpcSessionSchema = Type.Object(
  {
    id: Type.String(),
    cwd: Type.String(),
    hostId: {
      ...Type.Optional(Type.String()),
      description: "Absent on this machine, as on `SessionInfo`.",
    },
    at: Type.Number({ description: "Exit time in Unix epoch milliseconds." }),
    code: Type.Union([Type.Number(), Type.Null()]),
    signal: Type.Union([Type.String(), Type.Null()]),
    detail: { ...Type.String(), description: "Last stderr line, if any." },
  },
  {
    description:
      "Unexpected child-process exit retained until that session starts again; code or signal can be null.",
  },
);

export const OutboxModeSchema = {
  ...Type.Union([
    Type.Literal("prompt"),
    Type.Literal("followUp"),
    Type.Literal("steer"),
  ]),
  description:
    "Delivery mode captured with the intent: prompt, follow-up or steering input to the native runner.",
};

export const ContextUsageSchema = Type.Object(
  {
    percent: Type.Union([Type.Number(), Type.Null()], {
      description: "Estimated occupied percentage, or null when unknown.",
    }),
    contextWindow: Type.Number({
      description: "Model context window capacity in tokens.",
    }),
    tokens: Type.Union([Type.Number(), Type.Null()], {
      description: "Estimated context tokens, or null when unknown.",
    }),
  },
  {
    description:
      "Context occupancy estimate, not a billable provider usage total.",
  },
);

export const UsageLimitStateSchema = Type.Union(
  [
    Type.Object({
      stage: Type.Literal("low_priority"),
      resetsAtSec: Type.Number(),
      allowanceLeftPercent: Type.Optional(Type.Number()),
    }),
    Type.Object({
      stage: Type.Literal("wrap_up"),
      resetsAtSec: Type.Optional(Type.Number()),
      extraUsage: Type.Boolean(),
    }),
  ],
  {
    description:
      "Provider limit state: low-priority allowance or wrap-up, with reset time in Unix seconds when supplied.",
  },
);

export const SlowModeScopeSchema = Type.Union(
  [Type.Literal("session"), Type.Literal("global")],
  {
    description:
      "Whether slow mode applies to this session or the shared global configuration.",
  },
);

export const ModelLikeSchema = Type.Object(
  {
    id: Type.String(),
    provider: Type.String(),
  },
  {
    description:
      "Provider-qualified model identity; model IDs alone are not necessarily unique across providers.",
  },
);

export const ToolInfoSchema = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
  },
  {
    description:
      "Name and description of a tool available to the current agent.",
  },
);

export const OmpModelSchema = {
  ...Type.Object(
    {
      id: Type.String(),
      provider: Type.String(),
      name: Type.Optional(Type.String()),
      api: Type.Optional(Type.String()),
      reasoning: Type.Optional(Type.Boolean()),
      contextWindow: Type.Optional(Type.Number()),
      maxTokens: Type.Optional(Type.Number()),
      input: Type.Optional(Type.Array(Type.String())),
      thinking: Type.Optional(
        Type.Object({
          mode: Type.Optional(Type.String()),
          efforts: Type.Optional(Type.Array(Type.String())),
          requiresEffort: Type.Optional(Type.Boolean()),
          defaultLevel: Type.Optional(Type.String()),
        }),
      ),
    },
    {
      additionalProperties: Type.Unknown({
        description:
          "Extensible JSON data supplied by the provider, tool, or extension.",
      }),
    },
  ),
  description:
    "Subset of omp's Model (pi-ai) that the web UI reads; extra fields pass through.",
};

export const TodoItemSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    content: Type.String(),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("blocked"),
      Type.Literal("abandoned"),
    ]),
    blocker: Type.Optional(Type.String()),
  },
  {
    description:
      "Task in a session todo phase, with lifecycle status and optional blocker.",
  },
);

export const QueuedMessagesSchema = Type.Object(
  {
    steering: Type.Array(Type.String()),
    followUp: Type.Array(Type.String()),
    clientMessageIds: {
      ...Type.Optional(
        Type.Object({
          steering: Type.Array(Type.Union([Type.String(), Type.Null()])),
          followUp: Type.Array(Type.Union([Type.String(), Type.Null()])),
        }),
      ),
      description:
        "Native intent IDs aligned with the visible queue slots; null denotes an older uncorrelated message.",
    },
  },
  {
    description:
      "Native runner queue snapshot, distinct from messages still held by the web outbox.",
  },
);

export const AvailableSlashCommandSourceSchema = Type.Union(
  [
    Type.Literal("builtin"),
    Type.Literal("skill"),
    Type.Literal("extension"),
    Type.Literal("custom"),
    Type.Literal("mcp_prompt"),
    Type.Literal("file"),
  ],
  {
    description:
      "Origin of an available slash command, including built-ins, extensions and discovered files.",
  },
);

export const BashResultInfoSchema = {
  ...Type.Object({
    output: Type.String(),
    exitCode: Type.Union([Type.Number(), Type.Undefined()]),
    cancelled: Type.Boolean(),
    timedOut: Type.Optional(Type.Boolean()),
    truncated: Type.Boolean(),
    totalLines: Type.Optional(Type.Number()),
    totalBytes: Type.Optional(Type.Number()),
    outputLines: Type.Optional(Type.Number()),
    outputBytes: Type.Optional(Type.Number()),
    artifactId: Type.Optional(Type.String()),
    workingDir: Type.Optional(Type.String()),
    deferred: {
      ...Type.Optional(Type.Boolean()),
      description:
        "keylime: omp held the result back for the next prompt (a turn was running).",
    },
  }),
  description:
    "Native shell command result, including truncation and optional artifact location; deferred means the output is held for a later prompt.",
};

export const GenerationSpeedInfoSchema = Type.Object(
  {
    current: Type.Union([Type.Number(), Type.Null()]),
    average: Type.Union([Type.Number(), Type.Null()]),
  },
  {
    description:
      "Current and average generation throughput; null indicates no available measurement.",
  },
);

export const RpcAskDialogQuestionSchema = {
  ...Type.Object({
    id: Type.String(),
    question: Type.String(),
    header: Type.Optional(Type.String()),
    options: Type.Array(
      Type.Object({
        label: Type.String(),
        description: Type.Optional(Type.String()),
        preview: Type.Optional(Type.String()),
      }),
    ),
    multi: Type.Optional(Type.Boolean()),
    recommended: {
      ...Type.Optional(Type.Number()),
      description: "Index into `options`.",
    },
  }),
  description:
    "One question in a native ask dialog; recommended is an index into options and multi permits multiple selections.",
};

export const RpcAskDialogAnswerSchema = {
  ...Type.Object({
    id: Type.String(),
    selectedOptions: Type.Array(Type.String()),
    customInput: Type.Optional(Type.String()),
  }),
  description: "Per-question answer, sent back in question order.",
};

export const HtmlFormDataSchema = {
  ...Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Number(), Type.Array(Type.String())]),
  ),
  description:
    "A submitted whole-form ask (omp's `formDialog`), by control `name`: radios, single checkboxes and\nsingle selects give their value (omitted when nothing is chosen), checkbox groups and multi-selects\nan array, `number`/`range` inputs a number, other text fields their text. Mirrors pi-tui's html-form.",
};

export const HostToolParameterSchema = {
  ...Type.Object(
    {
      type: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    },
    {
      additionalProperties: Type.Unknown({
        description:
          "Extensible JSON data supplied by the provider, tool, or extension.",
      }),
    },
  ),
  description:
    "omp's RPC host-tool bridge: keylime registers host tools (set_host_tools)\nthat the agent can call; the server emits host_tool_call frames the UI\nexecutes, and the UI answers with host_tool_result. Mirrors\noh-my-pi modes/rpc/rpc-types.ts.",
};

export const HostToolDefinitionSchema = Type.Object(
  {
    name: Type.String(),
    label: Type.Optional(Type.String()),
    description: Type.String(),
    parameters: Type.Record(
      Type.String(),
      Type.Unknown({
        description:
          "Extensible JSON data supplied by the provider, tool, or extension.",
      }),
    ),
    hidden: Type.Optional(Type.Boolean()),
    loadMode: Type.Optional(
      Type.Union([Type.Literal("essential"), Type.Literal("discoverable")]),
    ),
  },
  {
    description:
      "Host tool registration supplied to the native runner, including parameter schema and discovery mode.",
  },
);

export const HostToolCallFrameSchema = Type.Object(
  {
    type: Type.Literal("host_tool_call"),
    id: Type.String(),
    toolCallId: Type.String(),
    toolName: Type.String(),
    arguments: Type.Record(
      Type.String(),
      Type.Unknown({
        description:
          "Extensible JSON data supplied by the provider, tool, or extension.",
      }),
    ),
  },
  {
    description:
      "Native request for the host to execute a registered tool; id correlates the response.",
  },
);

export const HostToolCancelFrameSchema = Type.Object(
  {
    type: Type.Literal("host_tool_cancel"),
    id: Type.String(),
    targetId: Type.String(),
  },
  {
    description:
      "Native cancellation frame targeting an outstanding host tool request.",
  },
);

export const HostToolResultFrameSchema = Type.Object(
  {
    type: Type.Literal("host_tool_result"),
    id: Type.String(),
    result: Type.Unknown({
      description:
        "Extensible JSON data supplied by the provider, tool, or extension.",
    }),
    isError: Type.Optional(Type.Boolean()),
  },
  {
    description:
      "Host tool completion correlated to the request id; isError distinguishes a failed result.",
  },
);

export const HostUriSchemeDefinitionSchema = {
  ...Type.Object({
    scheme: Type.String(),
    description: Type.Optional(Type.String()),
    writable: Type.Optional(Type.Boolean()),
    immutable: Type.Optional(Type.Boolean()),
  }),
  description:
    "omp's RPC host-URI bridge: the host registers URL schemes\n(set_host_uri_schemes) that the agent's read/write tools resolve through\nthe UI; the server emits host_uri_request frames the UI satisfies with\nhost_uri_result. Mirrors oh-my-pi modes/rpc/rpc-types.ts.",
};

export const HostUriOperationSchema = Type.Union(
  [Type.Literal("read"), Type.Literal("write")],
  { description: "Operation requested against a registered host URI scheme." },
);

export const HostUriCancelFrameSchema = Type.Object(
  {
    type: Type.Literal("host_uri_cancel"),
    id: Type.String(),
    targetId: Type.String(),
  },
  {
    description:
      "Cancellation of an outstanding host URI request identified by targetId.",
  },
);

export const HostUriResultFrameSchema = Type.Object(
  {
    type: Type.Literal("host_uri_result"),
    id: Type.String(),
    content: Type.Optional(Type.String()),
    contentType: Type.Optional(
      Type.Union([
        Type.Literal("text/markdown"),
        Type.Literal("application/json"),
        Type.Literal("text/plain"),
      ]),
    ),
    isError: Type.Optional(Type.Boolean()),
    error: Type.Optional(Type.String()),
  },
  {
    description:
      "Host URI response correlated by id, carrying content or error details.",
  },
);

export const ModelActivitySchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("idle"),
      Type.Literal("waiting"),
      Type.Literal("streaming"),
      Type.Literal("tools"),
    ]),
    startedAt: Type.Number(),
    rate: Type.Number(),
    version: Type.Number(),
    epoch: Type.Number(),
  },
  {
    description:
      "Transient runner model-activity snapshot; version and epoch support ordering activity updates.",
  },
);

export const SessionHeaderSchema = Type.Object(
  {
    type: Type.Literal("session"),
    version: Type.Optional(Type.Number()),
    id: Type.String(),
    title: {
      ...Type.Optional(Type.String()),
      description:
        "Current title, folded in from the fixed-width title slot (line 1) on load.",
    },
    titleSource: Type.Optional(SessionTitleSourceSchema),
    timestamp: Type.String({
      description: "Session creation timestamp as an ISO date-time string.",
    }),
    cwd: Type.String({
      description: "Session working directory local to its owning host.",
    }),
    additionalDirectories: {
      ...Type.Optional(Type.Array(Type.String())),
      description: "Extra workspace roots beyond cwd (multi-root workspace).",
    },
    parentSession: Type.Optional(Type.String()),
    providerPromptCacheKey: Type.Optional(Type.String()),
  },
  {
    description:
      "On-disk session header, with current title folded in from the title slot when loaded.",
  },
);

export const AssistantContentBlockSchema = Type.Union(
  [
    TextContentSchema,
    ImageContentSchema,
    ThinkingContentSchema,
    ToolCallContentSchema,
  ],
  {
    description:
      "Assistant content block: text, image, reasoning or a tool invocation.",
  },
);

export const UserMessageSchema = Type.Object(
  {
    role: Type.Literal("user"),
    content: Type.Union([
      Type.String(),
      Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
    ]),
    timestamp: Type.Optional(Type.Number()),
    clientMessageId: Type.Optional(Type.String()),
    branchSummary: {
      ...Type.Optional(Type.Literal(true)),
      description:
        "Rendered from a `branch_summary` entry, not a real prompt: omp cannot branch at it.",
    },
  },
  {
    description:
      "User input or a display-only branch-summary rendering, correlated to a client intent when available.",
  },
);

export const ToolResultMessageSchema = Type.Object(
  {
    role: Type.Literal("toolResult"),
    toolCallId: Type.String(),
    toolName: Type.Optional(Type.String()),
    content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
    isError: Type.Optional(Type.Boolean()),
    details: Type.Optional(
      Type.Unknown({
        description:
          "Extensible JSON data supplied by the provider, tool, or extension.",
      }),
    ),
    timestamp: Type.Optional(Type.Number()),
    partial: {
      ...Type.Optional(Type.Boolean()),
      description:
        "Live snapshot of a tool that is still executing (omp's\n`tool_execution_update`), not a committed result. Rendering treats it as\n\"running\" and keeps it out of the session's toolResult list.",
    },
    passiveContext: {
      ...Type.Optional(Type.String()),
      description:
        "Sanitized one-line passive context omp emitted after this result's tool\nbatch (`collectToolResults`); display-only, never part of the result.",
    },
  },
  {
    description:
      "Tool output correlated to an assistant tool call; partial output is a live snapshot, not a committed result.",
  },
);

export const CustomMessageSchema = Type.Object(
  {
    role: Type.Literal("custom"),
    customType: Type.String(),
    content: Type.Union([
      Type.String(),
      Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
    ]),
    display: Type.Boolean(),
    details: Type.Optional(
      Type.Unknown({
        description:
          "Extensible JSON data supplied by the provider, tool, or extension.",
      }),
    ),
    timestamp: Type.Optional(Type.Number()),
    clientMessageId: Type.Optional(Type.String()),
  },
  {
    description:
      "Extension-defined message with explicit display flag and optional client intent metadata.",
  },
);

export const DeveloperMessageSchema = {
  ...Type.Object({
    role: Type.Literal("developer"),
    content: Type.Union([
      Type.String(),
      Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
    ]),
    timestamp: Type.Optional(Type.Number()),
  }),
  description:
    "System-slot instruction message (steering envelopes, file-mention text).",
};

export const FileMentionMessageSchema = {
  ...Type.Object({
    role: Type.Literal("fileMention"),
    files: Type.Array(
      Type.Object({
        path: Type.String(),
        content: Type.String(),
        lineCount: Type.Optional(Type.Number()),
        byteSize: Type.Optional(Type.Number()),
        skippedReason: Type.Optional(
          Type.Union([Type.Literal("tooLarge"), Type.Literal("binary")]),
        ),
        image: Type.Optional(ImageContentSchema),
      }),
    ),
    timestamp: Type.Optional(Type.Number()),
  }),
  description:
    "Auto-read file mentions grouped into one message; paths are local and skippedReason records unreadable payloads.",
};

export const UiDialogOptionsArgSchema = Type.Union(
  [UiDialogOptionsSchema, Type.Null()],
  {
    description:
      "Dialog options positional argument; JSON represents an omitted middle argument as null.",
  },
);

export const UiFormDialogResultSchema = {
  ...Type.Object({
    data: HtmlFormDataSchema,
  }),
  description:
    "Submitted whole-form dialog result keyed by control name; controls with no chosen value can be omitted.",
};

export const ThinkingLevelChangeEntrySchema = Type.Composite(
  [
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("thinking_level_change"),
      thinkingLevel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      configured: {
        ...Type.Optional(Type.Union([Type.String(), Type.Null()])),
        description:
          'Configured selector ("auto" or a concrete level); absent on old entries.',
      },
    }),
  ],
  {
    description:
      "Append-history record of a thinking-level selection, including legacy nullable selectors.",
  },
);

export const ModelChangeEntrySchema = Type.Composite(
  [
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("model_change"),
      model: {
        ...Type.Optional(Type.String()),
        description: 'omp format: "provider/modelId".',
      },
      role: {
        ...Type.Optional(Type.String()),
        description:
          'Model role ("default", "smol", ...); undefined means "default".',
      },
      provider: {
        ...Type.Optional(Type.String()),
        description: "Legacy pi format kept for pre-migration files.",
      },
      modelId: Type.Optional(Type.String()),
    }),
  ],
  {
    description:
      "Append-history model selection, accepting current provider/model encoding and legacy provider plus modelId fields.",
  },
);

export const ServiceTierChangeEntrySchema = Type.Composite(
  [
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("service_tier_change"),
      serviceTier: Type.Unknown({
        description:
          "Extensible JSON data supplied by the provider, tool, or extension.",
      }),
    }),
  ],
  {
    description:
      "Append-history record of a service-tier selection; tier data is provider-defined.",
  },
);

export const CompactionEntrySchema = Type.Composite(
  [
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("compaction"),
      summary: Type.String(),
      shortSummary: Type.Optional(Type.String()),
      firstKeptEntryId: Type.String(),
      tokensBefore: Type.Number(),
      method: {
        ...Type.Optional(Type.String()),
        description:
          'omp ≥17.4: maintenance method that fired (e.g. "remote-compacted", "handoff").',
      },
      tokensAfter: Type.Optional(Type.Number()),
      details: Type.Optional(
        Type.Unknown({
          description:
            "Extensible JSON data supplied by the provider, tool, or extension.",
        }),
      ),
      preserveData: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Unknown({
            description:
              "Extensible JSON data supplied by the provider, tool, or extension.",
          }),
        ),
      ),
      fromExtension: Type.Optional(Type.Boolean()),
      fromHook: Type.Optional(Type.Boolean()),
      warning: Type.Optional(Type.String()),
    }),
  ],
  {
    description:
      "Compaction summary replacing earlier context, with the first retained entry and before/after token counts.",
  },
);

export const BranchSummaryEntrySchema = Type.Composite(
  [
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("branch_summary"),
      fromId: Type.String(),
      summary: Type.String(),
      details: Type.Optional(
        Type.Unknown({
          description:
            "Extensible JSON data supplied by the provider, tool, or extension.",
        }),
      ),
      fromExtension: Type.Optional(Type.Boolean()),
      fromHook: Type.Optional(Type.Boolean()),
    }),
  ],
  {
    description:
      "Summary of a branch transition, referencing the source entry by ID.",
  },
);

export const CustomEntrySchema = Type.Composite(
  [
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("custom"),
      customType: Type.String(),
      data: Type.Optional(
        Type.Unknown({
          description:
            "Extensible JSON data supplied by the provider, tool, or extension.",
        }),
      ),
    }),
  ],
  {
    description:
      "Extension-defined append-history entry; data is not necessarily a conversation message.",
  },
);

export const CustomMessageEntrySchema = Type.Composite(
  [
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("custom_message"),
      customType: Type.String(),
      content: Type.Union([
        Type.String(),
        Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
      ]),
      details: Type.Optional(
        Type.Unknown({
          description:
            "Extensible JSON data supplied by the provider, tool, or extension.",
        }),
      ),
      display: Type.Boolean(),
    }),
  ],
  {
    description:
      "Persisted extension-defined message entry with display control and optional details.",
  },
);

export const LabelEntrySchema = Type.Composite(
  [
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("label"),
      targetId: Type.String(),
      label: Type.Union([Type.String(), Type.Undefined()]),
    }),
  ],
  {
    description:
      "Label mutation for a target entry; later label entries override earlier ones and an empty label clears it.",
  },
);

export const SessionInfoEntrySchema = {
  ...Type.Composite([
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("session_info"),
      name: Type.Optional(Type.String()),
    }),
  ]),
  description:
    "Legacy pi rename entry; omp replaced it with the title slot + title_change.",
};

export const TitleChangeEntrySchema = {
  ...Type.Composite([
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("title_change"),
      title: Type.String(),
      previousTitle: Type.Optional(Type.String()),
      source: SessionTitleSourceSchema,
      trigger: Type.Optional(Type.String()),
    }),
  ]),
  description:
    "Append-only audit entry recording a session title change (omp).",
};

export const TtsrInjectionEntrySchema = {
  ...Type.Composite([
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("ttsr_injection"),
      injectedRules: Type.Array(Type.String()),
    }),
  ]),
  description:
    "Tracks which time-traveling rules have been injected this session (omp).",
};

export const SessionInitEntrySchema = {
  ...Type.Composite([
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("session_init"),
      systemPrompt: Type.String(),
      task: Type.String(),
      tools: Type.Array(Type.String()),
      outputSchema: Type.Optional(
        Type.Unknown({
          description:
            "Extensible JSON data supplied by the provider, tool, or extension.",
        }),
      ),
      outputSchemaMode: Type.Optional(Type.String()),
      restrictToolNames: Type.Optional(Type.Boolean()),
      spawns: Type.Optional(Type.String()),
      readSummarize: Type.Optional(Type.Boolean()),
    }),
  ]),
  description: "Initial context capture for subagent sessions (omp).",
};

export const ModeChangeEntrySchema = {
  ...Type.Composite([
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("mode_change"),
      mode: {
        ...Type.String(),
        description: 'Current mode name, or "none" when exiting a mode.',
      },
      data: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Unknown({
            description:
              "Extensible JSON data supplied by the provider, tool, or extension.",
          }),
        ),
      ),
    }),
  ]),
  description: "Agent mode transitions, e.g. plan mode (omp).",
};

export const ManagedProjectSchema = {
  ...Type.Object({
    path: Type.String(),
    addedAt: {
      ...Type.Optional(Type.String()),
      description: "ISO timestamp of the last explicit add.",
    },
    alias: {
      ...Type.Optional(Type.String()),
      description:
        "User-defined display name; never changes the directory path.",
    },
    sortOrder: {
      ...Type.Optional(Type.Number()),
      description: "Explicit sidebar position for registered projects.",
    },
    pinOrder: {
      ...Type.Optional(Type.Number()),
      description:
        "Set when pinned: position among pinned workspaces (lower first). Pins\nonly apply while the sidebar sorts by name or activity.",
    },
    launchConfig: {
      ...Type.Optional(ProjectLaunchConfigSchema),
      description: "Workspace-level omp launch configuration.",
    },
    hostId: {
      ...Type.Optional(Type.String()),
      description:
        'Host the project lives on ("local" for this machine). Set by GET /api/projects.',
    },
    projectId: Type.Optional(Type.String()),
    workspaceId: Type.Optional(Type.String()),
    projectPath: Type.Optional(Type.String()),
    projectName: Type.Optional(Type.String()),
    projectKind: Type.Optional(
      Type.Union([Type.Literal("git"), Type.Literal("directory")]),
    ),
    isDefaultWorkspace: Type.Optional(Type.Boolean()),
    projectKey: Type.Optional(Type.String()),
    origin: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    defaultRef: Type.Optional(Type.String()),
  }),
  description:
    "A project in the sidebar: an explicitly added directory (registered in the\non-disk registry) or one discovered from existing sessions. Paths are the\ncanonical projectRoot — worktrees resolve to their main repository.",
};

export const CrossSessionHostToolEventSchema = Type.Union(
  [
    Type.Intersect([
      CrossSessionHostToolCallSchema,
      Type.Object({
        type: Type.Optional(Type.Literal("host_tool_call")),
      }),
    ]),
    Type.Object({
      type: Type.Literal("host_tool_cancel"),
      sessionId: Type.String(),
      hostId: Type.String(),
      targetId: Type.String(),
    }),
  ],
  {
    description:
      "Cross-session host tool invocation or cancellation broadcast to tabs when the session is not watched.",
  },
);

export const OutboxEntrySchema = {
  ...Type.Object({
    id: Type.String({
      description:
        "Client intent ID used to correlate this submission through handoff.",
    }),
    sessionId: Type.String({
      description: "Target session owning the delivery queue.",
    }),
    mode: OutboxModeSchema,
    advisor: {
      ...Type.Optional(Type.Boolean()),
      description:
        "Captured at the original send; an explicit retry must not use current preferences.",
    },
    message: Type.String(),
    images: Type.Optional(
      Type.Array(
        Type.Object({
          type: Type.Literal("image"),
          data: Type.String(),
          mimeType: Type.String(),
        }),
      ),
    ),
    uploads: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Upload identifiers associated with this intent, not filesystem paths.",
      }),
    ),
    state: Type.Union([
      Type.Literal("held"),
      Type.Literal("waiting_host"),
      Type.Literal("delivering"),
      Type.Literal("failed"),
      Type.Literal("delivered"),
    ]),
    error: Type.Optional(Type.String()),
    mayHaveBeenSent: {
      ...Type.Optional(Type.Boolean()),
      description: "A lost reply: omp may have it; never resent by itself.",
    },
    previousEntryIds: {
      ...Type.Optional(Type.Array(Type.String())),
      description:
        "Only while delivering: authoritative persisted history captured before dispatch, never retained in tombstones.",
    },
    settlement: {
      ...Type.Optional(
        Type.Union([
          Type.Literal("native"),
          Type.Literal("none"),
          Type.Literal("uncorrelated"),
        ]),
      ),
      description:
        "Delivered native input still needs its correlated view; none is an explicit non-message completion.",
    },
    createdAt: Type.Number({
      description:
        "Time the web outbox accepted the intent, in Unix epoch milliseconds.",
    }),
  }),
  description:
    "A server-owned message intent retained until native admission or explicit resolution. Web acceptance does not itself mean omp admitted the input; uncertain handoffs are not automatically resent.",
};

export const TodoPhaseSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    name: Type.String(),
    tasks: Type.Array(TodoItemSchema),
  },
  { description: "Named phase grouping ordered session todo tasks." },
);

export const RpcAvailableSlashCommandSchema = {
  ...Type.Object({
    name: Type.String(),
    aliases: Type.Optional(Type.Array(Type.String())),
    description: Type.Optional(Type.String()),
    input: Type.Optional(
      Type.Object({
        hint: Type.Optional(Type.String()),
      }),
    ),
    subcommands: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          description: Type.Optional(Type.String()),
          usage: Type.Optional(Type.String()),
        }),
      ),
    ),
    source: AvailableSlashCommandSourceSchema,
  }),
  description:
    "Mirror of omp's RpcAvailableSlashCommand (`get_available_commands`).",
};

export const SessionStatsInfoSchema = Type.Object(
  {
    sessionFile: Type.Optional(Type.String()),
    sessionId: Type.String(),
    sessionName: Type.Optional(Type.String()),
    userMessages: Type.Number(),
    assistantMessages: Type.Number(),
    toolCalls: Type.Number(),
    toolResults: Type.Number(),
    totalMessages: Type.Number(),
    tokens: Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      reasoning: Type.Optional(Type.Number()),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
      total: Type.Number(),
    }),
    premiumRequests: Type.Optional(Type.Number()),
    cost: Type.Number(),
    contextUsage: Type.Optional(ContextUsageSchema),
  },
  {
    description:
      "Session statistics snapshot including message counts, token usage, cost and optional context estimate.",
  },
);

export const HostUriRequestFrameSchema = Type.Object(
  {
    type: Type.Literal("host_uri_request"),
    id: Type.String(),
    operation: HostUriOperationSchema,
    url: Type.String(),
    content: {
      ...Type.Optional(Type.String()),
      description: "Present for write operations.",
    },
  },
  {
    description:
      "Native request to read or write a registered host URI, correlated by id.",
  },
);

export const AssistantMessageSchema = Type.Object(
  {
    role: Type.Literal("assistant"),
    content: Type.Array(AssistantContentBlockSchema),
    model: Type.String(),
    provider: Type.String(),
    stopReason: Type.Optional(Type.String()),
    errorMessage: Type.Optional(Type.String()),
    timestamp: Type.Optional(Type.Number()),
    usage: Type.Optional(
      Type.Object({
        input: Type.Number(),
        output: Type.Number(),
        cacheRead: Type.Number(),
        cacheWrite: Type.Number(),
        totalTokens: Type.Optional(Type.Number()),
        cost: Type.Object({
          input: Type.Number(),
          output: Type.Number(),
          cacheRead: Type.Number(),
          cacheWrite: Type.Number(),
          total: Type.Number(),
        }),
      }),
    ),
  },
  {
    description:
      "Assistant message with ordered content blocks, provider/model identity and optional reported usage.",
  },
);

export const UiDialogValueSchema = {
  ...Type.Union([
    Type.String(),
    Type.Boolean(),
    UiAskDialogResultSchema,
    UiFormDialogResultSchema,
    UiApprovalAnswerSchema,
  ]),
  description:
    "Dialog return value selected by method; cancellation sends no value rather than a value of null.",
};

export const UiDialogRequestSchema = {
  ...Type.Intersect([
    Type.Object({
      type: Type.Literal("ui_request"),
      id: Type.Union([Type.Number(), Type.String()], {
        description:
          "Dialog correlation ID; web-owned confirmations use string IDs.",
      }),
      expiresAt: Type.Optional(
        Type.Number({
          description: "Timeout deadline in Unix epoch milliseconds, when set.",
        }),
      ),
    }),
    Type.Union([
      Type.Object({
        method: Type.Literal("select"),
        args: Type.Union([
          Type.Tuple([Type.String(), Type.Array(UiSelectItemSchema)]),
          Type.Tuple([
            Type.String(),
            Type.Array(UiSelectItemSchema),
            Type.Union([UiDialogOptionsArgSchema, Type.Undefined()]),
          ]),
        ]),
      }),
      Type.Object({
        method: Type.Literal("confirm"),
        args: Type.Union([
          Type.Tuple([Type.String(), Type.String()]),
          Type.Tuple([
            Type.String(),
            Type.String(),
            Type.Union([UiDialogOptionsArgSchema, Type.Undefined()]),
          ]),
        ]),
      }),
      Type.Object({
        method: Type.Literal("input"),
        args: Type.Union([
          Type.Tuple([Type.String()]),
          Type.Tuple([
            Type.String(),
            Type.Union([
              Type.Union([Type.String(), Type.Null()]),
              Type.Undefined(),
            ]),
          ]),
          Type.Tuple([
            Type.String(),
            Type.Union([
              Type.Union([Type.String(), Type.Null()]),
              Type.Undefined(),
            ]),
            Type.Union([UiDialogOptionsArgSchema, Type.Undefined()]),
          ]),
        ]),
      }),
      Type.Object({
        method: Type.Literal("editor"),
        args: Type.Union([
          Type.Tuple([Type.String()]),
          Type.Tuple([
            Type.String(),
            Type.Union([
              Type.Union([Type.String(), Type.Null()]),
              Type.Undefined(),
            ]),
          ]),
          Type.Tuple([
            Type.String(),
            Type.Union([
              Type.Union([Type.String(), Type.Null()]),
              Type.Undefined(),
            ]),
            Type.Union([UiDialogOptionsArgSchema, Type.Undefined()]),
          ]),
          Type.Tuple([
            Type.String(),
            Type.Union([
              Type.Union([Type.String(), Type.Null()]),
              Type.Undefined(),
            ]),
            Type.Union([UiDialogOptionsArgSchema, Type.Undefined()]),
            Type.Union([
              Type.Union([
                Type.Object({ promptStyle: Type.Optional(Type.Boolean()) }),
                Type.Null(),
              ]),
              Type.Undefined(),
            ]),
          ]),
        ]),
      }),
      Type.Object({
        method: Type.Literal("askDialog"),
        args: Type.Union([
          Type.Tuple([Type.Array(RpcAskDialogQuestionSchema)]),
          Type.Tuple([
            Type.Array(RpcAskDialogQuestionSchema),
            Type.Union([UiDialogOptionsArgSchema, Type.Undefined()]),
          ]),
        ]),
      }),
      Type.Object({
        method: Type.Literal("formDialog"),
        args: Type.Union([
          Type.Tuple([Type.String()]),
          Type.Tuple([
            Type.String(),
            Type.Union([UiDialogOptionsArgSchema, Type.Undefined()]),
          ]),
        ]),
      }),
      Type.Object({
        method: Type.Literal("approve"),
        args: Type.Union([
          Type.Tuple([UiApprovalPromptSchema]),
          Type.Tuple([
            UiApprovalPromptSchema,
            Type.Union([UiDialogOptionsArgSchema, Type.Undefined()]),
          ]),
        ]),
      }),
    ]),
  ]),
  description:
    "A runner dialog with method-specific positional arguments. Web confirms use string IDs; expiresAt is an epoch-millisecond deadline. The first valid answer wins; cancellation has no value. JSON turns omitted middle arguments into null.",
};

export const OutboxUpdateFrameSchema = {
  ...Type.Object({
    type: Type.Literal("outbox_update"),
    entries: Type.Array(OutboxEntrySchema),
    settledIds: {
      ...Type.Array(Type.String()),
      description:
        "Recent delivered/removed ids: a late first subscription can retire browser copies without seeing their removal.",
    },
    nativeSettledIds: Type.Optional(Type.Array(Type.String())),
  }),
  description:
    "Session-channel outbox snapshot in submission order, with recent settled IDs for retiring stale browser copies.",
};

/** Model metadata safe to send outside the owning host. */
export const WebSessionModelSchema = Type.Object(
  {
    ...ModelLikeSchema.properties,
    name: Type.Optional(Type.String()),
    reasoning: Type.Optional(Type.Boolean()),
    thinking: Type.Optional(
      Type.Object({ efforts: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false, description: "Provider-qualified model identity and browser-visible reasoning metadata; excludes provider headers and credentials." },
);

export const RpcSessionStateSchema = {
  ...Type.Object({
    model: Type.Optional(WebSessionModelSchema),
    thinkingLevel: Type.Union([Type.String(), Type.Undefined()]),
    isStreaming: Type.Boolean(),
    isCompacting: Type.Boolean(),
    steeringMode: Type.Union([
      Type.Literal("all"),
      Type.Literal("one-at-a-time"),
    ]),
    followUpMode: Type.Union([
      Type.Literal("all"),
      Type.Literal("one-at-a-time"),
    ]),
    interruptMode: Type.Union([
      Type.Literal("immediate"),
      Type.Literal("wait"),
    ]),
    sessionFile: Type.Optional(Type.String()),
    sessionId: Type.String(),
    sessionName: Type.Optional(Type.String()),
    autoCompactionEnabled: Type.Boolean(),
    autoRetryEnabled: Type.Optional(Type.Boolean()),
    messageCount: Type.Number(),
    queuedMessageCount: Type.Number(),
    isSettled: {
      ...Type.Optional(Type.Boolean()),
      description:
        "Includes admitted submissions, scheduled turns and background deliveries; absent on older OMP.",
    },
    hasPendingAsyncWork: Type.Optional(Type.Boolean()),
    advisorReviewPending: {
      ...Type.Optional(Type.Boolean()),
      description:
        "An available advisor is evaluating a primary turn boundary, reviewing queued output, or delivering its review; mirrored by advisor_review. A false value does not guarantee a review was scheduled or completed.",
    },
    queuedMessages: {
      ...Type.Optional(QueuedMessagesSchema),
      description:
        "Displayable queue-chip texts (omp ≥ 18.4.4); mirrored live by `queue_update`.",
    },
    supportsClientMessageIds: {
      ...Type.Optional(Type.Boolean()),
      description:
        "Native RPC/session metadata can correlate accepted input without matching its text.",
    },
    todoPhases: Type.Array(TodoPhaseSchema),
    systemPrompt: Type.Optional(Type.Array(Type.String())),
    contextUsage: Type.Optional(
      Type.Object({
        tokens: Type.Number(),
        contextWindow: Type.Number(),
        percent: Type.Number(),
      }),
    ),
    fastMode: Type.Optional(Type.Boolean()),
    fastModeEnabled: Type.Optional(Type.Boolean()),
    fastModeActive: Type.Optional(Type.Boolean()),
    slowModeSupported: {
      ...Type.Optional(Type.Boolean()),
      description: "`/slow` applies to the active model (omp ≥ slow-mode RPC).",
    },
    slowModeEnabled: {
      ...Type.Optional(Type.Boolean()),
      description:
        "Slow setting for the active model; false whenever unsupported.",
    },
    slowModeScope: {
      ...Type.Optional(SlowModeScopeSchema),
      description:
        "Present iff supported: `global` = persisted omp config shared by every session/terminal; `session` = this session's flex tier.",
    },
    usageLimit: {
      ...Type.Optional(UsageLimitStateSchema),
      description:
        "Structured provider usage-limit state; absent outside wrap-up and low priority.",
    },
    tokensPerSecond: {
      ...Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      description:
        "omp's reported output throughput; null/undefined when not generating.",
    },
    modelActivity: Type.Optional(ModelActivitySchema),
  }),
  description: "Runner session state; model metadata excludes host-local provider headers and credentials.",
};

export const WebSessionStateSchema = {
  ...Type.Object({
    sessionId: Type.String(),
    sessionFile: Type.String(),
    sessionName: Type.Optional(Type.String()),
    isStreaming: Type.Boolean(),
    isPromptRunning: Type.Boolean(),
    isBashRunning: Type.Boolean(),
    isCompacting: Type.Boolean(),
    responseObserved: {
      ...Type.Optional(Type.Boolean()),
      description:
        "Web-observed current-run response; not a persisted-history cursor.",
    },
    autoCompactionEnabled: Type.Boolean(),
    interruptMode: Type.Union([
      Type.Literal("immediate"),
      Type.Literal("wait"),
    ]),
    steeringMode: Type.Union([
      Type.Literal("all"),
      Type.Literal("one-at-a-time"),
    ]),
    followUpMode: Type.Union([
      Type.Literal("all"),
      Type.Literal("one-at-a-time"),
    ]),
    model: Type.Optional(WebSessionModelSchema),
    messageCount: Type.Number(),
    queuedMessageCount: Type.Number(),
    queuedMessages: QueuedMessagesSchema,
    supportsClientMessageIds: Type.Optional(Type.Boolean()),
    contextUsage: Type.Union([ContextUsageSchema, Type.Null()], {
      description:
        "Normalized context estimate, or null when unavailable; native state may omit it instead.",
    }),
    systemPrompt: Type.String(),
    thinkingLevel: Type.String(),
    fastModeEnabled: Type.Boolean(),
    fastModeActive: Type.Optional(Type.Boolean()),
    slowModeSupported: Type.Boolean(),
    slowModeEnabled: Type.Boolean(),
    slowModeScope: Type.Optional(SlowModeScopeSchema),
    usageLimit: Type.Optional(UsageLimitStateSchema),
    autoRetryEnabled: Type.Optional(Type.Boolean()),
    tokensPerSecond: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    modelActivity: Type.Optional(ModelActivitySchema),
    todoPhases: Type.Array(TodoPhaseSchema),
    extensionStatuses: Type.Array(
      Type.Object({
        key: Type.String(),
        text: Type.String(),
      }),
    ),
    extensionWidgets: Type.Array(
      Type.Object({
        key: Type.String(),
        lines: Type.Array(Type.String()),
        placement: Type.Union([
          Type.Literal("aboveEditor"),
          Type.Literal("belowEditor"),
        ]),
      }),
    ),
  }),
  description:
    "The state shape keylime's own API returns to the browser\n(AgentSessionWrapper adapts RpcSessionState and adds process-side flags).",
};

export const AgentMessageSchema = Type.Union(
  [
    UserMessageSchema,
    AssistantMessageSchema,
    ToolResultMessageSchema,
    CustomMessageSchema,
    BashExecutionMessageSchema,
    DeveloperMessageSchema,
    PythonExecutionMessageSchema,
    FileMentionMessageSchema,
  ],
  {
    description:
      "Conversation message union spanning user, assistant, tools, extensions and local execution records.",
  },
);

export const SessionMessageEntrySchema = Type.Composite(
  [
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("message"),
      message: AgentMessageSchema,
    }),
  ],
  {
    description:
      "Append-history entry wrapping one agent message and its parent linkage.",
  },
);

export const SessionContextSchema = Type.Object(
  {
    messages: Type.Array(AgentMessageSchema, {
      description: "Messages reconstructed for the selected branch.",
    }),
    entryIds: Type.Array(Type.String(), {
      description: "Entry IDs corresponding to the reconstructed messages.",
    }),
    thinkingLevel: Type.String(),
    model: Type.Union([
      Type.Object({
        provider: Type.String(),
        modelId: Type.String(),
      }),
      Type.Null(),
    ]),
    todoPhases: {
      ...Type.Array(TodoPhaseSchema),
      description:
        "Latest persisted todo snapshot on the selected session branch.",
    },
    persistedClientMessageIds: {
      ...Type.Optional(Type.Array(Type.String())),
      description:
        "Correlated native messages retained in the session's append history, including compacted entries.",
    },
    resolvedClientMessageIds: {
      ...Type.Optional(Type.Array(Type.String())),
      description:
        "Explicit native withdrawals/consumption records; absence alone never resolves a handoff.",
    },
  },
  {
    description:
      "Reconstructed selected-branch context, including model settings and native client-intent evidence.",
  },
);

export const ClientMessageStatusSchema = Type.Object(
  {
    messages: Type.Array(
      Type.Object({
        clientMessageId: Type.String(),
        message: AgentMessageSchema,
      }),
    ),
    queuedMessages: {
      ...Type.Union([QueuedMessagesSchema, Type.Null()]),
      description:
        "Null when the native queue snapshot exceeded the response budget; the browser then reads history.",
    },
    resolvedClientMessageIds: Type.Array(Type.String()),
    persistedClientMessageIds: Type.Array(Type.String()),
    unresolvedClientMessageIds: Type.Array(Type.String()),
  },
  {
    description:
      "Native evidence for queried client message IDs: persisted, resolved, unresolved and possibly queued.",
  },
);

export const SessionEntrySchema = Type.Union(
  [
    SessionMessageEntrySchema,
    ThinkingLevelChangeEntrySchema,
    ModelChangeEntrySchema,
    ServiceTierChangeEntrySchema,
    CompactionEntrySchema,
    BranchSummaryEntrySchema,
    CustomEntrySchema,
    CustomMessageEntrySchema,
    LabelEntrySchema,
    SessionInfoEntrySchema,
    TitleChangeEntrySchema,
    TtsrInjectionEntrySchema,
    SessionInitEntrySchema,
    ModeChangeEntrySchema,
  ],
  {
    description:
      "Session append-history entry, including messages, configuration changes and branch metadata.",
  },
);

export const FileEntrySchema = Type.Union(
  [SessionHeaderSchema, SessionEntrySchema],
  {
    description:
      "A session file record: its header or one append-history entry.",
  },
);

export const SessionTreeNodeSchema = Type.Recursive(
  (This) =>
    Type.Object({
      entry: SessionEntrySchema,
      children: Type.Array(This, {
        description:
          "Child entries ordered by timestamp; broken parent links produce additional roots.",
      }),
      label: Type.Optional(
        Type.String({
          description: "Latest nonempty label assigned to this entry.",
        }),
      ),
      compressedEntryIds: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "IDs of intermediate entries omitted in a projected tree edge.",
        }),
      ),
      branchPreview: Type.Optional(BranchPreviewSchema),
    }),
  {
    description:
      "Session entry tree node indexed by entry ID and linked by parentId; projected trees may compress intermediate entries.",
  },
);
