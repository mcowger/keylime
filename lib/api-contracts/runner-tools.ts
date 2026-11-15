import { Type, type TSchema } from "@sinclair/typebox";
import {
  ImageContentSchema,
  SessionEntryBaseSchema,
  SessionEntrySchema,
  SessionHeaderSchema,
} from "./domain";
import {
  CommitPlanSchema,
  CommitApplyResultSchema,
  PrDescriptionSchema,
} from "./workspace-models";
import {
  NativeAgentMessageSchema,
  runnerEventSchemas,
} from "./runner-native-events";
import type { OperationContract } from "./operations";

// Bootstrapped from lib/subagent-types.ts with TypeScriptToTypeBox.
const s = () => Type.String();
const n = () => Type.Number();
const b = () => Type.Boolean();
const opt = Type.Optional;
const literals = <T extends string>(...values: T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
const strings = () => Type.Array(s());
const model = Type.Union([s(), strings()]);
const source = literals("bundled", "user", "project");
const settled = literals("started", "completed", "failed", "aborted");
const failure = Type.Object({ attempt: n(), errorMessage: s() });
/** Origin of an agent definition, not its parent session. */
export const SubagentAgentSourceSchema = Type.Union(source.anyOf, {
  description: "Origin of the subagent definition: bundled, user, or project.",
});
export const SubagentRetryStateSchema = Type.Object(
  {
    attempt: n(),
    maxAttempts: n(),
    delayMs: Type.Number({
      description: "Delay before retry, in milliseconds.",
    }),
    errorMessage: s(),
    startedAtMs: Type.Number({
      description: "Retry start time in Unix milliseconds.",
    }),
  },
  { description: "Current retry attempt and delay for a subagent operation." },
);
/** Incremental producer-reported fields; consumers must tolerate omissions and tool-defined details. */
export const SubagentProgressSchema = Type.Object(
  {
    index: opt(n()),
    id: opt(s()),
    agent: opt(s()),
    agentSource: opt(source),
    status: opt(
      literals("pending", "running", "completed", "failed", "aborted"),
    ),
    task: opt(s()),
    assignment: opt(s()),
    description: opt(s()),
    lastIntent: opt(s()),
    currentTool: opt(s()),
    currentToolArgs: opt(s()),
    currentToolArgsKey: opt(s()),
    currentToolIntent: opt(s()),
    currentToolStartMs: opt(
      Type.Number({
        description: "Current tool start time in Unix milliseconds.",
      }),
    ),
    recentTools: opt(
      Type.Array(
        Type.Object({
          tool: s(),
          args: s(),
          argsKey: opt(s()),
          intent: opt(s()),
          isError: opt(b()),
          endMs: n(),
        }),
      ),
    ),
    recentOutput: opt(strings()),
    toolCount: opt(n()),
    requests: opt(n()),
    tokens: opt(n()),
    contextTokens: opt(n()),
    contextWindow: opt(n()),
    cost: opt(n()),
    durationMs: opt(
      Type.Number({
        description: "Elapsed subagent duration in milliseconds.",
      }),
    ),
    modelOverride: opt(model),
    modelRole: opt(s()),
    resolvedModel: opt(s()),
    resolvedModelIdentity: opt(s()),
    resolvedThinkingLevel: opt(s()),
    resolvedModelIsFallback: opt(b()),
    resolvedModelRoute: opt(s()),
    advisor: opt(b()),
    completionPercent: opt(Type.Number({ minimum: 0, maximum: 100 })),
    stage: opt(s()),
    watch: opt(s()),
    retryState: opt(SubagentRetryStateSchema),
    retryFailure: opt(failure),
    inflightTaskDetails: opt(
      Type.Unknown({
        description: "Nested task tool's in-flight result details.",
      }),
    ),
    extractedToolData: opt(
      Type.Record(
        s(),
        Type.Array(
          Type.Unknown({ description: "Tool-defined extracted data." }),
        ),
      ),
    ),
  },
  {
    description:
      "Partial live subagent progress; omitted fields have not been reported. Tool arguments and extracted data are tool-defined.",
  },
);
export const SubagentActivityEventSchema = Type.Object(
  {
    kind: literals("tool", "text", "notice"),
    label: s(),
    ts: Type.Number({
      description: "Activity timestamp in Unix milliseconds.",
    }),
  },
  {
    description:
      "A timestamped tool, text, or notice item in subagent activity.",
  },
);
export const SubagentHistoryResultSchema = Type.Object(
  {
    exitCode: opt(n()),
    truncated: opt(b()),
    cost: opt(n()),
    structuredOutput: opt(
      Type.Object({
        source: opt(s()),
        mode: opt(s()),
        status: opt(s()),
        error: opt(s()),
      }),
    ),
    error: opt(s()),
    aborted: opt(b()),
    abortReason: opt(s()),
    outputPath: opt(s()),
    patchPath: opt(s()),
    branchName: opt(s()),
  },
  {
    description:
      "Optional completion details for a subagent, including exit, output and patch paths, or abort/error information.",
  },
);
const baseAgent = {
  id: s(),
  agent: s(),
  agentSource: opt(source),
  description: opt(s()),
  task: opt(s()),
  assignment: opt(s()),
  sessionFile: opt(s()),
  parentToolCallId: opt(
    Type.String({
      description:
        "Tool call linking this spawn to its parent, including nested subagent scope.",
    }),
  ),
  index: Type.Number({
    description: "Index assigned to the subagent within its spawn batch.",
  }),
};
/** Retained result and transcript availability for one spawn, scoped through its parent tool call. */
export const SubagentHistoryEntrySchema = Type.Object(
  {
    ...baseAgent,
    status: settled,
    batchSeq: opt(n()),
    transcriptAvailable: b(),
    detached: opt(b()),
    lastIntent: opt(s()),
    toolCount: opt(n()),
    requests: opt(n()),
    tokens: opt(n()),
    contextTokens: opt(n()),
    contextWindow: opt(n()),
    cost: opt(n()),
    durationMs: opt(n()),
    modelOverride: opt(model),
    modelRole: opt(s()),
    resolvedModel: opt(s()),
    resolvedModelIsFallback: opt(b()),
    retryFailure: opt(failure),
    result: opt(SubagentHistoryResultSchema),
  },
  {
    description:
      "Retained subagent history entry; transcriptAvailable indicates whether its transcript can be read.",
  },
);
export const SubagentInfoSchema = Type.Object(
  {
    ...baseAgent,
    status: settled,
    detached: opt(b()),
    progress: opt(SubagentProgressSchema),
    lastUpdate: opt(n()),
    result: opt(SubagentHistoryResultSchema),
    source: opt(literals("live", "history")),
    batchSeq: opt(n()),
  },
  {
    description:
      "Subagent information from the live roster or retained history, with optional progress and result.",
  },
);
export const SubagentSnapshotLikeSchema = Type.Object(
  {
    ...baseAgent,
    status: literals(
      "started",
      "completed",
      "failed",
      "aborted",
      "pending",
      "running",
    ),
    lastUpdate: opt(n()),
    progress: opt(Type.Unknown()),
  },
  {
    description:
      "Subagent snapshot accepting both lifecycle and live-progress status values; progress is producer-defined.",
  },
);
const snapshot = Type.Object({
  ...baseAgent,
  status: literals("pending", "running", "completed", "failed", "aborted"),
  lastUpdate: n(),
  progress: opt(SubagentProgressSchema),
});
const empty = Type.Object({});
const voidResult = Type.Undefined({ description: "No result payload." });
const status = literals(
  "running",
  "complete",
  "cancelled",
  "error",
  "interrupted",
);
const turnFields = {
  question: s(),
  answer: s(),
  status,
  createdAt: n(),
  updatedAt: n(),
  images: opt(Type.Array(ImageContentSchema)),
  error: opt(s()),
};
const btwTurn = Type.Object(turnFields);
/** Persisted side-question checkpoint; follow-ups are turns of the same record. */
export const BtwRecordSchema = Type.Object(
  {
    ...turnFields,
    id: s(),
    leafId: Type.Union([s(), Type.Null()]),
    followUps: opt(
      Type.Array(btwTurn, {
        description: "Follow-up turns belonging to this side-question record.",
      }),
    ),
  },
  {
    description:
      "Checkpointed side-question record tied to a session leaf, with its answer status and optional follow-ups.",
  },
);
const dynamic = Type.Unknown({
  description: "Extensible tool-defined JSON payload.",
});
const toolDefinition = Type.Object({
  name: s(),
  label: opt(s()),
  description: s(),
  parameters: Type.Record(s(), dynamic, {
    description: "JSON Schema defining tool input.",
  }),
  hidden: opt(b()),
  loadMode: opt(literals("essential", "discoverable")),
  readsSkillUris: opt(b()),
});
export const SetSubagentSubscriptionArgsSchema = Type.Object(
  {
    level: literals("off", "progress", "events"),
  },
  {
    description:
      "Select no forwarding, lifecycle/progress, or full subagent event forwarding for this session.",
  },
);
const schemeDefinition = Type.Object({
  scheme: s(),
  description: opt(s()),
  writable: opt(b()),
  immutable: opt(b()),
});
export const SetHostToolsArgsSchema = Type.Object(
  {
    tools: Type.Array(toolDefinition, {
      description:
        "Complete replacement catalog; each tool's parameters is a host-defined JSON Schema.",
    }),
  },
  {
    description: "Host tool catalog installed into the current runner session.",
  },
);
export const SetHostUriSchemesArgsSchema = Type.Object(
  {
    schemes: Type.Array(schemeDefinition, {
      description: "Complete replacement set of host-owned URI schemes.",
    }),
  },
  {
    description: "URI scheme registrations owned by the connected host bridge.",
  },
);
const op = (
  name: string,
  description: string,
  args: TSchema,
  result: TSchema,
): OperationContract => ({ name, description, args, result });
const liveArgs = { voice: opt(s()), instructions: opt(s()) };
const liveResult = Type.Object({ voice: s(), sdpAnswer: opt(s()) });
const account = Type.Object({
  credentialId: n(),
  provider: s(),
  label: s(),
  detail: s(),
  type: literals("api_key", "oauth"),
  active: b(),
});
const nativeFileEntry = Type.Union([
  SessionHeaderSchema,
  Type.Composite([
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("message"),
      message: NativeAgentMessageSchema,
    }),
  ]),
  ...SessionEntrySchema.anyOf.slice(1),
]);
export const toolsRunnerOperations: readonly OperationContract[] = [
  op(
    "set_host_tools",
    `Usage: Install the host's tool catalog for this session.
Inputs: tools replaces the complete catalog; parameters are tool-defined JSON Schema.
Invariants: Calls and updates are correlated by request id, distinct from toolCallId.
Effects: Refreshes session tools; execution delegates to the connected host.
Recovery: Disconnect fails outstanding calls; reinstall the catalog after reconnect.`,
    SetHostToolsArgsSchema,
    Type.Object({ toolNames: strings() }),
  ),
  op(
    "set_host_uri_schemes",
    `Usage: Register host-owned URI schemes.
Inputs: schemes is the complete replacement list.
Invariants: URI requests are correlated by id; cancellation names the original targetId.
Effects: Changes the process-wide URI router registrations owned by this bridge.
Recovery: Disconnect removes registrations and fails pending requests; register again on reconnect.`,
    SetHostUriSchemesArgsSchema,
    Type.Object({ schemes: strings() }),
  ),
  op(
    "btw",
    `Usage: Ask a side question or continue an existing record.
Inputs: question is text; omit recordId to start a record.
Invariants: Only one side question runs at a time; deltas and snapshots carry recordId.
Effects: Streams an answer and checkpoints turns to the session history sidecar.
Recovery: Inspect history after an uncertain response before submitting another question.`,
    Type.Object({ question: s(), recordId: opt(s()) }),
    Type.Object({ record: BtwRecordSchema }),
  ),
  op(
    "btw_cancel",
    `Usage: Cancel the active side question.
Inputs: Omit recordId to target the active record, or supply its id.
Invariants: cancelled reports whether a matching active request was cancelled.
Effects: Interrupts the answer; its lifecycle is checkpointed.
Recovery: Read history to determine the outcome if the response is lost.`,
    Type.Object({ recordId: opt(s()) }),
    Type.Object({ cancelled: b() }),
  ),
  op(
    "get_btw_history",
    `Usage: Read side-question history for the current session.
Inputs: No arguments.
Invariants: Records are newest first and include follow-up turns.
Effects: Reads the session history sidecar without changing it.
Recovery: Retry a failed read; history reflects saved checkpoints.`,
    empty,
    Type.Object({ records: Type.Array(BtwRecordSchema) }),
  ),
  op(
    "predict_word",
    `Usage: Request composer ghost text.
Inputs: text and cursor, an in-range UTF-16 offset.
Invariants: Disabled prediction, ineligible cursor positions and superseded waiting requests return null.
Effects: May invoke the configured prediction backend; concurrent typing is coalesced.
Recovery: Request again with current text and cursor rather than applying stale suffixes.`,
    Type.Object({ text: s(), cursor: Type.Integer({ minimum: 0 }) }),
    Type.Object({ suffix: Type.Union([s(), Type.Null()]) }),
  ),
  op(
    "predict_word_feedback",
    `Usage: Report whether a prediction was accepted.
Inputs: text, UTF-16 cursor, suggestion and accepted flag.
Invariants: Feedback is ignored when prediction is off or the cursor is ineligible.
Effects: Sends feedback to the configured prediction backend when applicable.
Recovery: A lost response does not establish whether feedback was recorded.`,
    Type.Object({
      text: s(),
      cursor: Type.Integer({ minimum: 0 }),
      suggestion: s(),
      accepted: b(),
    }),
    voidResult,
  ),
  op(
    "dictation_start",
    `Usage: Start draft dictation on the runner microphone.
Inputs: captureId is a caller-chosen nonempty correlation id of at most 128 characters.
Invariants: Speech-to-text must be enabled and live voice inactive; frames carry captureId.
Effects: Starts microphone capture and emits state and transcript frames.
Recovery: On disconnect capture stops; observe its end before starting another.`,
    Type.Object({ captureId: Type.String({ minLength: 1, maxLength: 128 }) }),
    voidResult,
  ),
  op(
    "dictation_stop",
    `Usage: Stop draft dictation and obtain final text.
Inputs: No arguments.
Invariants: Final transcription is flushed before returning.
Effects: Stops capture and emits its end frame.
Recovery: Use the correlated end frame if the response is lost.`,
    empty,
    Type.Object({ text: s() }),
  ),
  op(
    "live_start",
    `Usage: Start live voice using the runner microphone.
Inputs: voice and instructions are optional.
Invariants: Dictation must not be active; only one live session is bound to the session.
Effects: Opens a live voice connection and microphone; delegated work uses session tools.
Recovery: Disconnect stops the live session; reconnect explicitly to resume.`,
    Type.Object(liveArgs),
    liveResult,
  ),
  op(
    "live_connect",
    `Usage: Connect live voice using a remote WebRTC offer.
Inputs: sdpOffer must be nonempty; voice and instructions are optional.
Invariants: Dictation must not be active; the returned SDP answer belongs to this connection.
Effects: Starts live voice without opening the runner microphone.
Recovery: A lost answer requires reconciling the active session before reconnecting.`,
    Type.Object({ ...liveArgs, sdpOffer: Type.String({ minLength: 1 }) }),
    liveResult,
  ),
  op(
    "live_stop",
    `Usage: End live voice.
Inputs: No arguments.
Invariants: Stops the session bound to this runner session.
Effects: Closes the live connection and microphone if open.
Recovery: Reconnect explicitly to start voice again.`,
    empty,
    voidResult,
  ),
  op(
    "live_mute",
    `Usage: Control live microphone mute.
Inputs: Supply muted to set it, or omit it to toggle.
Invariants: The result reports the resulting mute state.
Effects: Changes live voice microphone state.
Recovery: After an uncertain toggle, set an explicit state instead of toggling again.`,
    Type.Object({ muted: opt(b()) }),
    Type.Object({ muted: b() }),
  ),
  op(
    "get_subagents",
    `Usage: Inspect the current session's observed subagent roster.
Inputs: No arguments.
Invariants: The in-memory roster only knows lifecycle events observed since watching began, ordered by index then id.
Effects: Returns a snapshot without changing subagents.
Recovery: Refresh the snapshot; it is not a durable complete history.`,
    empty,
    Type.Object({ subagents: Type.Array(snapshot) }),
  ),
  op(
    "get_subagent_messages",
    `Usage: Incrementally read an owned subagent transcript.
Inputs: Identify it by subagentId or sessionFile; fromByte defaults to zero and is a UTF-8 byte offset.
Invariants: Only current-session-owned transcripts are accessible; only newline-complete entries advance nextByte. An offset past EOF resets to zero.
Effects: Reads the transcript file without modifying it; messages are the message entries in order.
Recovery: Resume at nextByte; on reset discard the old view and rebuild from zero.`,
    Type.Object({
      subagentId: opt(
        Type.String({
          description:
            "Observed subagent id; when supplied it takes precedence over sessionFile.",
        }),
      ),
      sessionFile: opt(
        Type.String({
          description:
            "Previously observed transcript path owned by the current session.",
        }),
      ),
      fromByte: opt(
        Type.Number({
          description:
            "UTF-8 byte offset; defaults to zero and is truncated to a nonnegative integer.",
        }),
      ),
    }),
    Type.Object({
      sessionFile: s(),
      fromByte: Type.Number({
        description:
          "Actual starting byte offset, reset to zero if the requested offset exceeded EOF.",
      }),
      nextByte: Type.Number({
        description:
          "UTF-8 byte offset after the last complete newline-terminated entry.",
      }),
      reset: Type.Boolean({
        description:
          "True when the requested offset exceeded the current file size.",
      }),
      entries: Type.Array(nativeFileEntry),
      messages: Type.Array(NativeAgentMessageSchema),
    }),
  ),
  op(
    "set_subagent_subscription",
    `Usage: Select subagent event forwarding for this session.
Inputs: level is off, progress, or events.
Invariants: events includes forwarded agent events; progress forwards lifecycle and progress.
Effects: Changes the in-memory subscription level.
Recovery: Reapply the desired level after reconnecting.`,
    SetSubagentSubscriptionArgsSchema,
    Type.Object({ level: literals("off", "progress", "events") }),
  ),
  op(
    "cancel_subagent",
    `Usage: Hard-cancel an owned running subagent.
Inputs: subagentId identifies the observed spawn.
Invariants: cancelled is false if it is no longer owned or already gone.
Effects: Releases the agent with an abort tombstone and aborts its session.
Recovery: Inspect the roster after an uncertain response; cancellation may already have occurred.`,
    Type.Object({ subagentId: s() }),
    Type.Object({ cancelled: b() }),
  ),
  op(
    "steer_subagent",
    `Usage: Steer an owned running subagent.
Inputs: subagentId and nonblank message.
Invariants: Ownership is rechecked after resolving the live agent; success means acceptance, not completion.
Effects: Sends a steering prompt to that subagent.
Recovery: After an uncertain response inspect its transcript before resending to avoid duplicate steering.`,
    Type.Object({ subagentId: s(), message: Type.String({ minLength: 1 }) }),
    voidResult,
  ),
  op(
    "get_login_providers",
    `Usage: List OAuth providers and authentication state.
Inputs: No arguments.
Invariants: Availability comes from the provider catalog and authentication from credential storage.
Effects: Reads current in-process registry and stored credential state.
Recovery: Refresh the list after login or logout.`,
    empty,
    Type.Object({
      providers: Type.Array(
        Type.Object({ id: s(), name: s(), available: b(), authenticated: b() }),
      ),
    }),
  ),
  op(
    "login",
    `Usage: Authenticate an OAuth provider interactively.
Inputs: providerId names a known provider; answer numeric-id prompts with login_input_response.
Invariants: Prompts time out after ten minutes; omitted or null answers cancel the input.
Effects: Stores credentials, refreshes provider discovery online and refreshes scoped models.
Recovery: Check authentication state after uncertainty; login may have stored credentials before a refresh failed.`,
    Type.Object({ providerId: s() }),
    Type.Object({ providerId: s() }),
  ),
  op(
    "get_logout_accounts",
    `Usage: List credentials available for provider logout.
Inputs: providerId is required.
Invariants: Accounts are scoped to the requested provider and current session.
Effects: Reads credential storage without removing credentials.
Recovery: Refresh the list before choosing an account.`,
    Type.Object({ providerId: s() }),
    Type.Object({ accounts: Type.Array(account) }),
  ),
  op(
    "logout",
    `Usage: Remove a stored provider credential.
Inputs: providerId and integer credentialId identify the account.
Invariants: A credential not stored for that provider is an error; remainingSource is optional.
Effects: Removes the credential and updates session authentication.
Recovery: Re-list accounts after an uncertain response rather than assuming removal failed.`,
    Type.Object({ providerId: s(), credentialId: Type.Integer() }),
    Type.Object({ remainingSource: opt(s()) }),
  ),
  op(
    "commit_plan",
    `Usage: Propose commits for the workspace while the session is settled.
Inputs: Optional context guides the proposal; changelog false disables changelog detection.
Invariants: Returns null if no staged changes remain after staging the workspace.
Effects: Stages all workspace changes, including partially staged files; may invoke a model.
Recovery: Inspect the Git index after errors or lost responses; staging is not rolled back.`,
    Type.Object({ context: opt(s()), changelog: opt(b()) }),
    Type.Object({ plan: Type.Union([CommitPlanSchema, Type.Null()]) }),
  ),
  op(
    "commit_apply",
    `Usage: Apply a proposed or edited commit plan while the session is settled.
Inputs: plan contains commit groups, dependencies and changelog proposals.
Invariants: Split plans must cover staged files and have valid dependency order.
Effects: Writes changelogs and creates commits; split plans unstage and stage hunks in dependency order.
Recovery: Inspect commits, changelog and index after failure; partial application is not rolled back.`,
    Type.Object({ plan: CommitPlanSchema }),
    CommitApplyResultSchema,
  ),
  op(
    "generate_pr_description",
    `Usage: Generate a PR title and body from the current branch and staged diff.
Inputs: base is a Git ref; context and plannedMessages are optional.
Invariants: Commits are oldest first; the staged diff is bounded and generation requires changes.
Effects: Reads Git and session history and calls the configured model; does not create a PR.
Recovery: Retry generation if needed; output can differ and malformed model output falls back to the log.`,
    Type.Object({
      base: s(),
      context: opt(s()),
      plannedMessages: opt(strings()),
    }),
    PrDescriptionSchema,
  ),
];
const toolResult = Type.Object({
  content: Type.Array(
    Type.Union([
      Type.Object({ type: Type.Literal("text"), text: s() }),
      ImageContentSchema,
    ]),
  ),
  details: opt(dynamic),
});
const frame = (
  t: string,
  fields: Record<string, TSchema>,
  options?: { title: string; description: string },
) => Type.Object({ t: Type.Literal(t), ...fields }, options);
export const toolsRunnerFrames: readonly TSchema[] = [
  frame(
    "host_tool_result",
    { id: s(), result: toolResult, isError: opt(b()) },
    {
      title: "RunnerHostToolResult",
      description:
        "Complete the host tool call correlated by id, optionally reporting an error.",
    },
  ),
  frame(
    "host_tool_update",
    { id: s(), partialResult: toolResult },
    {
      title: "RunnerHostToolUpdate",
      description:
        "Deliver a partial result for the host tool call correlated by id.",
    },
  ),
  frame(
    "host_uri_result",
    {
      id: s(),
      content: opt(s()),
      contentType: opt(
        literals("text/markdown", "application/json", "text/plain"),
      ),
      notes: opt(strings()),
      immutable: opt(b()),
      isError: opt(b()),
      error: opt(s()),
    },
    {
      title: "RunnerHostUriResult",
      description:
        "Complete the host URI request correlated by id with content or an error.",
    },
  ),
  frame(
    "login_input_response",
    { id: n(), value: opt(Type.Union([s(), Type.Null()])) },
    {
      title: "RunnerLoginInputResponse",
      description:
        "Answer the login prompt correlated by id; null or omission cancels it.",
    },
  ),
];
const lifecycle = Type.Object({
  id: s(),
  agent: s(),
  agentSource: source,
  status: settled,
  index: n(),
  description: opt(s()),
  sessionFile: opt(s()),
  parentToolCallId: opt(s()),
  detached: opt(b()),
});
const progress = Type.Object({
  index: n(),
  agent: s(),
  agentSource: source,
  task: s(),
  progress: SubagentProgressSchema,
  parentToolCallId: opt(s()),
  assignment: opt(s()),
  sessionFile: opt(s()),
  detached: opt(b()),
});
const agentEvent = Type.Union([...runnerEventSchemas]);
export const toolsRunnerEvents: readonly TSchema[] = [
  frame("host_tool_call", {
    id: s(),
    toolCallId: s(),
    toolName: s(),
    arguments: Type.Record(s(), dynamic),
  }),
  frame("host_tool_cancel", { id: s(), targetId: s() }),
  frame("host_uri_request", {
    id: s(),
    operation: literals("read", "write"),
    url: s(),
    content: opt(s()),
  }),
  frame("host_uri_cancel", { id: s(), targetId: s() }),
  frame("btw_delta", { recordId: s(), delta: s() }),
  frame("btw_record", { record: BtwRecordSchema }),
  frame("notice", {
    level: Type.Literal("error"),
    message: s(),
    source: Type.Literal("btw-history"),
  }),
  frame("dictation_state", {
    captureId: s(),
    state: literals("starting", "recording", "transcribing"),
  }),
  frame("dictation_transcript", { captureId: s(), text: s() }),
  frame("dictation_end", { captureId: s(), text: s(), error: opt(s()) }),
  frame("live_phase", {
    phase: literals(
      "connecting",
      "listening",
      "working",
      "speaking",
      "muted",
      "error",
    ),
  }),
  frame("live_levels", { input: n(), output: n() }),
  frame("live_transcript", {
    role: literals("user", "assistant"),
    turn: n(),
    text: s(),
    final: b(),
  }),
  frame("live_end", { error: opt(s()) }),
  frame("subagent_lifecycle", { payload: lifecycle }),
  frame("subagent_progress", { payload: progress }),
  frame("subagent_event", {
    payload: Type.Object({ id: s(), event: agentEvent }),
  }),
  frame("login_open_url", {
    url: s(),
    launchUrl: opt(s()),
    instructions: opt(s()),
  }),
  frame("login_progress", { message: s() }),
  frame("login_input", {
    id: n(),
    prompt: s(),
    placeholder: opt(s()),
    secret: b(),
  }),
  frame("login_input_end", { id: n() }),
];
