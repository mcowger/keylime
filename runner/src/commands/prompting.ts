/**
 * User input and what steers it: prompts, the steering/follow-up queue, aborts, queue modes,
 * handoff, goal mode, todos and `!` bash. Prompt outcomes are `../prompt-results`, goal mode `../goal`.
 *
 * Unsolicited frames (omp → host):
 *   {t:"prompt_result", id, agentInvoked, status, error?, sessionSettled}
 *       once per accepted `prompt`/`abort_and_prompt` (`id` = its cmd id), after its work yields
 *   {t:"prompt_error", id, command, error}      a prompt failed after its cmd was answered
 *   {t:"bash_output", id, chunk}                output of the running `bash` cmd `id`
 *   {t:"command_output", text}                  a builtin slash command's output
 *   {t:"available_commands_update", commands}   a builtin changed the slash command list
 *   {t:"session_info_update", title, sessionId} a builtin renamed the session
 *   {t:"config_update", model, thinkingLevel}   a builtin changed model or thinking level
 */
import {
  clearPluginRootsAndCaches,
  resolveActiveProjectRegistryPath,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
  loadSkillPrompt,
  parseSkillInvocation,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  SKILL_PROMPT_MESSAGE_TYPE,
  USER_INTERRUPT_LABEL,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { logger } from "@oh-my-pi/pi-utils";
import {
  type ClientMessageClaim,
  claimClientMessage,
  submitCorrelated,
} from "../correlation";
import { checkSettled, scheduledTurnProbe } from "../events";
import { GOAL_OPS, GoalController } from "../goal";
import {
  PromptResults,
  type PromptTicket,
  reportPromptResult,
} from "../prompt-results";
import type { CommandContext, CommandTable, FrameTable } from "./types";

type ImageContent = NonNullable<Parameters<AgentSession["steer"]>[1]>[number];
type TodoPhase = Parameters<AgentSession["commitTodoPhases"]>[0][number];
type StreamingBehavior = "steer" | "followUp";
type InputOutcome = "local" | "cancelled" | "admitted" | "builtin-agent";

interface UserInput {
  op: "prompt" | "steer" | "follow_up" | "abort_and_prompt";
  id: number | undefined;
  message: string;
  images: ImageContent[] | undefined;
  streamingBehavior: StreamingBehavior | undefined;
  /** Accept order; an abort or session change accepted later voids input not yet dispatched. */
  sequence: number;
  ticket?: PromptTicket;
  claim?: ClientMessageClaim;
}

/** Per-session prompting state: prompt results, goal mode, and the ordered user-input gate. */
export class Prompting {
  readonly results: PromptResults;
  readonly goals: GoalController;
  /** Builtin commands whose work outlives the prompt (`/mcp reauth`); aborts tear them down. */
  readonly builtinAborts = new Set<AbortController>();
  #tail: Promise<void> = Promise.resolve();
  #sequence = 0;
  #validFrom = 0;

  constructor(session: AgentSession, send: CommandContext["send"]) {
    this.goals = new GoalController(session, () => checkSettled(session));
    this.results = new PromptResults(
      session,
      send,
      scheduledTurnProbe(session, () => this.goals.continuationPending),
      () => checkSettled(session),
    );
    session.subscribe((event) => {
      // Goal first: a continuation decided at this agent_end is pending before results read settlement.
      this.goals.observe(event);
      this.results.observe(event);
    });
  }

  /** Take an accept-order slot; call synchronously when the command arrives. */
  accept(): number {
    return ++this.#sequence;
  }

  /** Void user input accepted before `sequence` (an abort, or a session change that succeeded). */
  invalidateBefore(sequence: number): void {
    if (sequence > this.#validFrom) this.#validFrom = sequence;
  }

  isCurrent(sequence: number): boolean {
    return sequence >= this.#validFrom;
  }

  /** Run user-input work in accept order; the tail releases when `work` settles, not when a turn ends. */
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  abortBuiltins(reason: string): void {
    for (const controller of this.builtinAborts) controller.abort(reason);
    this.builtinAborts.clear();
  }
}

const states = new WeakMap<AgentSession, Prompting>();

/** The session's prompting state; session changes use it to void input and close open prompts. */
export function prompting({ session, send }: CommandContext): Prompting {
  let state = states.get(session);
  if (!state) {
    state = new Prompting(session, send);
    states.set(session, state);
  }
  return state;
}

function isImage(value: unknown): value is ImageContent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "image" &&
    "data" in value &&
    typeof value.data === "string" &&
    "mimeType" in value &&
    typeof value.mimeType === "string"
  );
}

function isTodoPhase(value: unknown): value is TodoPhase {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "tasks" in value &&
    Array.isArray(value.tasks) &&
    value.tasks.every(
      (task: unknown) =>
        typeof task === "object" &&
        task !== null &&
        "content" in task &&
        typeof task.content === "string" &&
        "status" in task &&
        (task.status === "pending" ||
          task.status === "in_progress" ||
          task.status === "completed" ||
          task.status === "abandoned"),
    )
  );
}

/** Read the fields every user-input command shares; throws before anything is accepted. */
function readInput(
  ctx: CommandContext,
  op: UserInput["op"],
  args: Record<string, unknown>,
): UserInput {
  if (typeof args.message !== "string")
    throw new Error(`${op}: message must be a string`);
  const images = args.images;
  if (
    images !== undefined &&
    !(Array.isArray(images) && images.every(isImage))
  ) {
    throw new Error(
      `${op}: images must be an array of {type:"image", data, mimeType}`,
    );
  }
  const streamingBehavior =
    op === "prompt" ? args.streamingBehavior : undefined;
  if (
    streamingBehavior !== undefined &&
    streamingBehavior !== "steer" &&
    streamingBehavior !== "followUp"
  ) {
    throw new Error(`${op}: streamingBehavior must be "steer" or "followUp"`);
  }
  // Throws on a malformed or reused id, before the input takes a slot.
  const claim = claimClientMessage(ctx.session, args.clientMessageId);
  const state = prompting(ctx);
  const sequence = state.accept();
  // abort_and_prompt is itself an abort: it voids input accepted before it.
  if (op === "abort_and_prompt") state.invalidateBefore(sequence);
  return {
    op,
    id: ctx.id,
    message: args.message,
    images,
    streamingBehavior,
    sequence,
    claim,
  };
}

/** @apiEvent prompt_error */
const onPromptError =
  (ctx: CommandContext, input: UserInput) => (error: Error) =>
    ctx.send({
      t: "prompt_error",
      id: input.id,
      command: input.op,
      error: error.message,
    });

/**
 * RPC's `dispatchOrderedUserInput`: input hooks, then skills and builtins (`prompt` only), then the
 * agent. A `clientMessageId` claim is journaled as resolved when the input never reaches the agent
 * and freed when it is cancelled or fails; an admitted one is settled by `submitCorrelated`.
 */
function dispatchInput(
  ctx: CommandContext,
  input: UserInput,
): Promise<InputOutcome> {
  const { session } = ctx;
  const state = prompting(ctx);
  const run = state.enqueue(async (): Promise<InputOutcome> => {
    const sessionId = session.sessionId;
    const isCurrent = () =>
      state.isCurrent(input.sequence) && session.sessionId === sessionId;
    if (!isCurrent()) return "cancelled";
    let text = input.message;
    let images = input.images;
    const runner = session.extensionRunner;
    if (runner?.hasHandlers("input")) {
      const result = await runner.emitInput(text, images, "rpc");
      if (!isCurrent()) return "cancelled";
      if (result.handled) return "local";
      if (result.text !== undefined) text = result.text;
      if (result.images !== undefined) images = result.images;
    }
    if (!text.trim() && !images?.length) return "local";
    if (input.op === "steer") {
      await submitCorrelated(input.claim, undefined, (hooks) =>
        session.steer(text, images, hooks),
      );
      return "admitted";
    }
    if (input.op === "follow_up") {
      await submitCorrelated(input.claim, undefined, (hooks) =>
        session.followUp(text, images, hooks),
      );
      return "admitted";
    }
    const ticket = input.ticket;
    if (!ticket) return "cancelled";
    const report = (
      startPrompt: (onPromptAdmitted: () => void) => Promise<boolean>,
    ) =>
      reportPromptResult(
        ticket,
        state.results,
        onPromptError(ctx, input),
        startPrompt,
      );
    if (input.op === "prompt") {
      const parsed = session.skillsSettings?.enableSkillCommands
        ? parseSkillInvocation(text)
        : undefined;
      const skill =
        parsed &&
        session.skills.find((candidate) => candidate.name === parsed.name);
      if (parsed && skill) {
        // Read the skill before answering so a missing SKILL.md fails the command itself.
        const loaded = await loadSkillPrompt(skill, session);
        if (!isCurrent()) return "cancelled";
        const built = session.renderUserSkillPrompt(
          loaded.skill,
          parsed,
          loaded.body,
        );
        const content = images?.length
          ? [{ type: "text" as const, text: built.message }, ...images]
          : built.message;
        await report((onPromptAdmitted) =>
          submitCorrelated(input.claim, onPromptAdmitted, (hooks) =>
            session.promptCustomMessage(
              {
                customType: SKILL_PROMPT_MESSAGE_TYPE,
                content,
                display: true,
                details: built.details,
                attribution: "user",
              },
              {
                streamingBehavior: input.streamingBehavior ?? "steer",
                queueChipText: text,
                ...hooks,
              },
            ),
          ),
        );
        return "admitted";
      }
      const builtin = await runBuiltin(ctx, state, text);
      if (!isCurrent()) return "cancelled";
      if (builtin !== false) {
        if (!("prompt" in builtin)) {
          if (builtin.agentInvoked !== true) return "local";
          void session.waitForIdle().then(
            () => state.results.settle(ticket),
            (error: unknown) =>
              state.results.fail(
                ticket,
                error instanceof Error ? error.message : String(error),
              ),
          );
          return "builtin-agent";
        }
        text = builtin.prompt;
      }
    }
    if (!isCurrent()) return "cancelled";
    await report((onPromptAdmitted) =>
      submitCorrelated(
        input.claim,
        onPromptAdmitted,
        (hooks) =>
          session.prompt(text, {
            images,
            streamingBehavior: input.streamingBehavior,
            userInitiated: true,
            ...hooks,
          }),
        // prompt() resolving false means the input was handled locally.
        true,
      ),
    );
    return "admitted";
  });
  return run.then(
    (outcome) => {
      if (outcome === "local" || outcome === "builtin-agent")
        input.claim?.consumed();
      else if (outcome === "cancelled") input.claim?.release();
      return outcome;
    },
    (error: unknown) => {
      input.claim?.release();
      throw error;
    },
  );
}

/** A builtin slash command (`/compact`, `/model`, …) as RPC runs them; `false` when `text` is not one. */
async function runBuiltin(ctx: CommandContext, state: Prompting, text: string) {
  const { session, send } = ctx;
  const refreshCommands = async () => {
    /** @apiEvent available_commands_update */
    send({
      t: "available_commands_update",
      commands: await buildAvailableSlashCommands(session),
    });
  };
  const abort = new AbortController();
  state.builtinAborts.add(abort);
  let backgrounded = false;
  try {
    return await executeAcpBuiltinSlashCommand(text, {
      session,
      sessionManager: session.sessionManager,
      settings: session.settings,
      cwd: session.sessionManager.getCwd(),
      signal: abort.signal,
      /** @apiEvent command_output */
      output: (text) => send({ t: "command_output", text }),
      refreshCommands,
      reloadPlugins: async () => {
        const projectPath = await resolveActiveProjectRegistryPath(
          session.sessionManager.getCwd(),
        );
        clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
        await session.refreshSkillsAndCommands();
        await refreshCommands();
      },
      runCommandInBackground: (task) => {
        backgrounded = true;
        void task()
          .catch((error: unknown) =>
            logger.warn("keylime: background slash command failed", {
              error: String(error),
            }),
          )
          .finally(() => state.builtinAborts.delete(abort));
      },
      /** @apiEvent session_info_update */
      notifyTitleChanged: () =>
        send({
          t: "session_info_update",
          title: session.sessionName,
          sessionId: session.sessionId,
        }),
      /** @apiEvent config_update */
      notifyConfigChanged: () =>
        send({
          t: "config_update",
          model: session.model,
          thinkingLevel: session.thinkingLevel,
        }),
    });
  } finally {
    if (!backgrounded) state.builtinAborts.delete(abort);
  }
}

/** What RPC's `abort` does before aborting: stop goal continuation and builtin work, void queued input. */
function stopForAbort(ctx: CommandContext): void {
  const state = prompting(ctx);
  state.invalidateBefore(state.accept());
  state.goals.stopForHostAbort();
  state.abortBuiltins("Command aborted by host");
}

function readQueueMode(op: string, mode: unknown): "all" | "one-at-a-time" {
  if (mode !== "all" && mode !== "one-at-a-time")
    throw new Error(`${op}: mode must be "all" or "one-at-a-time"`);
  return mode;
}

export const promptingCommands: CommandTable = {
  /** @apiCommand prompt
   * The response fences admission, not completion. A local builtin can finish without an agent turn;
   * prompt_result and settled state are separate observations. Correlated IDs are session-scoped. */
  async prompt(ctx, args) {
    const input = readInput(ctx, "prompt", args);
    const { results } = prompting(ctx);
    // Taken before dispatch so a builtin that schedules a turn (`/retry`) cannot run ahead of it.
    const ticket = results.begin(input.id);
    input.ticket = ticket;
    try {
      // Answered after admission, so a queue edit sent after the answer finds the message.
      const outcome = await dispatchInput(ctx, input);
      if (outcome === "local") {
        results.discard(ticket);
        return { agentInvoked: false };
      }
      if (outcome === "builtin-agent") return { agentInvoked: true };
      if (outcome === "cancelled") results.settle(ticket);
      return undefined;
    } catch (error) {
      results.discard(ticket);
      throw error;
    }
  },
  /** @apiCommand steer
   * Ordered input admission makes a successful reply a fence for subsequent queue edits, not a turn result. */
  async steer(ctx, args) {
    await dispatchInput(ctx, readInput(ctx, "steer", args));
    return undefined;
  },
  /** @apiCommand follow_up */
  async follow_up(ctx, args) {
    await dispatchInput(ctx, readInput(ctx, "follow_up", args));
    return undefined;
  },
  /** @apiCommand remove_queued_message */
  async remove_queued_message({ session }, args) {
    if (typeof args.message !== "string")
      throw new Error("remove_queued_message: message must be a string");
    if (args.queue !== "steering" && args.queue !== "followUp") {
      throw new Error(
        'remove_queued_message: queue must be "steering" or "followUp"',
      );
    }
    const removed = session.takeQueuedMessage(args.message, args.queue);
    // RPC drops images past its frame limit; the channel has none.
    return removed?.images
      ? { removed: true, images: removed.images }
      : { removed: removed !== undefined };
  },
  /** @apiCommand promote_queued_message */
  async promote_queued_message({ session }, args) {
    if (typeof args.message !== "string")
      throw new Error("promote_queued_message: message must be a string");
    return { promoted: session.promoteQueuedMessage(args.message) };
  },
  /** @apiCommand abort */
  async abort(ctx) {
    stopForAbort(ctx);
    await ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
    return undefined;
  },
  /** @apiCommand abort_and_restore_queue */
  async abort_and_restore_queue(ctx) {
    // The TUI's Esc restore: withdraw queued user input (including input the run dequeued but never
    // recorded) before aborting, so neither the aborted turn nor abort()'s queue drain runs it.
    const restored = ctx.session.clearQueue({ forInterrupt: true });
    stopForAbort(ctx);
    await ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
    return restored;
  },
  /** @apiCommand abort_and_prompt
   * The replacement is dispatched asynchronously after abort; failures after the reply emit prompt_error and prompt_result. */
  async abort_and_prompt(ctx, args) {
    const input = readInput(ctx, "abort_and_prompt", args);
    const state = prompting(ctx);
    state.goals.stopForHostAbort();
    state.abortBuiltins("Command aborted by host");
    try {
      await ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
    } catch (error) {
      // Never dispatched: free the id so the host can resend it.
      input.claim?.release();
      throw error;
    }
    const ticket = state.results.begin(input.id);
    input.ticket = ticket;
    void dispatchInput(ctx, input).then(
      (outcome) => {
        if (outcome === "cancelled") state.results.settle(ticket);
        else if (outcome === "local") state.results.completeLocal(ticket);
      },
      (cause: unknown) => {
        // Already answered: owe a prompt_error and a failed prompt_result.
        const error = cause instanceof Error ? cause : new Error(String(cause));
        onPromptError(ctx, input)(error);
        state.results.fail(ticket, error.message);
      },
    );
    return undefined;
  },
  // Queue modes apply to this session only (`persist: false`), as in RPC.
  /** @apiCommand set_steering_mode */
  async set_steering_mode({ session }, args) {
    session.setSteeringMode(
      readQueueMode("set_steering_mode", args.mode),
      false,
    );
    return undefined;
  },
  /** @apiCommand set_follow_up_mode */
  async set_follow_up_mode({ session }, args) {
    session.setFollowUpMode(
      readQueueMode("set_follow_up_mode", args.mode),
      false,
    );
    return undefined;
  },
  /** @apiCommand set_interrupt_mode */
  async set_interrupt_mode({ session }, args) {
    if (args.mode !== "immediate" && args.mode !== "wait") {
      throw new Error('set_interrupt_mode: mode must be "immediate" or "wait"');
    }
    session.setInterruptMode(args.mode, false);
    return undefined;
  },
  /**
   * @apiCommand handoff
   * @apiContract handoff
   * @apiUsage Compact the current session with an OMP handoff summary.
   * @apiInputs Optional string `customInstructions` guides the summary.
   * @apiInvariants Compaction runs in the background without interrupting an active response. OMP rejects overlapping compaction or a session transition.
   * @apiEffects Updates the current session's context, not a separate session. The runner waits for compaction to finish before replying with `{}`; compaction errors fail the command.
   * @apiRecovery If delivery is uncertain, inspect session state and `manual_compaction_end` before retrying.
   */
  async handoff({ session }, args) {
    if (
      args.customInstructions !== undefined &&
      typeof args.customInstructions !== "string"
    ) {
      throw new Error("handoff: customInstructions must be a string");
    }
    await session.compact(args.customInstructions, { mode: "handoff" });
    return {};
  },
  /** @apiCommand goal */
  async goal(ctx, args) {
    const op = GOAL_OPS.find((candidate) => candidate === args.op);
    if (!op) throw new Error(`goal: op must be one of ${GOAL_OPS.join(", ")}`);
    if (args.objective !== undefined && typeof args.objective !== "string") {
      throw new Error("goal: objective must be a string");
    }
    if (
      args.token_budget !== undefined &&
      typeof args.token_budget !== "number"
    ) {
      throw new Error("goal: token_budget must be a number");
    }
    return prompting(ctx).goals.handle({
      op,
      objective: args.objective,
      token_budget: args.token_budget,
    });
  },
  /** @apiCommand set_todos */
  async set_todos({ session }, args) {
    const phases = args.phases;
    if (!Array.isArray(phases) || !phases.every(isTodoPhase)) {
      throw new Error(
        "set_todos: phases must be an array of {name, tasks: [{content, status}]}",
      );
    }
    session.commitTodoPhases(phases);
    return { todoPhases: session.getTodoPhases() };
  },
  /** @apiCommand bash */
  async bash({ session, send, id }, args) {
    if (typeof args.command !== "string")
      throw new Error("bash: command must be a string");
    // Reject rather than coerce: a falsy non-boolean such as `null` would silently share the output.
    if (
      args.excludeFromContext !== undefined &&
      typeof args.excludeFromContext !== "boolean"
    ) {
      throw new Error("bash: excludeFromContext must be a boolean");
    }
    return session.executeBash(
      args.command,
      /** @apiEvent bash_output */
      (chunk) => send({ t: "bash_output", id, chunk }),
      {
        excludeFromContext: args.excludeFromContext,
      },
    );
  },
  /** @apiCommand abort_bash */
  async abort_bash({ session }) {
    session.abortBash();
    return undefined;
  },
};

export const promptingFrames: FrameTable = {};
