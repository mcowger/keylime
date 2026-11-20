import { Type, type Static, type TSchema } from "@sinclair/typebox";
import {
  BranchPreviewSchema,
  OmpModelSchema,
  RpcAvailableSlashCommandSchema,
  RpcSessionStateSchema,
  SessionEntryBaseSchema,
  SessionEntrySchema,
  SessionStatsInfoSchema,
} from "./domain";
import { NativeAgentMessageSchema } from "./runner-native-events";
import type { OperationContract } from "./operations";

const s = () => Type.String();
const n = () => Type.Number();
const b = () => Type.Boolean();
const opt = Type.Optional;
const nullable = (x: TSchema) => Type.Union([x, Type.Null()]);
const literals = (...values: string[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
const empty = Type.Object({});
const none = Type.Undefined({
  description: "No response data; the JSON response omits data.",
});
const image = Type.Object({
  type: Type.Literal("image"),
  data: Type.String({ description: "Base64-encoded image data." }),
  mimeType: Type.String({ description: "Image media type." }),
});
const input = {
  message: Type.String({
    description: "User input text submitted to the session.",
  }),
  images: opt(
    Type.Array(image, {
      description: "Optional inline image content accompanying the input.",
    }),
  ),
  clientMessageId: opt(
    Type.String({
      minLength: 1,
      maxLength: 128,
      description:
        "Session-scoped correlation identity; use status reconciliation after uncertain delivery.",
    }),
  ),
};
const instructions = { customInstructions: opt(s()) };
const modelSelection = { provider: opt(s()), modelId: opt(s()) };
const cancelled = Type.Object({ cancelled: b() });
const entryId = { entryId: s() };
const messages = Type.Object({
  messages: Type.Array(NativeAgentMessageSchema),
});
const slashCommands = Type.Array(RpcAvailableSlashCommandSchema);
const goal = Type.Object({
  id: s(),
  objective: s(),
  status: literals("active", "paused", "budget-limited", "complete", "dropped"),
  tokensUsed: n(),
  timeUsedSeconds: Type.Number({
    description: "Elapsed goal time in seconds.",
  }),
  createdAt: Type.Number({ description: "Goal creation timestamp." }),
  updatedAt: Type.Number({ description: "Most recent goal update timestamp." }),
  tokenBudget: opt(Type.Number({ description: "Optional goal token budget." })),
});
const goalState = Type.Object({
  enabled: b(),
  mode: literals("active", "exiting"),
  reason: opt(Type.Literal("completed")),
  goal,
});
const goalResult = Type.Object({
  goal: nullable(goal),
  state: nullable(goalState),
});
const command = (
  name: string,
  description: string,
  args: TSchema,
  result: TSchema,
): OperationContract => ({ name, description, args, result });
const stats = Type.Intersect([
  SessionStatsInfoSchema,
  Type.Object({
    credits: opt(Type.Object({ cost: n(), committedCost: n(), acuCost: n() })),
    routedModels: opt(Type.Record(s(), n())),
    editRejections: opt(Type.Record(s(), n())),
  }),
]);
const todoPhase = Type.Object({
  name: s(),
  tasks: Type.Array(
    Type.Object({
      content: s(),
      status: literals("pending", "in_progress", "completed", "abandoned"),
      details: opt(s()),
      notes: opt(Type.Array(s())),
    }),
  ),
});
const bashResult = Type.Object({
  output: s(),
  exitCode: opt(n()),
  cancelled: b(),
  timedOut: opt(b()),
  truncated: b(),
  totalLines: n(),
  totalBytes: n(),
  outputLines: n(),
  outputBytes: n(),
  elidedBytes: opt(n()),
  elidedLines: opt(n()),
  columnDroppedBytes: opt(n()),
  columnTruncatedLines: opt(n()),
  columnTruncatedRange: opt(Type.Object({ first: n(), last: n() })),
  columnMax: opt(n()),
  artifactId: opt(s()),
  artifactElidedBytes: opt(n()),
  artifactError: opt(literals("open", "write", "flush", "end")),
  minimized: opt(
    Type.Object({
      filter: s(),
      inputBytes: n(),
      outputBytes: n(),
      artifactId: s(),
    }),
  ),
  workingDir: opt(s()),
  images: opt(Type.Array(image)),
});
const compactResult = Type.Object({
  summary: s(),
  shortSummary: opt(s()),
  firstKeptEntryId: s(),
  tokensBefore: n(),
  details: opt(
    Type.Unknown({ description: "Extension-provided compaction details." }),
  ),
  preserveData: opt(
    Type.Record(
      s(),
      Type.Unknown({ description: "Extension-provided compaction data." }),
    ),
  ),
  providerReplayThroughEntryId: opt(s()),
});
const queuedMessage = Type.Object({
  text: s(),
  images: opt(Type.Array(image)),
});
const queuedIds = Type.Object({
  steering: Type.Array(nullable(s())),
  followUp: Type.Array(nullable(s())),
});
const queueSnapshot = Type.Object({
  steering: Type.Array(s()),
  followUp: Type.Array(s()),
  liveSteered: n(),
  clientMessageIds: opt(queuedIds),
});
const correlationStatus = Type.Object({
  messages: Type.Array(
    Type.Object({ clientMessageId: s(), message: NativeAgentMessageSchema }),
  ),
  queuedMessages: queueSnapshot,
  resolvedClientMessageIds: Type.Array(s()),
  persistedClientMessageIds: Type.Array(s()),
  unresolvedClientMessageIds: Type.Array(s()),
});
const nativeSessionEntry = Type.Union([
  Type.Composite([
    SessionEntryBaseSchema,
    Type.Object({
      type: Type.Literal("message"),
      message: NativeAgentMessageSchema,
    }),
  ]),
  ...SessionEntrySchema.anyOf.slice(1),
]);
const nativeTreeNode = Type.Recursive((This) =>
  Type.Object({
    entry: nativeSessionEntry,
    children: Type.Array(This),
    label: opt(s()),
    compressedEntryIds: opt(Type.Array(s())),
    branchPreview: opt(BranchPreviewSchema),
  }),
);

export const BrowserListResultSchema = Type.Object(
  {
    tabs: Type.Array(
      Type.Object(
        {
          id: Type.String({
            minLength: 1,
            maxLength: 1024,
            description: "Exact CDP target identifier used for capture.",
          }),
          title: Type.String({
            maxLength: 2048,
            description: "Last reported page title, truncated when necessary.",
          }),
          url: Type.String({
            maxLength: 8192,
            description: "Last reported page URL, truncated when necessary.",
          }),
        },
        { description: "A live managed Chromium tab owned by this session." },
      ),
      {
        maxItems: 128,
        description: "Session-owned live Chromium tabs, limited to 128.",
      },
    ),
  },
  {
    description: "Session-owned Chromium tabs available for view-only capture.",
  },
);
export type BrowserListResult = Static<typeof BrowserListResultSchema>;
export const BrowserCaptureResultSchema = Type.Object(
  {
    mimeType: Type.Literal("image/jpeg", {
      description: "The captured image media type.",
    }),
    data: Type.String({
      maxLength: 1024 * 1024,
      description: "Base64-encoded JPEG image, at most 1 MiB encoded.",
    }),
    width: Type.Number({
      exclusiveMinimum: 0,
      description:
        "Visual viewport width in CSS pixels; use with the displayed image to map input coordinates.",
    }),
    height: Type.Number({
      exclusiveMinimum: 0,
      description:
        "Visual viewport height in CSS pixels; use with the displayed image to map input coordinates.",
    }),
  },
  { description: "Bounded view-only capture of a session-owned Chromium tab." },
);
export type BrowserCaptureResult = Static<typeof BrowserCaptureResultSchema>;

const videoTabId = Type.String({ minLength: 1, maxLength: 1024 });
const videoStreamId = Type.String({ minLength: 1, maxLength: 128 });
export const BrowserVideoStartArgsSchema = Type.Object(
  { id: videoTabId },
  {
    additionalProperties: false,
    description: "Start an ephemeral video lease for this session-owned tab.",
  },
);
export const BrowserVideoStreamArgsSchema = Type.Object(
  { id: videoTabId, streamId: videoStreamId },
  {
    additionalProperties: false,
    description:
      "Read or release a video lease for its exact session-owned tab.",
  },
);
export const BrowserVideoStartResultSchema = Type.Object(
  {
    streamId: videoStreamId,
    codec: Type.String({ minLength: 1, maxLength: 128 }),
    width: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
  },
  {
    additionalProperties: false,
    description: "Ephemeral encoded video stream and its CSS viewport.",
  },
);
export const BrowserVideoNextResultSchema = Type.Object(
  {
    width: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
    serverTime: Type.Integer({
      minimum: 0,
      description:
        "Runner clock time in Unix milliseconds when this batch was dequeued.",
    }),
    packets: Type.Array(
      Type.Object(
        {
          type: Type.Union([Type.Literal("key"), Type.Literal("delta")]),
          timestamp: Type.Integer({ minimum: 0 }),
          capturedAt: Type.Integer({
            minimum: 0,
            description: "Source capture time in Unix milliseconds.",
          }),
          width: Type.Number({
            exclusiveMinimum: 0,
            description: "CSS viewport width at capture.",
          }),
          height: Type.Number({
            exclusiveMinimum: 0,
            description: "CSS viewport height at capture.",
          }),
          duration: Type.Optional(Type.Integer({ minimum: 0 })),
          data: Type.String({
            minLength: 4,
            maxLength: 512 * 1024,
            pattern:
              "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
          }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 8 },
    ),
  },
  {
    additionalProperties: false,
    description:
      "Bounded encoded packets; timestamps and durations are in microseconds.",
  },
);
export const BrowserVideoRequestSchema = Type.Union(
  [
    Type.Object(
      { op: Type.Literal("start"), input: BrowserVideoStartArgsSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("next"), input: BrowserVideoStreamArgsSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("stop"), input: BrowserVideoStreamArgsSchema },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Start, read, or stop an ephemeral session browser video stream.",
  },
);
export type BrowserVideoRequest = Static<typeof BrowserVideoRequestSchema>;
export const BrowserVideoStopResultSchema = Type.Object(
  {},
  {
    additionalProperties: false,
    description: "The requested video lease has been released.",
  },
);
export type BrowserVideoStartResult = Static<
  typeof BrowserVideoStartResultSchema
>;
export type BrowserVideoNextResult = Static<
  typeof BrowserVideoNextResultSchema
>;

const browserCoordinate = () => Type.Number({ minimum: 0, maximum: 100000 });
const browserDelta = () => Type.Number({ minimum: -100000, maximum: 100000 });
const browserModifiers = () =>
  Type.Integer({
    minimum: 0,
    maximum: 15,
    description: "CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.",
  });
const browserActionObject = { additionalProperties: false };
export const BrowserControlActionSchema = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal("navigate"),
        url: Type.String({ minLength: 1, maxLength: 8192 }),
      },
      browserActionObject,
    ),
    Type.Object({ type: Type.Literal("back") }, browserActionObject),
    Type.Object({ type: Type.Literal("forward") }, browserActionObject),
    Type.Object({ type: Type.Literal("reload") }, browserActionObject),
    Type.Object(
      {
        type: Type.Literal("pointer"),
        event: Type.Union([
          Type.Literal("move"),
          Type.Literal("down"),
          Type.Literal("up"),
        ]),
        x: browserCoordinate(),
        y: browserCoordinate(),
        button: Type.Union([
          Type.Literal("none"),
          Type.Literal("left"),
          Type.Literal("middle"),
          Type.Literal("right"),
        ]),
        buttons: Type.Integer({
          minimum: 0,
          maximum: 31,
          description:
            "Pressed mouse buttons as the DOM/CDP bitmask: left 1, right 2, middle 4, back 8, forward 16.",
        }),
        clickCount: Type.Integer({ minimum: 0, maximum: 3 }),
        modifiers: browserModifiers(),
      },
      browserActionObject,
    ),
    Type.Object(
      {
        type: Type.Literal("wheel"),
        x: browserCoordinate(),
        y: browserCoordinate(),
        deltaX: browserDelta(),
        deltaY: browserDelta(),
        modifiers: browserModifiers(),
      },
      browserActionObject,
    ),
    Type.Object(
      {
        type: Type.Literal("key"),
        event: Type.Union([Type.Literal("down"), Type.Literal("up")]),
        key: Type.String({ maxLength: 128 }),
        code: Type.String({ maxLength: 128 }),
        windowsVirtualKeyCode: Type.Integer({ minimum: 0, maximum: 65535 }),
        modifiers: browserModifiers(),
        repeat: Type.Boolean(),
      },
      browserActionObject,
    ),
    Type.Object(
      { type: Type.Literal("text"), text: Type.String({ maxLength: 65536 }) },
      browserActionObject,
    ),
    Type.Object(
      {
        type: Type.Literal("touch"),
        event: Type.Union([
          Type.Literal("start"),
          Type.Literal("move"),
          Type.Literal("end"),
          Type.Literal("cancel"),
        ]),
        points: Type.Array(
          Type.Object(
            {
              id: Type.Integer({ minimum: 0, maximum: 2147483647 }),
              x: browserCoordinate(),
              y: browserCoordinate(),
            },
            browserActionObject,
          ),
          { maxItems: 10 },
        ),
        modifiers: browserModifiers(),
      },
      browserActionObject,
    ),
  ],
  {
    description:
      "A single browser navigation or input action. Coordinates are visual viewport CSS pixels; touch points are the contacts remaining after the event.",
  },
);
export type BrowserControlAction = Static<typeof BrowserControlActionSchema>;
/** Bounds one ordered input dispatch without growing the per-command work indefinitely. */
export const BROWSER_CONTROL_BATCH_MAX = 64;
export const BrowserControlArgsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 1024 }),
    actions: Type.Array(BrowserControlActionSchema, {
      minItems: 1,
      maxItems: BROWSER_CONTROL_BATCH_MAX,
      description:
        "Actions applied sequentially in array order after whole-batch validation. Ownership is rechecked before each action. Failure may leave an applied prefix; never retry the batch automatically.",
    }),
  },
  {
    additionalProperties: false,
    description:
      "A bounded ordered batch addressed to one exact session-owned Chromium target. HTTP request bodies are limited to 1 MiB. No atomicity or exclusive control against other viewers or the agent is promised.",
  },
);
export type BrowserControlArgs = Static<typeof BrowserControlArgsSchema>;
export const BrowserControlResultSchema = Type.Object(
  {},
  {
    additionalProperties: false,
    description:
      "Every action in the batch was accepted in order; navigation and page effects may still be pending. Failure may leave an applied prefix.",
  },
);
export type BrowserControlResult = Static<typeof BrowserControlResultSchema>;

export const LiteralPromptReceiptSchema = Type.Object(
  { recorded: Type.Literal(true) },
  {
    description:
      "The runner verified that the exact Brief is the first saved user message.",
  },
);

/** Logical runner commands before command/response framing. */
export const lifecycleRunnerOperations: readonly OperationContract[] = [
  command(
    "browser_list",
    `Usage: List the session's live managed Chromium tabs.
Inputs: None.
Invariants: Only tabs owned by this session are returned; ids identify exact CDP targets.
Effects: None; this does not start or change a browser.
Recovery: List again when a tab closes or is replaced.`,
    empty,
    BrowserListResultSchema,
  ),
  command(
    "browser_capture",
    `Usage: Capture a view-only image of a session-owned Chromium tab.
Inputs: Provide the exact target id returned by browser_list.
Invariants: Ownership and target identity are checked at capture time; the image is bounded JPEG data encoded as base64.
Effects: Reads the visible page without input or browser lifecycle changes.
Recovery: List tabs again if the target is unavailable.`,
    Type.Object({ id: Type.String({ minLength: 1, maxLength: 1024 }) }),
    BrowserCaptureResultSchema,
  ),
  command(
    "browser_video_start",
    `Usage: Start encoded video for a session-owned tab.
Inputs: Supply the exact discovered target id.
Invariants: Ownership is checked and no CDP endpoint is exposed.
Effects: Starts an ephemeral bounded video stream.
Recovery: Stop when hidden and start again after disconnect.`,
    BrowserVideoStartArgsSchema,
    BrowserVideoStartResultSchema,
  ),
  command(
    "browser_video_next",
    `Usage: Pull encoded packets from an active video stream.
Inputs: Supply its target id and stream id.
Invariants: Packets are bounded and ephemeral; ownership is rechecked.
Effects: Consumes queued packets.
Recovery: Restart the stream after an error or decoder failure.`,
    BrowserVideoStreamArgsSchema,
    BrowserVideoNextResultSchema,
  ),
  command(
    "browser_video_stop",
    `Usage: Stop an encoded video stream.
Inputs: Supply its target id and stream id.
Invariants: Only the owning session can stop the stream.
Effects: Releases video resources.
Recovery: Streams expire when the viewer disconnects.`,
    BrowserVideoStreamArgsSchema,
    BrowserVideoStopResultSchema,
  ),
  command(
    "browser_control",
    `Usage: Send a bounded ordered batch of navigation or input actions to a session-owned Chromium tab.
Inputs: Provide the exact target id and 1–64 browser control actions in delivery order; navigation accepts HTTP or HTTPS URLs.
Invariants: The entire batch is validated before dispatch. Ownership and exact target identity are rechecked before each action; coordinates use the captured visual viewport in CSS pixels. No exclusive control or agent lock is established.
Effects: Sequentially delivers navigation, mouse, wheel, keyboard, text, or touch input through one CDP session. A failure stops the batch and may leave an applied prefix.
Recovery: A timeout or disconnect leaves partial delivery uncertain; never replay the batch or its remaining actions automatically.`,
    BrowserControlArgsSchema,
    BrowserControlResultSchema,
  ),
  command(
    "prompt",
    `Usage: Submit user input to the session.
Inputs: Provide message and optional images, clientMessageId and streamingBehavior.
Invariants: The reply acknowledges admission, not completion; local builtins can report agentInvoked without a normal agent turn. A clientMessageId is unique within the session's correlation journal, not a global retry key.
Effects: Runs input hooks and may enqueue or start an agent turn.
Recovery: Reconcile an uncertain correlated submission with get_client_message_status; observe prompt result and settled state separately.`,
    Type.Object({
      ...input,
      streamingBehavior: opt(literals("steer", "followUp")),
    }),
    Type.Union([none, Type.Object({ agentInvoked: b() })]),
  ),
  command(
    "prompt_literal",
    `Usage: Record text as the first user message of a new task chat.
Inputs: Provide the exact nonblank Brief and optional inline images. Preserve whitespace, slash prefixes and image order.
Invariants: Only an idle chat without user messages or queued input can accept it. Input hooks, slash commands and template expansion do not run. Success confirms the first user message was saved, not that the model completed a turn.
Effects: Submits literal user text through OMP's native input queue and waits for transcript persistence.
Recovery: For literal_delivery_unknown, a timeout or a lost reply, check the linked chat and never resend automatically.`,
    Type.Object({ message: input.message, images: input.images }),
    LiteralPromptReceiptSchema,
  ),
  command(
    "steer",
    `Usage: Steer the current run.
Inputs: Provide message, optional images and clientMessageId.
Invariants: Admission is ordered with other user input; acknowledgement is not turn completion.
Effects: Delivers or queues steering input after input hooks.
Recovery: Reconcile an uncertain correlated input before sending another.`,
    Type.Object(input),
    none,
  ),
  command(
    "follow_up",
    `Usage: Enqueue follow-up input.
Inputs: Provide message, optional images and clientMessageId.
Invariants: Acknowledgement follows admission, not completion; the queue is session state.
Effects: Adds follow-up input for the agent.
Recovery: Reconcile an uncertain correlated input and inspect the queue before resubmitting.`,
    Type.Object(input),
    none,
  ),
  command(
    "remove_queued_message",
    `Usage: Remove a matching queued message.
Inputs: Supply message text and steering or followUp queue.
Invariants: The result says whether a match was found and includes its images when present.
Effects: Removes the matching queued input.
Recovery: Inspect the queue after an uncertain response before removing again.`,
    Type.Object({ message: s(), queue: literals("steering", "followUp") }),
    Type.Object({ removed: b(), images: opt(Type.Array(image)) }),
  ),
  command(
    "promote_queued_message",
    `Usage: Promote a queued message.
Inputs: Supply its message text.
Invariants: The result reports whether a match was promoted.
Effects: Changes the queued message's priority.
Recovery: Inspect the queue after an uncertain response.`,
    Type.Object({ message: s() }),
    Type.Object({ promoted: b() }),
  ),
  command(
    "abort",
    `Usage: Abort the active run and pending input.
Inputs: No arguments.
Invariants: Cancellation does not undo already completed side effects.
Effects: Stops goal continuation and builtin work, voids queued input and aborts the run.
Recovery: Inspect state and transcript after uncertainty; recover editor input separately.`,
    empty,
    none,
  ),
  command(
    "abort_and_restore_queue",
    `Usage: Abort and recover queued input for an editor.
Inputs: No arguments.
Invariants: Queue entries are withdrawn before abort so the interrupted run cannot consume them.
Effects: Stops the run and returns steering and follow-up messages; prior effects are not rolled back.
Recovery: Restore the returned messages in the editor; inspect session state if the response was lost.`,
    empty,
    Type.Object({
      steering: Type.Array(queuedMessage),
      followUp: Type.Array(queuedMessage),
    }),
  ),
  command(
    "abort_and_prompt",
    `Usage: Abort the current run and submit replacement input asynchronously.
Inputs: Provide message, optional images and clientMessageId.
Invariants: The reply follows abort but may precede replacement admission; later dispatch errors arrive as prompt_error and prompt_result.
Effects: Stops the active run and schedules replacement input; completed side effects are not undone.
Recovery: Reconcile the clientMessageId and observe prompt_result after uncertainty before resending.`,
    Type.Object(input),
    none,
  ),
  command(
    "set_steering_mode",
    `Usage: Set steering queue mode.
Inputs: mode is all or one-at-a-time.
Invariants: The setting is session-only and is not persisted.
Effects: Changes how steering messages are consumed.
Recovery: Read state and reapply the desired mode after restart.`,
    Type.Object({ mode: literals("all", "one-at-a-time") }),
    none,
  ),
  command(
    "set_follow_up_mode",
    `Usage: Set follow-up queue mode.
Inputs: mode is all or one-at-a-time.
Invariants: The setting is session-only and is not persisted.
Effects: Changes how follow-up messages are consumed.
Recovery: Read state and reapply the desired mode after restart.`,
    Type.Object({ mode: literals("all", "one-at-a-time") }),
    none,
  ),
  command(
    "set_interrupt_mode",
    `Usage: Set interrupt mode.
Inputs: mode is immediate or wait.
Invariants: The setting is session-only and is not persisted.
Effects: Changes how the session handles interruptions.
Recovery: Read state and reapply the desired mode after restart.`,
    Type.Object({ mode: literals("immediate", "wait") }),
    none,
  ),
  command(
    "handoff",
    `Usage: Compact the current session with an OMP handoff summary.
Inputs: Optional string customInstructions guides the summary.
Invariants: Compaction runs in the background without interrupting an active response. OMP rejects overlapping compaction or a session transition.
Effects: Updates the current session's context, not a separate session. The runner waits for compaction to finish before replying with {}; compaction errors fail the command.
Recovery: If delivery is uncertain, inspect session state and manual_compaction_end before retrying.`,
    Type.Object(instructions),
    Type.Object({}),
  ),
  command(
    "goal",
    `Usage: Read or control the session goal.
Inputs: Select get, create, resume, pause or drop; objective and token_budget are optional operation inputs.
Invariants: Goal state belongs to the current session; operations have different state preconditions.
Effects: Mutating operations change goal continuation state.
Recovery: Read the goal before retrying an uncertain mutation.`,
    Type.Object({
      op: literals("get", "create", "resume", "pause", "drop"),
      objective: opt(s()),
      token_budget: opt(n()),
    }),
    goalResult,
  ),
  command(
    "set_todos",
    `Usage: Replace session todo phases.
Inputs: Supply the complete phases array with tasks and statuses.
Invariants: This replaces rather than patches the existing phases.
Effects: Commits the supplied todo state and returns the resulting phases.
Recovery: Read session state after uncertainty before replacing again.`,
    Type.Object({ phases: Type.Array(todoPhase) }),
    Type.Object({ todoPhases: Type.Array(todoPhase) }),
  ),
  command(
    "bash",
    `Usage: Execute a shell command while streaming bash_output frames.
Inputs: Supply command and optionally excludeFromContext.
Invariants: Output frames are incremental; the result follows execution.
Effects: Runs a shell command with its ordinary filesystem and process side effects.
Recovery: Inspect external state after uncertainty; rerunning a shell command may duplicate side effects.`,
    Type.Object({ command: s(), excludeFromContext: opt(b()) }),
    bashResult,
  ),
  command(
    "abort_bash",
    `Usage: Abort the active shell command.
Inputs: No arguments.
Invariants: Aborting cannot undo effects the command already made.
Effects: Signals the shell execution to stop.
Recovery: Inspect shell result and external state after uncertainty.`,
    empty,
    none,
  ),
  command(
    "get_client_message_status",
    `Usage: Recover correlation for one to 32 unique client message IDs.
Inputs: Supply unique nonempty IDs up to 128 characters each.
Invariants: Status reflects this session's in-flight and journaled input; bounded responses can omit oversized native messages.
Effects: Reads correlation state without submitting input.
Recovery: Use session history when messages are omitted; do not treat an uncertain transport as proof of non-admission.`,
    Type.Object({
      clientMessageIds: Type.Array(
        Type.String({ minLength: 1, maxLength: 128 }),
        { minItems: 1, maxItems: 32, uniqueItems: true },
      ),
    }),
    correlationStatus,
  ),
  command(
    "get_state",
    `Usage: Read live session state.
Inputs: No arguments.
Invariants: This is a current in-process snapshot, not a durable history or completion guarantee.
Effects: Reads model, queue, goal, tools and activity state without submitting work.
Recovery: Refresh after reconnecting or when state changes.`,
    empty,
    Type.Intersect([
      RpcSessionStateSchema,
      Type.Object({
        advisorReviewPending: Type.Boolean(),
        queuedMessages: queueSnapshot,
        todoPhases: Type.Array(todoPhase),
        goal: nullable(goalState),
        dumpTools: Type.Array(
          Type.Object({
            name: s(),
            description: s(),
            parameters: Type.Unknown({
              description: "Tool's dynamic JSON Schema.",
            }),
            examples: opt(
              Type.Array(
                Type.Unknown({ description: "Tool-specific example JSON." }),
              ),
            ),
          }),
        ),
      }),
    ]),
  ),
  command(
    "set_model",
    `Usage: Select an exact provider and model for this session.
Inputs: Supply both provider and modelId.
Invariants: A miss waits for background discovery and refreshes that provider on the session's host before failing.
Effects: Changes the active session model.
Recovery: Read state or available models after an uncertain response before selecting again.`,
    Type.Object({ provider: s(), modelId: s() }),
    OmpModelSchema,
  ),
  command(
    "cycle_model",
    `Usage: Cycle the available session models.
Inputs: No arguments.
Invariants: Result may be null; isScoped reports whether selection used the configured model scope.
Effects: Selects the next model when available.
Recovery: Read current state after uncertainty rather than cycling again blindly.`,
    empty,
    nullable(
      Type.Object({
        model: OmpModelSchema,
        isScoped: b(),
        thinkingLevel: opt(s()),
      }),
    ),
  ),
  command(
    "get_available_models",
    `Usage: List currently available models.
Inputs: No arguments.
Invariants: Waits for background discovery; results reflect the current registry.
Effects: Reads model availability without selecting a model.
Recovery: Refresh after discovery or provider configuration changes.`,
    empty,
    Type.Object({ models: Type.Array(OmpModelSchema) }),
  ),
  command(
    "refresh_available_models",
    `Usage: Refresh and list available models from configured providers.
Inputs: No arguments.
Invariants: Waits for background discovery and serializes explicit registry refreshes; the session and active run remain alive. Discovery and configuration failures reject the command.
Effects: Bypasses discovery caches, refreshes command-backed credentials and updates the live registry and model scope.
Recovery: Check provider configuration and retry after a failure.`,
    empty,
    Type.Object({ models: Type.Array(OmpModelSchema) }),
  ),
  command(
    "set_thinking_level",
    `Usage: Set the thinking level.
Inputs: Supply level.
Invariants: Valid levels depend on the configured model.
Effects: Changes the session thinking setting.
Recovery: Read state after uncertainty before reapplying.`,
    Type.Object({ level: s() }),
    none,
  ),
  command(
    "cycle_thinking_level",
    `Usage: Cycle available thinking levels.
Inputs: No arguments.
Invariants: Null means no level was selected.
Effects: Changes the current thinking level when possible.
Recovery: Read state after uncertainty rather than cycling again blindly.`,
    empty,
    nullable(Type.Object({ level: s() })),
  ),
  command(
    "get_available_thinking_levels",
    `Usage: List available thinking levels.
Inputs: No arguments.
Invariants: Levels reflect the current session model.
Effects: Reads the live model configuration without changing it.
Recovery: Refresh after changing models.`,
    empty,
    Type.Object({ levels: Type.Array(s()) }),
  ),
  command(
    "set_fast_mode",
    `Usage: Set fast mode.
Inputs: Supply enabled.
Invariants: Enabled and active are distinct: the current model determines whether fast mode is active.
Effects: Changes the session fast-mode setting.
Recovery: Read state after uncertainty before reapplying.`,
    Type.Object({ enabled: b() }),
    Type.Object({ enabled: b(), active: b() }),
  ),
  command(
    "set_slow_mode",
    `Usage: Set slow mode.
Inputs: Supply enabled.
Invariants: Support and scope depend on the current session model.
Effects: Changes the slow-mode setting and returns its effective enabled state.
Recovery: Read state after uncertainty before reapplying.`,
    Type.Object({ enabled: b() }),
    Type.Object({ enabled: b() }),
  ),
  command(
    "set_auto_compaction",
    `Usage: Configure automatic compaction.
Inputs: Supply enabled.
Invariants: This changes the setting, not an existing compaction result.
Effects: Enables or disables future automatic compaction.
Recovery: Read session state after uncertainty.`,
    Type.Object({ enabled: b() }),
    none,
  ),
  command(
    "set_auto_retry",
    `Usage: Configure automatic retry.
Inputs: Supply enabled.
Invariants: This is separate from aborting a pending retry.
Effects: Enables or disables future automatic retries.
Recovery: Inspect current configuration after uncertainty.`,
    Type.Object({ enabled: b() }),
    none,
  ),
  command(
    "abort_retry",
    `Usage: Abort a pending retry.
Inputs: No arguments.
Invariants: Already completed work is not rolled back.
Effects: Signals the pending retry to stop.
Recovery: Inspect session activity after uncertainty.`,
    empty,
    none,
  ),
  command(
    "set_cache_warming",
    `Usage: Set cache warming mode.
Inputs: mode is off, streaming or idle.
Invariants: The returned mode is the effective setting.
Effects: Changes the session cache warmer configuration.
Recovery: Inspect the current setting after uncertainty.`,
    Type.Object({ mode: literals("off", "streaming", "idle") }),
    Type.Object({ mode: literals("off", "streaming", "idle") }),
  ),
  command(
    "compact",
    `Usage: Compact session context.
Inputs: customInstructions may be omitted.
Invariants: Compaction may be aborted and is not a transcript deletion guarantee.
Effects: Produces and persists a compacted context summary.
Recovery: Inspect session state and history after uncertainty before compacting again.`,
    Type.Object(instructions),
    compactResult,
  ),
  command(
    "abort_compaction",
    `Usage: Abort in-flight compaction.
Inputs: No arguments.
Invariants: This requests cancellation rather than reversing a completed compaction.
Effects: Signals the compaction operation to stop.
Recovery: Inspect compaction state and history after uncertainty.`,
    empty,
    none,
  ),
  command(
    "generate_title",
    `Usage: Generate a session title.
Inputs: No arguments.
Invariants: The title may be null when none is generated.
Effects: Persists a generated title when available.
Recovery: Inspect the session name after uncertainty before generating again.`,
    empty,
    Type.Object({ title: nullable(s()) }),
  ),
  command(
    "get_session_stats",
    `Usage: Read session usage statistics.
Inputs: No arguments.
Invariants: Statistics describe the current session snapshot.
Effects: Reads usage without changing the session.
Recovery: Refresh after further activity.`,
    empty,
    stats,
  ),
  command(
    "get_available_commands",
    `Usage: List available slash commands.
Inputs: No arguments.
Invariants: The list reflects current session capabilities.
Effects: Reads the current command registry.
Recovery: Refresh after extensions or session configuration change.`,
    empty,
    Type.Object({ commands: slashCommands }),
  ),
  command(
    "new_session",
    `Usage: Create a session, optionally linked to a parent.
Inputs: parentSession may be omitted.
Invariants: A cancelled change does not detach the current run.
Effects: On success switches the process to the new session.
Recovery: Inspect current identity after uncertainty before creating another session.`,
    Type.Object({ parentSession: opt(s()) }),
    cancelled,
  ),
  command(
    "switch_session",
    `Usage: Switch to a session file.
Inputs: Supply sessionPath and optionally both provider and modelId.
Invariants: A cancelled switch leaves the current session in place.
Effects: On success changes session and may detach a live run.
Recovery: Inspect current identity after uncertainty before switching again.`,
    Type.Object({ sessionPath: s(), ...modelSelection }),
    cancelled,
  ),
  command(
    "open_session",
    `Usage: Resume the newest nonempty session in a directory or create one.
Inputs: Supply sessionDir and optionally both provider and modelId.
Invariants: Session persistence is required; reopening the active session does not detach its live run.
Effects: May switch or create a session and select its model.
Recovery: Inspect returned identity or current state after uncertainty before reopening.`,
    Type.Object({ sessionDir: s(), ...modelSelection }),
    Type.Object({
      cancelled: b(),
      resumed: b(),
      sessionId: s(),
      sessionFile: opt(s()),
    }),
  ),
  command(
    "fork",
    `Usage: Fork a session snapshot at an optional entry.
Inputs: entryId may be omitted.
Invariants: The session must be idle for a consistent snapshot; idleness is rechecked after awaits.
Effects: Switches to the fork unless cancelled.
Recovery: Inspect current session identity after uncertainty; retry session_busy only once work has settled.`,
    Type.Object({ entryId: opt(s()) }),
    cancelled,
  ),
  command(
    "branch",
    `Usage: Branch from a user entry.
Inputs: Supply entryId.
Invariants: Branching differs from editing the current history leaf; a live run continues normally.
Effects: Changes session branch and returns selected text unless cancelled.
Recovery: Inspect session identity and tree before repeating an uncertain branch.`,
    Type.Object(entryId),
    Type.Object({ text: opt(s()), cancelled: b() }),
  ),
  command(
    "navigate_tree",
    `Usage: Navigate the session tree, optionally summarizing the abandoned branch.
Inputs: Supply entryId and optional summarize and customInstructions.
Invariants: The entry must exist and the session must be idle; ask re-answer is unsupported over RPC.
Effects: Moves the current leaf and may create a summary unless cancelled.
Recovery: Inspect the tree and leaf after uncertainty before navigating again.`,
    Type.Object({ ...entryId, summarize: opt(b()), ...instructions }),
    Type.Object({ cancelled: b(), aborted: opt(b()), editorText: opt(s()) }),
  ),
  command(
    "edit_message",
    `Usage: Prepare a user message for editing by moving the leaf before it.
Inputs: Supply the user message entryId.
Invariants: The session must have no snapshot-busy or pending asynchronous work; the old branch remains in the tree.
Effects: Persists the navigation, but does not submit edited text.
Recovery: Inspect session identity and leaf after uncertainty before editing or resending.`,
    Type.Object(entryId),
    Type.Object({ sessionId: s(), cancelled: b(), leafId: nullable(s()) }),
  ),
  command(
    "abort_branch_summary",
    `Usage: Abort branch summarization.
Inputs: No arguments.
Invariants: This does not undo a summary already completed.
Effects: Signals the active branch summary to stop.
Recovery: Inspect the tree after uncertainty.`,
    empty,
    none,
  ),
  command(
    "get_tree",
    `Usage: Read the session tree and current leaf.
Inputs: No arguments.
Invariants: This is a current session snapshot and can change with navigation.
Effects: Reads the in-process tree without modifying it.
Recovery: Refresh after session or leaf changes.`,
    empty,
    Type.Object({ tree: Type.Array(nativeTreeNode), leafId: nullable(s()) }),
  ),
  command(
    "get_entries",
    `Usage: Read session entries after an optional entry cursor.
Inputs: Omit since for all entries, or supply an existing entry id.
Invariants: Results exclude the cursor entry; an unknown id fails with unknown_since.
Effects: Reads the current session entry list and leaf.
Recovery: Restart without a cursor if the cursor is no longer valid.`,
    Type.Object({ since: opt(s()) }),
    Type.Object({
      entries: Type.Array(nativeSessionEntry),
      leafId: nullable(s()),
    }),
  ),
  command(
    "get_messages",
    `Usage: Read the live transcript.
Inputs: No arguments.
Invariants: This is the current in-memory transcript and may change during a run.
Effects: Reads messages without modifying them.
Recovery: Refresh after reconnecting or use bounded paging while idle.`,
    empty,
    messages,
  ),
  command(
    "get_messages_page",
    `Usage: Read a bounded page of the live transcript.
Inputs: Omit cursor for the first page; limit defaults to 100 and is at most 256.
Invariants: Pages are bounded by a byte budget; a transcript change makes cursors stale and streaming or compaction rejects paging.
Effects: Reads an in-memory snapshot without modifying the transcript.
Recovery: Restart from the first page after a stale cursor or once the session is idle.`,
    Type.Object({
      cursor: opt(Type.String({ maxLength: 2048 })),
      limit: opt(Type.Integer({ minimum: 1, maximum: 256 })),
    }),
    Type.Object({
      messages: Type.Array(NativeAgentMessageSchema),
      nextCursor: opt(s()),
      totalMessages: n(),
    }),
  ),
  command(
    "get_branch_messages",
    `Usage: List user messages available for branching.
Inputs: No arguments.
Invariants: Entry ids refer to the current session tree.
Effects: Reads branch candidates without navigating.
Recovery: Refresh after session or tree changes.`,
    empty,
    Type.Object({
      messages: Type.Array(Type.Object({ entryId: s(), text: s() })),
    }),
  ),
  command(
    "get_last_assistant_text",
    `Usage: Read the latest assistant text.
Inputs: No arguments.
Invariants: Text is omitted when there is no assistant text.
Effects: Reads the current transcript without modifying it.
Recovery: Refresh after the transcript changes.`,
    empty,
    Type.Object({ text: opt(s()) }),
  ),
  command(
    "set_session_name",
    `Usage: Set the session title.
Inputs: Supply name; surrounding whitespace is trimmed.
Invariants: The title belongs to the current session.
Effects: Changes the session name.
Recovery: Read current state after uncertainty before reapplying.`,
    Type.Object({ name: s() }),
    none,
  ),
  command(
    "set_label",
    `Usage: Set or clear an entry label.
Inputs: Supply entryId; omit label to clear it.
Invariants: The entry belongs to the current session tree.
Effects: Changes the entry's label.
Recovery: Read the tree after uncertainty before reapplying.`,
    Type.Object({ ...entryId, label: opt(s()) }),
    none,
  ),
  command(
    "export_html",
    `Usage: Export the transcript to HTML.
Inputs: outputPath may be omitted to use the default.
Invariants: The result returns the output path.
Effects: Writes an HTML file to disk.
Recovery: Inspect the output path after uncertainty before exporting again.`,
    Type.Object({ outputPath: opt(s()) }),
    Type.Object({ path: s() }),
  ),
  command(
    "get_session_lease",
    `Usage: Probe session lease ownership.
Inputs: Supply sessionIds.
Invariants: Held and unknown are separate classifications; unknown is not proof of an available lease.
Effects: Reads lease state without taking a lease.
Recovery: Probe again when unknown ownership can be resolved.`,
    Type.Object({ sessionIds: Type.Array(s()) }),
    Type.Object({ held: Type.Array(s()), unknown: Type.Array(s()) }),
  ),
];

/** This group registers no inbound non-command frames. */
export const lifecycleRunnerFrames: readonly TSchema[] = [];

/** Unsolicited runner frames emitted by lifecycle handlers and headless extension reporting. */
export const lifecycleRunnerEvents: readonly TSchema[] = [
  Type.Object(
    {
      t: Type.Literal("prompt_error"),
      id: opt(n()),
      command: literals("prompt", "steer", "follow_up", "abort_and_prompt"),
      error: s(),
    },
    { title: "RunnerPromptError" },
  ),
  Type.Object(
    {
      t: Type.Literal("prompt_result"),
      id: opt(n()),
      agentInvoked: b(),
      status: literals("completed", "aborted", "error"),
      sessionSettled: b(),
      error: opt(
        Type.Object({
          message: s(),
          provider: opt(s()),
          model: opt(s()),
          httpStatus: opt(n()),
          retryable: b(),
          code: opt(Type.Literal("cost_cap")),
        }),
      ),
    },
    { title: "RunnerPromptResult" },
  ),
  Type.Object(
    { t: Type.Literal("available_commands_update"), commands: slashCommands },
    { title: "RunnerAvailableCommandsUpdate" },
  ),
  Type.Object(
    { t: Type.Literal("command_output"), text: s() },
    { title: "RunnerCommandOutput" },
  ),
  Type.Object(
    { t: Type.Literal("session_info_update"), title: opt(s()), sessionId: s() },
    { title: "RunnerSessionInfoUpdate" },
  ),
  Type.Object(
    {
      t: Type.Literal("config_update"),
      model: opt(OmpModelSchema),
      thinkingLevel: opt(s()),
    },
    { title: "RunnerConfigUpdate" },
  ),
  Type.Object(
    { t: Type.Literal("bash_output"), id: opt(n()), chunk: s() },
    { title: "RunnerBashOutput" },
  ),
  Type.Object(
    {
      t: Type.Literal("session"),
      sessionId: s(),
      sessionFile: opt(s()),
      cwd: s(),
    },
    { title: "RunnerSessionIdentity" },
  ),
  Type.Object(
    {
      t: Type.Literal("extension_error"),
      action: opt(s()),
      extensionPath: opt(s()),
      event: opt(s()),
      error: s(),
    },
    { title: "RunnerExtensionError" },
  ),
];
