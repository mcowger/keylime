import type { Static } from "@sinclair/typebox";
import type {
  ContextUsageSchema,
  UsageLimitStateSchema,
  SlowModeScopeSchema,
  ModelLikeSchema,
  ToolInfoSchema,
  OmpModelSchema,
  TodoItemSchema,
  TodoPhaseSchema,
  QueuedMessagesSchema,
  ClientMessageStatusSchema,
  RpcSessionStateSchema,
  WebSessionStateSchema,
  AvailableSlashCommandSourceSchema,
  RpcAvailableSlashCommandSchema,
  BashResultInfoSchema,
  GenerationSpeedInfoSchema,
  SessionStatsInfoSchema,
  RpcAskDialogQuestionSchema,
  RpcAskDialogAnswerSchema,
  HtmlFormDataSchema,
  HostToolParameterSchema,
  HostToolDefinitionSchema,
  HostToolCallFrameSchema,
  HostToolCancelFrameSchema,
  HostToolResultFrameSchema,
  HostUriSchemeDefinitionSchema,
  HostUriOperationSchema,
  HostUriRequestFrameSchema,
  HostUriCancelFrameSchema,
  HostUriResultFrameSchema,
} from "./api-contracts/domain";
// Local mirrors of the omp shapes used by omp-web. omp's SDK packages are
// Bun-only, so these types are hand-maintained against
// oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts (protocol v1).

/** Estimated context occupancy; null tokens or percentage mean unavailable, not zero usage. */
export type ContextUsage = Static<typeof ContextUsageSchema>;

/** Provider limit state; reset timestamps, when present, are Unix seconds. */
export type UsageLimitState = Static<typeof UsageLimitStateSchema>;

export type SlowModeScope = Static<typeof SlowModeScopeSchema>;

export type ModelLike = Static<typeof ModelLikeSchema>;

export type ToolInfo = Static<typeof ToolInfoSchema>;

/** Subset of omp's Model (pi-ai) that the web UI reads; extra fields pass through. */
export type OmpModel = Static<typeof OmpModelSchema>;

export type TodoItem = Static<typeof TodoItemSchema>;

export type TodoPhase = Static<typeof TodoPhaseSchema>;

/** Native runner queue snapshot, separate from intents still held by the web outbox. */
export type QueuedMessages = Static<typeof QueuedMessagesSchema>;

/** Native correlation evidence; a null queue means its snapshot exceeded the response budget. */
export type ClientMessageStatus = Static<typeof ClientMessageStatusSchema>;

/** Mirror of omp's RpcSessionState (the raw `get_state` payload). */
export type RpcSessionState = Static<typeof RpcSessionStateSchema>;

/**
 * The state shape omp-web's own API returns to the browser
 * (AgentSessionWrapper adapts RpcSessionState and adds process-side flags).
 */
export type WebSessionState = Static<typeof WebSessionStateSchema>;

export type AvailableSlashCommandSource = Static<
  typeof AvailableSlashCommandSourceSchema
>;

/** Mirror of omp's RpcAvailableSlashCommand (`get_available_commands`). */
export type RpcAvailableSlashCommand = Static<
  typeof RpcAvailableSlashCommandSchema
>;

/** Mirror of omp's BashResult (`bash` command response). */
export type BashResultInfo = Static<typeof BashResultInfoSchema>;

/** Current and average generation throughput; null means no measurement is available. */
export type GenerationSpeedInfo = Static<typeof GenerationSpeedInfoSchema>;

/** Session counters and reported usage/cost, optionally including context occupancy estimates. */
export type SessionStatsInfo = Static<typeof SessionStatsInfoSchema>;

/** One question of omp's ask dialog (`method: "ask"`, omp's `askDialog`). */
export type RpcAskDialogQuestion = Static<typeof RpcAskDialogQuestionSchema>;

/** Per-question answer, sent back in question order. */
export type RpcAskDialogAnswer = Static<typeof RpcAskDialogAnswerSchema>;

/**
 * A submitted whole-form ask (omp's `formDialog`), by control `name`: radios, single checkboxes and
 * single selects give their value (omitted when nothing is chosen), checkbox groups and multi-selects
 * an array, `number`/`range` inputs a number, other text fields their text. Mirrors pi-tui's html-form.
 */
export type HtmlFormData = Static<typeof HtmlFormDataSchema>;

/**
 * omp's RPC host-tool bridge: omp-web registers host tools (set_host_tools)
 * that the agent can call; the server emits host_tool_call frames the UI
 * executes, and the UI answers with host_tool_result. Mirrors
 * oh-my-pi modes/rpc/rpc-types.ts.
 */
export type HostToolParameter = Static<typeof HostToolParameterSchema>;

export type HostToolDefinition = Static<typeof HostToolDefinitionSchema>;

export type HostToolCallFrame = Static<typeof HostToolCallFrameSchema>;

export type HostToolCancelFrame = Static<typeof HostToolCancelFrameSchema>;

export type HostToolResultFrame = Static<typeof HostToolResultFrameSchema>;

/**
 * omp's RPC host-URI bridge: the host registers URL schemes
 * (set_host_uri_schemes) that the agent's read/write tools resolve through
 * the UI; the server emits host_uri_request frames the UI satisfies with
 * host_uri_result. Mirrors oh-my-pi modes/rpc/rpc-types.ts.
 */
export type HostUriSchemeDefinition = Static<
  typeof HostUriSchemeDefinitionSchema
>;

export type HostUriOperation = Static<typeof HostUriOperationSchema>;

export type HostUriRequestFrame = Static<typeof HostUriRequestFrameSchema>;

export type HostUriCancelFrame = Static<typeof HostUriCancelFrameSchema>;

export type HostUriResultFrame = Static<typeof HostUriResultFrameSchema>;
