import { Type, type TSchema } from "@sinclair/typebox";
import {
  BashResultInfoSchema,
  ClientMessageStatusSchema,
  HostToolResultFrameSchema,
  HostUriResultFrameSchema,
  OutboxEntrySchema,
  OutboxModeSchema,
  RpcAvailableSlashCommandSchema,
  SessionStatsInfoSchema,
  UiDialogValueSchema,
  WebSessionStateSchema,
} from "./domain";
import {
  SetHostToolsArgsSchema,
  SetHostUriSchemesArgsSchema,
  SetSubagentSubscriptionArgsSchema,
} from "./runner-tools";
import { lifecycleRunnerOperations } from "./runner-lifecycle";
import type { OperationContract } from "./operations";

const empty = Type.Object({});
/** Installation/sign-in scope used to bind durable browser outbox entries. */
export const OutboxScopeResultSchema = Type.Object(
  {
    scope: Type.String({
      description:
        "Nonsecret scope identifying the current installation and sign-in.",
    }),
  },
  { description: "Current scope for binding outbox entries." },
);
const nil = Type.Null();
const id = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9_-]+$",
});
const attachments = Type.Object({
  uploads: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Completed upload IDs attached before the native command is sent.",
    }),
  ),
  uploadProofs: Type.Optional(
    Type.Record(
      Type.String(),
      Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
      {
        description:
          "Private upload completion proofs keyed by upload ID; never forwarded to the runner.",
      },
    ),
  ),
});
const outboxImage = Type.Object({
  type: Type.Literal("image"),
  data: Type.String(),
  mimeType: Type.String(),
});
const receiptEntry = Type.Composite([
  OutboxEntrySchema,
  Type.Object({ replaces: Type.Optional(id) }),
]);
const native = (name: string): OperationContract => {
  const operation = lifecycleRunnerOperations.find(
    (item) => item.name === name,
  );
  if (!operation) throw new Error(`Missing runner contract: ${name}`);
  return operation;
};
const override = (
  name: string,
  description: string,
  result: TSchema,
  args?: TSchema,
): OperationContract => ({
  name,
  description: `${native(name).description}\n\nBrowser: ${description} Where the native operation returns undefined, the browser wrapper returns null.`,
  args: args ?? native(name).args,
  result,
});
const queued = Type.Object({
  queued: Type.Literal(true),
  queue: Type.Literal("followUp"),
  reason: Type.Literal("shellRunning"),
});
const withAttachments = (name: string) =>
  Type.Intersect([native(name).args, attachments]);

/** Exact union of AgentSessionWrapper's passthrough set and dispatch cases.
 * `navigate_tree`, `clear_queue`, `get_tools`, and `set_tools` are rejected as unsupported;
 * other native-only operations are excluded because the wrapper does not dispatch them.
 * Outbox commands are intercepted earlier by runAgentCommand, and ensure_session only by the new-session route.
 */
export const browserAgentCommandNames: readonly string[] = [
  "abort",
  "abort_and_prompt",
  "set_thinking_level",
  "cycle_thinking_level",
  "cycle_model",
  "get_available_models",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "abort_bash",
  "set_todos",
  "set_steering_mode",
  "set_follow_up_mode",
  "set_interrupt_mode",
  "get_branch_messages",
  "get_messages",
  "get_messages_page",
  "export_html",
  "handoff",
  "get_subagents",
  "get_subagent_messages",
  "set_subagent_subscription",
  "get_login_providers",
  "login",
  "predict_word",
  "commit_plan",
  "commit_apply",
  "generate_pr_description",
  "predict_word_feedback",
  "btw",
  "btw_cancel",
  "get_btw_history",
  "get_jobs",
  "get_job_output",
  "cancel_job",
  "get_client_message_status",
  "prompt",
  "steer",
  "follow_up",
  "remove_queued_message",
  "promote_queued_message",
  "abort_and_restore_queue",
  "get_state",
  "set_model",
  "set_fast_mode",
  "set_slow_mode",
  "edit_message",
  "fork",
  "new_session",
  "switch_session",
  "compact",
  "abort_compaction",
  "set_session_name",
  "get_session_stats",
  "get_last_assistant_text",
  "get_commands",
  "reload",
  "ui_response",
  "ui_input",
  "bash",
  "set_host_tools",
  "host_tool_result",
  "set_host_uri_schemes",
  "host_uri_result",
];

/** Browser command args omit the `type` discriminator; replies are the `data` inside the HTTP success envelope. */
export const webAgentOperations: readonly OperationContract[] = [
  {
    name: "ensure_session",
    description: `Usage: Initialize the selected workspace session through POST /api/agent/new, without a prompt.
Inputs: Workspace, host, model, tool and session options are optional.
Invariants: This command is intercepted by the new-session route; its result is null and the route wraps session identity.
Effects: Starts the selected session process when necessary.
Recovery: Inspect the returned session identity after an uncertain request before initializing again.`,
    args: Type.Object({
      cwd: Type.Optional(Type.String()),
      hostId: Type.Optional(Type.String()),
      workspaceId: Type.Optional(Type.String()),
      projectId: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      modelId: Type.Optional(Type.String()),
      toolNames: Type.Optional(Type.Array(Type.String())),
      thinkingLevel: Type.Optional(Type.String()),
      advisor: Type.Optional(Type.Boolean()),
      name: Type.Optional(Type.String()),
    }),
    result: nil,
  },
  {
    name: "outbox_scope",
    description: `Usage: Obtain the scope for a durable outbox entry.
Inputs: No arguments.
Invariants: The scope is nonsecret and binds entries to the installation and sign-in.
Effects: Reads the current scope without dispatching input.
Recovery: Refresh the scope after a sign-in change before adding entries.`,
    args: empty,
    result: OutboxScopeResultSchema,
  },
  {
    name: "outbox_add",
    description: `Usage: Durably accept a held outbox message, independently of its eventual delivery.
Inputs: Supply id and scope; first insertion also requires mode and message. Images and completed uploads are optional; replaces identifies an earlier entry.
Invariants: Reusing an existing id returns its stored payload. Replacing a failed or delivered entry requires the same original payload; pending originals cannot be replaced. Scope, upload, size and capacity checks can reject the request.
Effects: Stores an entry for later delivery; acceptance does not mean the runner has admitted or completed a prompt.
Recovery: Retry an uncertain insertion with the same id and scope to recover its receipt; resolve scope or payload conflicts rather than changing the original intent.`,
    args: Type.Composite([
      attachments,
      Type.Object({
        id,
        scope: Type.String(),
        mode: Type.Optional(OutboxModeSchema),
        message: Type.Optional(Type.String()),
        images: Type.Optional(Type.Array(outboxImage)),
        replaces: Type.Optional(id),
      }),
    ]),
    result: Type.Object({ entry: receiptEntry }),
  },
  {
    name: "outbox_remove",
    description: `Usage: Retire an undelivered outbox entry.
Inputs: Supply its id.
Invariants: An entry already delivering cannot be removed and fails with outbox_dispatched.
Effects: Removes an eligible held entry; this does not cancel an already dispatched prompt.
Recovery: Inspect the outbox and delivery status after an uncertain response.`,
    args: Type.Object({ id }),
    result: Type.Union([
      Type.Object({ removed: Type.Literal(false) }),
      Type.Object({ removed: Type.Literal(true), entry: OutboxEntrySchema }),
    ]),
  },
  {
    name: "get_client_message_status",
    description: `${native("get_client_message_status").description}\n\nBrowser: Reconciliation does not start a child; a missing child or uncertain host fails instead of guessing acceptance.`,
    args: Type.Object({
      clientMessageIds: Type.Array(
        Type.String({ minLength: 1, maxLength: 128 }),
        { minItems: 1, maxItems: 32, uniqueItems: true },
      ),
    }),
    result: ClientMessageStatusSchema,
  },
  override(
    "prompt",
    "Submit a prompt; while a shell is running it is queued as follow-up. Local slash commands may report agentInvoked:false.",
    Type.Union([
      nil,
      Type.Object({ agentInvoked: Type.Literal(false) }),
      queued,
    ]),
    withAttachments("prompt"),
  ),
  override(
    "steer",
    "Steer a live run; while a shell is running it is queued as follow-up.",
    Type.Union([nil, queued]),
    withAttachments("steer"),
  ),
  override(
    "follow_up",
    "Queue a follow-up message.",
    nil,
    withAttachments("follow_up"),
  ),
  override(
    "abort_and_prompt",
    "Abort the current turn and submit a new prompt.",
    nil,
    withAttachments("abort_and_prompt"),
  ),
  override("abort", "Abort the current turn.", nil),
  override(
    "get_state",
    "Read browser state, including wrapper activity and extension UI state. Optional hostId selects the host for this session; a live wrapper on another host is refused. The routing hint is not sent to the runner.",
    WebSessionStateSchema,
    Type.Object({ hostId: Type.Optional(Type.String({ minLength: 1, description: "Host holding the session to resume." })) }),
  ),
  override(
    "set_model",
    "Select the model; the browser receives its id and provider.",
    Type.Object({ id: Type.String(), provider: Type.String() }),
  ),
  override(
    "set_fast_mode",
    "Enable or disable fast mode; the wrapper reports effective and active state.",
    Type.Object({ enabled: Type.Boolean(), active: Type.Boolean() }),
  ),
  override(
    "set_slow_mode",
    "Enable or disable slow mode; the wrapper reports effective state.",
    Type.Object({ enabled: Type.Boolean() }),
  ),
  override(
    "edit_message",
    "Move the history leaf before a user message; fails with invalid_edit_target, session_busy, session_changed or session_edit_unsupported when preflight cannot safely edit.",
    Type.Object({
      sessionId: Type.String(),
      cancelled: Type.Boolean(),
      leafId: Type.Union([Type.String(), nil]),
    }),
  ),
  override(
    "fork",
    "Branch at a user message and switch this process to the new session.",
    Type.Union([
      Type.Object({ cancelled: Type.Literal(true) }),
      Type.Object({
        cancelled: Type.Literal(false),
        newSessionId: Type.String(),
        text: Type.String(),
      }),
    ]),
    Type.Object({ entryId: Type.String() }),
  ),
  ...["new_session", "switch_session"].map((name) =>
    override(
      name,
      "Switch the runner session and return its refreshed identity when not cancelled.",
      Type.Union([
        Type.Object({ cancelled: Type.Literal(true) }),
        Type.Object({
          cancelled: Type.Literal(false),
          newSessionId: Type.String(),
        }),
      ]),
    ),
  ),
  override(
    "abort_compaction",
    "Abort in-flight compaction through the runner abort operation.",
    nil,
  ),
  override("set_session_name", "Set and cache the trimmed session name.", nil),
  override(
    "get_session_stats",
    "Read session statistics with the wrapper's current session name.",
    SessionStatsInfoSchema,
  ),
  override(
    "get_last_assistant_text",
    "Read the latest assistant text, defaulting to an empty string.",
    Type.Object({ text: Type.String() }),
  ),
  {
    name: "get_commands",
    description: `${native("get_available_commands").description}\n\nBrowser: Dispatches the runner's get_available_commands operation.`,
    args: empty,
    result: Type.Object({
      commands: Type.Array(RpcAvailableSlashCommandSchema),
    }),
  },
  {
    name: "reload",
    description: `Usage: Restart the session process.
Inputs: No arguments.
Invariants: A successful response reports that restart was requested, not that an interrupted prompt completed.
Effects: Replaces the process and its in-memory state.
Recovery: Refresh session state and reconcile outstanding input after restart.`,
    args: empty,
    result: Type.Object({ success: Type.Literal(true) }),
  },
  {
    name: "ui_response",
    description: `Usage: Answer a pending runner dialog or server confirmation.
Inputs: Supply the dialog id and optional answer value.
Invariants: Invalid ids or answers fail with invalid_ui_response.
Effects: Resolves the matching pending interaction.
Recovery: Refresh pending UI state after uncertainty; an already resolved dialog is not a new request.`,
    args: Type.Object({
      id: Type.Union([Type.String(), Type.Number()]),
      value: Type.Optional(UiDialogValueSchema),
    }),
    result: nil,
  },
  {
    name: "ui_input",
    description: `Usage: Send keyboard input to a custom extension UI component.
Inputs: Supply its numeric id and input data.
Invariants: Input targets the currently active component identified by id.
Effects: Forwards input to the extension UI.
Recovery: Refresh UI state after a disconnect before sending further input.`,
    args: Type.Object({ id: Type.Number(), data: Type.String() }),
    result: nil,
  },
  override(
    "bash",
    "Execute a shell command; deferred indicates the result was held for the next prompt.",
    BashResultInfoSchema,
  ),
  {
    name: "set_host_tools",
    description: `Usage: Register host-provided tools for the session.
Inputs: Supply the host tool definitions.
Invariants: Definitions are merged with enabled web-server tools.
Effects: Changes the tools exposed to the runner.
Recovery: Re-register host tools when the owning host reconnects.`,
    args: SetHostToolsArgsSchema,
    result: nil,
  },
  {
    name: "set_subagent_subscription",
    description: `Usage: Subscribe to subagent updates.
Inputs: Supply the desired subscription level.
Invariants: The result is null when the host owns subscription lifecycle; otherwise it reports the level.
Effects: Changes update subscription state.
Recovery: Restore the desired subscription after reconnecting.`,
    args: SetSubagentSubscriptionArgsSchema,
    result: Type.Union([
      nil,
      Type.Object({
        level: SetSubagentSubscriptionArgsSchema.properties.level,
      }),
    ]),
  },
  {
    name: "set_host_uri_schemes",
    description: `Usage: Register host URI schemes.
Inputs: Supply the schemes supported by the host.
Invariants: Registration describes host capabilities, not URI operation results.
Effects: Updates schemes available to the runner.
Recovery: Re-register capabilities after the host reconnects.`,
    args: SetHostUriSchemesArgsSchema,
    result: nil,
  },
  {
    name: "host_tool_result",
    description: `Usage: Return a result for a pending host tool call.
Inputs: Supply the result frame fields without the type discriminator.
Invariants: The result belongs to the corresponding host tool invocation.
Effects: Forwards the result to the runner.
Recovery: Reconcile pending calls after a disconnect rather than inventing a result.`,
    args: Type.Omit(HostToolResultFrameSchema, ["type"]),
    result: nil,
  },
  {
    name: "host_uri_result",
    description: `Usage: Return a result for a pending host URI operation.
Inputs: Supply the result frame fields without the type discriminator.
Invariants: The result belongs to the corresponding URI request.
Effects: Forwards the result to the runner.
Recovery: Reconcile pending requests after a disconnect rather than inventing a result.`,
    args: Type.Omit(HostUriResultFrameSchema, ["type"]),
    result: nil,
  },
];
