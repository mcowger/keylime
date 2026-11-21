import {
  Type,
  type TObject,
  type TProperties,
  type TSchema,
} from "@sinclair/typebox";
import {
  BashExecutionMessageSchema,
  PythonExecutionMessageSchema,
  FileMentionMessageSchema,
  ModelActivitySchema,
  QueuedMessagesSchema,
  RpcAvailableSlashCommandSchema,
  TodoItemSchema,
} from "./domain";

/** Live plan review owned by the session's runner. */
export const PlanProposalSchema = Type.Object({
  id: Type.String({ description: "Identity of this pending review; decisions must match it." }),
  title: Type.String({ description: "OMP plan title." }),
  content: Type.String({ description: "Plan artifact text presented for approval." }),
  planFilePath: Type.String({ description: "Session-local plan artifact URI on the owning host." }),
}, { description: "The pending plan artifact and decision identity presented for review." });
export const PlanStateSchema = Type.Object({
  enabled: Type.Boolean({ description: "Whether native plan mode is active." }),
  proposal: Type.Optional(PlanProposalSchema),
}, { description: "Current plan mode and, when present, its pending approval." });

const s = () => Type.String();
const n = () => Type.Number();
const b = () => Type.Boolean();
const opt = Type.Optional;
const strings = () => Type.Array(s());
const literals = (...values: string[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
const event = (type: string, fields: TProperties = {}) =>
  Type.Object({ type: Type.Literal(type), ...fields });
const dynamic = () =>
  Type.Unknown({
    description: "Tool, provider, or extension-defined JSON value.",
  });
const nativeText = Type.Object({
  type: Type.Literal("text"),
  text: s(),
  textSignature: opt(s()),
});
const nativeThinking = Type.Object({
  type: Type.Literal("thinking"),
  thinking: s(),
  thinkingSignature: opt(s()),
  itemId: opt(s()),
  narration: opt(b()),
  isSummary: opt(b()),
});
const nativeImage = Type.Object({
  type: Type.Literal("image"),
  data: Type.String({
    description: "Inline base64-encoded image data on the native wire.",
  }),
  mimeType: Type.String({
    description: "Image media type for the inline data.",
  }),
  detail: opt(literals("auto", "low", "high", "original")),
  url: opt(s()),
  providerFile: opt(Type.Record(s(), dynamic())),
});
const nativeToolCall = Type.Object({
  type: Type.Literal("toolCall"),
  id: Type.String({
    description:
      "Tool call correlation id shared with its tool result and execution events.",
  }),
  name: s(),
  arguments: Type.Record(s(), dynamic(), {
    description:
      "Tool-defined JSON arguments; their shape depends on the named tool.",
  }),
  thoughtSignature: opt(s()),
  intent: opt(s()),
  rawBlock: opt(s()),
  customWireName: opt(s()),
  namespace: opt(s()),
  providerMetadata: opt(Type.Record(s(), dynamic())),
});
/** Provider-native assistant blocks, before the browser normalizes tool calls. */
export const NativeAssistantContentBlockSchema = Type.Union(
  [
    nativeText,
    nativeThinking,
    nativeImage,
    nativeToolCall,
    Type.Object({ type: Type.Literal("redactedThinking"), data: s() }),
    Type.Object({
      type: Type.Literal("fallback"),
      from: Type.Record(s(), dynamic()),
      to: Type.Record(s(), dynamic()),
    }),
    Type.Object({
      type: Type.Literal("anthropicServerTool"),
      block: Type.Record(s(), dynamic()),
    }),
  ],
  {
    description:
      "Provider-native assistant content block. Tool arguments and provider-specific blocks are dynamic JSON; native images carry inline data.",
  },
);
const nativeContent = Type.Union([
  s(),
  Type.Array(Type.Union([nativeText, nativeImage])),
]);
const attribution = opt(literals("user", "agent"));
const providerPayload = opt(Type.Record(s(), dynamic()));
const nativeUsage = Type.Object({
  input: n(),
  output: n(),
  cacheRead: n(),
  cacheWrite: n(),
  totalTokens: n(),
  cost: Type.Object({
    input: n(),
    output: n(),
    cacheRead: n(),
    cacheWrite: n(),
    total: n(),
  }),
  contextTokens: opt(n()),
  premiumRequests: opt(n()),
  reasoningTokens: opt(n()),
  orchestration: opt(Type.Record(s(), dynamic())),
  cttl: opt(Type.Record(s(), dynamic())),
  server: opt(Type.Record(s(), dynamic())),
  credits: opt(Type.Record(s(), dynamic())),
});
const nativeAssistant = Type.Object(
  {
    role: Type.Literal("assistant"),
    content: Type.Array(NativeAssistantContentBlockSchema),
    api: s(),
    provider: s(),
    model: s(),
    usage: nativeUsage,
    stopReason: literals("stop", "length", "toolUse", "error", "aborted"),
    timestamp: n(),
    credentialId: opt(n()),
    responseId: opt(s()),
    upstreamProvider: opt(s()),
    upstreamModel: opt(s()),
    serviceTier: opt(s()),
    elidedOutputTokens: opt(n()),
    errorMessage: opt(s()),
    errorClassificationMessage: opt(s()),
    requestBodyReadTimeoutFullReplay: opt(b()),
    toolCallAbortMessages: opt(Type.Record(s(), s())),
    errorStatus: opt(n()),
    errorId: opt(n()),
    disabledFeatures: opt(strings()),
    providerPayload,
    duration: opt(n()),
    ttft: opt(n()),
    completedAt: opt(n()),
  },
  {
    additionalProperties: true,
    description:
      "Native assistant message; providers may add transport metadata.",
  },
);
const nativeToolResult = Type.Object({
  role: Type.Literal("toolResult"),
  toolCallId: s(),
  toolName: s(),
  content: Type.Array(Type.Union([nativeText, nativeImage])),
  isError: b(),
  timestamp: n(),
  details: opt(dynamic()),
  attribution,
  prunedAt: opt(n()),
  providerMetadata: opt(Type.Record(s(), dynamic())),
  useless: opt(b()),
});
const nativeToolResultPayload = Type.Object({
  content: Type.Array(Type.Union([nativeText, nativeImage])),
  details: opt(dynamic()),
});
const nativeCustom = (role: string) =>
  Type.Object({
    role: Type.Literal(role),
    customType: s(),
    content: nativeContent,
    display: b(),
    timestamp: n(),
    details: opt(dynamic()),
    attribution,
    clientMessageId: opt(s()),
  });
/** SDK messages on the runner wire, including extension-provided transcript roles. */
export const NativeAgentMessageSchema = Type.Union(
  [
    Type.Object({
      role: Type.Literal("user"),
      content: nativeContent,
      timestamp: n(),
      parentIrc: opt(Type.Object({ from: s(), body: s() })),
      synthetic: opt(b()),
      steering: opt(b()),
      liveSteered: opt(b()),
      historyRewriteAt: opt(n()),
      attribution,
      providerPayload,
      clientMessageId: opt(s()),
    }),
    Type.Object({
      role: Type.Literal("developer"),
      content: nativeContent,
      timestamp: n(),
      attribution,
      passiveToolContext: opt(b()),
      synthetic: opt(b()),
      userInitiated: opt(b()),
      providerPayload,
    }),
    nativeAssistant,
    nativeToolResult,
    nativeCustom("custom"),
    nativeCustom("hookMessage"),
    BashExecutionMessageSchema,
    PythonExecutionMessageSchema,
    FileMentionMessageSchema,
    Type.Object({
      role: Type.Literal("branchSummary"),
      summary: s(),
      fromId: s(),
      timestamp: n(),
    }),
    Type.Object({
      role: Type.Literal("compactionSummary"),
      summary: s(),
      tokensBefore: n(),
      timestamp: n(),
      shortSummary: opt(s()),
      tokensAfter: opt(n()),
      method: opt(s()),
      providerPayload,
    }),
  ],
  {
    description:
      "Native runner transcript message, including user, assistant, tool result, execution and extension roles. Native image blocks carry inline data; browser tool-result images may instead use cached media URLs.",
  },
);
const countMap = () => Type.Record(s(), n());
const counters = Type.Object({
  total: n(),
  ok: n(),
  error: n(),
  skipped: n(),
  blocked: n(),
  timeout: n(),
  aborted: n(),
  totalLatencyMs: n(),
});
const telemetry = Type.Object({
  chats: Type.Object({
    total: n(),
    byStopReason: countMap(),
    totalLatencyMs: n(),
  }),
  tools: Type.Object({
    ...counters.properties,
    byName: Type.Record(s(), counters),
  }),
  usage: Type.Object({
    inputTokens: n(),
    outputTokens: n(),
    cachedInputTokens: n(),
    cacheWriteTokens: n(),
    reasoningOutputTokens: n(),
    totalTokens: n(),
  }),
  cost: Type.Object({ estimatedUsd: n(), unavailableReasons: strings() }),
  errors: Type.Object({ total: n(), byType: countMap() }),
  stepCount: n(),
});
const coverage = Type.Object({
  toolsAvailable: strings(),
  toolsInvoked: strings(),
  toolsUnused: strings(),
  modelsUsed: strings(),
  providersUsed: strings(),
});
const compactResult = Type.Object({
  summary: s(),
  shortSummary: opt(s()),
  firstKeptEntryId: s(),
  tokensBefore: n(),
  estimatedTokensAfter: opt(n()),
  details: opt(dynamic()),
  preserveData: opt(Type.Record(s(), dynamic())),
  providerReplayThroughEntryId: opt(s()),
});
const goal = Type.Object({
  id: s(),
  objective: s(),
  status: literals("active", "paused", "budget-limited", "complete", "dropped"),
  tokensUsed: n(),
  timeUsedSeconds: n(),
  createdAt: n(),
  updatedAt: n(),
  tokenBudget: opt(n()),
});
const goalState = Type.Object({
  enabled: b(),
  mode: literals("active", "exiting"),
  reason: opt(Type.Literal("completed")),
  goal,
});
const rule = Type.Object({
  name: s(),
  path: s(),
  content: s(),
  globs: opt(strings()),
  alwaysApply: opt(b()),
  description: opt(s()),
  condition: opt(strings()),
  astCondition: opt(strings()),
  question: opt(s()),
  scope: opt(strings()),
  agents: opt(strings()),
  interruptMode: opt(literals("never", "prose-only", "tool-only", "always")),
  _source: Type.Object({
    provider: s(),
    providerName: s(),
    path: s(),
    level: literals("user", "project", "native"),
    origin: opt(s()),
    pluginName: opt(s()),
    provenance: opt(Type.Object({ repository: s(), version: opt(s()) })),
  }),
});
const index = Type.Number({
  description:
    "Zero-based index of the content block within the assistant message.",
});
const partial = opt(nativeAssistant);
const block = opt(NativeAssistantContentBlockSchema);
/** Both full snapshots and bandwidth-saving deltas are emitted by message_update. */
export const AssistantStreamEventSchema = Type.Union(
  [
    event("start", { partial, message: opt(nativeAssistant) }),
    ...["text_start", "thinking_start", "toolcall_start"].map((type) =>
      event(type, { contentIndex: index, partial, block }),
    ),
    ...["text_delta", "thinking_delta", "toolcall_delta"].map((type) =>
      event(type, { contentIndex: index, delta: s(), partial }),
    ),
    ...["text_end", "thinking_end"].map((type) =>
      event(type, {
        contentIndex: index,
        content: s(),
        partial,
        block: opt(
          Type.Object(
            { type: s() },
            {
              additionalProperties: true,
              description: "Provider block metadata such as a signature.",
            },
          ),
        ),
      }),
    ),
    event("image_end", { contentIndex: index, content: nativeImage, partial }),
    event("toolcall_end", {
      contentIndex: index,
      toolCall: nativeToolCall,
      partial,
    }),
    event("done", {
      reason: literals("stop", "length", "toolUse"),
      message: nativeAssistant,
    }),
    event("error", {
      reason: literals("aborted", "error"),
      error: nativeAssistant,
    }),
  ],
  {
    description:
      "Assistant streaming event. Full mode includes accumulated partial snapshots; delta mode starts blocks with empty shells, applies deltas by contentIndex, and rebases on final end content. Done or error carries the final message.",
  },
);
const messageId = { messageId: opt(s()), clientMessageId: opt(s()) };
const tool = { toolCallId: s(), toolName: s() };
const warming = {
  phase: literals("streaming", "idle"),
  provider: s(),
  model: s(),
};
const action = literals(
  "context-full",
  "remote",
  "handoff",
  "shake",
  "snapcompact",
);
/** Native AgentSession events nested inside the runner's {t:"event",event} frame. */
export const runnerEventSchemas: readonly TSchema[] = [
  event("agent_start", { resumedToolCallIds: opt(strings()) }),
  event("agent_end", {
    messages: Type.Array(NativeAgentMessageSchema),
    telemetry: opt(telemetry),
    coverage: opt(coverage),
    isTerminal: opt(
      Type.Boolean({
        description:
          "Whether this agent run ended terminally; terminal does not itself imply the session has settled.",
      }),
    ),
    yielded: opt(
      Type.Boolean({
        description:
          "The run yielded rather than necessarily completing all session activity.",
      }),
    ),
    awaitingAsyncWork: opt(
      Type.Boolean({
        description:
          "Background work may still wake the session after this agent end.",
      }),
    ),
  }),
  event("turn_start"),
  event("turn_end", {
    message: NativeAgentMessageSchema,
    toolResults: Type.Array(nativeToolResult),
  }),
  event("message_start", { ...messageId, message: NativeAgentMessageSchema }),
  event("message_end", { ...messageId, message: NativeAgentMessageSchema }),
  event("message_update", {
    messageId: opt(s()),
    message: Type.Union([NativeAgentMessageSchema, Type.Object({ role: s() })]),
    assistantMessageEvent: AssistantStreamEventSchema,
  }),
  event("tool_execution_start", { ...tool, args: dynamic(), intent: opt(s()) }),
  event("tool_execution_update", {
    ...tool,
    args: dynamic(),
    partialResult: nativeToolResultPayload,
  }),
  event("tool_stream_update", { ...tool, update: dynamic() }),
  event("tool_execution_end", {
    ...tool,
    result: nativeToolResultPayload,
    isError: opt(b()),
  }),
  event("auto_compaction_start", {
    reason: literals("threshold", "overflow", "idle", "incomplete"),
    action,
  }),
  event("auto_compaction_end", {
    action,
    result: opt(compactResult),
    aborted: b(),
    willRetry: b(),
    errorMessage: opt(s()),
    skipped: opt(b()),
  }),
  event("manual_compaction_start", { mode: opt(s()) }),
  event("manual_compaction_end", {
    result: opt(compactResult),
    aborted: b(),
    skipped: opt(b()),
    errorMessage: opt(s()),
  }),
  event("auto_retry_start", {
    attempt: n(),
    maxAttempts: n(),
    delayMs: n(),
    errorMessage: s(),
    errorId: opt(n()),
  }),
  event("auto_retry_end", {
    success: b(),
    attempt: n(),
    finalError: opt(s()),
    retryErrors: opt(
      Type.Array(
        Type.Object({
          entryId: s(),
          persistenceKey: opt(s()),
          note: s(),
          retryRecovery: Type.Object({
            kind: Type.Literal("auto-retry"),
            status: literals("recovered", "superseded"),
            attempt: n(),
            recoveredAt: opt(s()),
            recovery: literals("credential", "model", "wait", "plain"),
            note: s(),
            supersededBy: opt(
              Type.Object({
                timestamp: n(),
                responseId: opt(s()),
                provider: s(),
                model: s(),
              }),
            ),
          }),
        }),
      ),
    ),
  }),
  event("cache_warming_start", warming),
  event("cache_warming_end", {
    ...warming,
    outcome: literals("hit", "miss", "error", "aborted"),
    usage: opt(nativeUsage),
    warmingStopReason: opt(s()),
  }),
  event("retry_fallback_applied", {
    from: s(),
    to: s(),
    role: s(),
    reason: opt(s()),
  }),
  event("retry_fallback_succeeded", { model: s(), role: s() }),
  ...[
    "model_changed",
    "config_warnings_changed",
    "advisor_cost_changed",
    "advisor_yielded",
    "todo_auto_clear",
    "session_settled",
  ].map((type) => event(type)),
  event("advisor_review", {
    pending: Type.Boolean({
      description:
        "Whether an available advisor is evaluating a turn boundary, reviewing queued output, or delivering its review. False does not guarantee a review was scheduled or completed.",
    }),
  }),
  event("ttsr_triggered", { rules: Type.Array(rule) }),
  event("todo_reminder", {
    todos: Type.Array(TodoItemSchema),
    attempt: n(),
    maxAttempts: n(),
  }),
  event("irc_message", { message: nativeCustom("custom") }),
  event("notice", {
    level: literals("info", "warning", "error"),
    message: s(),
    source: opt(s()),
  }),
  event("thinking_level_changed", {
    thinkingLevel: opt(s()),
    configured: opt(s()),
    resolved: opt(s()),
  }),
  event("goal_updated", {
    goal: Type.Union([goal, Type.Null()]),
    state: opt(goalState),
  }),
  event("plan_state_changed", PlanStateSchema.properties),
  Type.Intersect([
    event("queue_update"),
    QueuedMessagesSchema,
    Type.Object({ liveSteered: n() }),
  ]),
  event("model_activity", { activity: ModelActivitySchema }),
  event("available_commands_update", {
    commands: Type.Array(RpcAvailableSlashCommandSchema),
  }),
  event("session_info_update", { title: opt(s()), sessionId: s() }),
];

/** A cached tool-result image replaces inline data with a same-origin media URL. */
const browserToolImage = Type.Object({
  type: Type.Literal("image"),
  mimeType: opt(
    Type.String({
      description: "Media type when available from the cached tool result.",
    }),
  ),
  url: Type.String({
    description:
      "Same-origin URL for the cached image, replacing inline tool-result data.",
  }),
});
const browserToolContent = Type.Array(
  Type.Union([nativeText, nativeImage, browserToolImage]),
);
const browserToolResult = Type.Object({
  ...nativeToolResult.properties,
  content: browserToolContent,
});
const browserToolResultPayload = Type.Object({
  ...nativeToolResultPayload.properties,
  content: browserToolContent,
});
const browserMessage = Type.Union([
  ...NativeAgentMessageSchema.anyOf,
  browserToolResult,
]);
/** The wrapper rewrites only tool results, never user or assistant image blocks. */
export const browserNativeEventSchemas: readonly TSchema[] =
  runnerEventSchemas.map((schema) => {
    const object = schema as TObject;
    const type = object.properties?.type?.const;
    switch (type) {
      case "tool_execution_update":
        return Type.Object({
          ...object.properties,
          partialResult: browserToolResultPayload,
        });
      case "tool_execution_end":
        return Type.Object({
          ...object.properties,
          result: browserToolResultPayload,
        });
      case "message_start":
      case "message_end":
        return Type.Object({ ...object.properties, message: browserMessage });
      case "turn_end":
        return Type.Object({
          ...object.properties,
          toolResults: Type.Array(browserToolResult),
        });
      case "agent_end":
        return Type.Object({
          ...object.properties,
          messages: Type.Array(browserMessage),
        });
      default:
        return schema;
    }
  });
