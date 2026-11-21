/// <reference path="./text.d.ts" />
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveApprovedPlan, normalizePlanTitle } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { autosaveApprovedPlan } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave";
import { resolvePlanFilePath } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import { resolvePlanModelTransition } from "@oh-my-pi/pi-coding-agent/plan-mode/model-transition";
import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isMCPToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import approvedPlanPrompt from "../node_modules/@oh-my-pi/pi-coding-agent/src/prompts/system/plan-mode-approved.md" with { type: "text" };
import { CommandError, type CommandContext, type CommandTable } from "./commands/types";
import type { Static } from "@sinclair/typebox";
import type { PlanStateSchema } from "../../lib/api-contracts/runner-native-events";
import { prompting } from "./commands/prompting";

type PlanState = Static<typeof PlanStateSchema>;
type Proposal = NonNullable<PlanState["proposal"]>;
interface Previous {
  tools: string[];
  mounted: string[];
  registered: string[];
  model?: Model;
  thinking?: ConfiguredThinkingLevel;
}
interface Decision { approved: boolean; feedback?: string; cancelled?: boolean }
interface Pending { proposal: Proposal; resolve: (decision: Decision) => void; done: Promise<unknown> }
const DEFAULT_PLAN = "local://PLAN.md";

/** The runner owns this state independently of any host connection. */
class PlanController {
  readonly session: AgentSession;
  readonly send: CommandContext["send"];
  #previous?: Previous;
  #pending?: Pending;
  #tail: Promise<void> = Promise.resolve();
  #initialized = false;
  #changing = false;
  #pendingPlanModel?: { model: Model; thinkingLevel?: ConfiguredThinkingLevel };

  constructor(session: AgentSession, send: CommandContext["send"]) {
    this.session = session;
    this.send = send;
    session.subscribe((event) => {
      if (event.type !== "agent_end" || !this.#pendingPlanModel) return;
      const pending = this.#pendingPlanModel;
      this.#pendingPlanModel = undefined;
      void this.#serial(async () => {
        if (!this.session.getPlanModeState()?.enabled) return;
        try {
          await this.session.setModelTemporary(pending.model, pending.thinkingLevel);
        } catch (error) {
          this.send({ t: "event", event: { type: "notice", level: "warning", message: `Failed to switch to the plan model: ${error instanceof Error ? error.message : String(error)}` } });
        }
      });
    });
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.then(() => {}, () => {});
    return run;
  }

  state(): PlanState {
    const enabled = this.session.getPlanModeState()?.enabled === true;
    return { enabled, ...(enabled && this.#pending ? { proposal: this.#pending.proposal } : {}) };
  }
  /** @apiEvent plan_state_changed */

  #emit(): void { this.send({ t: "event", event: { type: "plan_state_changed", ...this.state() } }); }

  #capturePrevious(): Previous {
    return {
      tools: this.session.getEnabledToolNames().filter((name) => !isMCPToolName(name)),
      mounted: this.session.getMountedXdevToolNames().filter((name) => !isMCPToolName(name)),
      registered: this.session.getAllToolNames(),
      model: this.session.model,
      thinking: this.session.configuredThinkingLevel(),
    };
  }

  #persist(): void {
    const state = this.session.getPlanModeState();
    const previous = this.#previous;
    if (!state?.enabled || !previous) return;
    this.session.sessionManager.appendModeChange("plan", {
      planFilePath: state.planFilePath,
      previousTools: previous.tools,
      previousMountedTools: previous.mounted,
      previousRegisteredTools: previous.registered,
      previousModel: previous.model ? { provider: previous.model.provider, id: previous.model.id } : undefined,
      previousThinking: previous.thinking ?? null,
    });
  }

  async initialize(): Promise<void> {
    await this.#serial(async () => {
      if (this.#initialized) return;
      await this.#reconcile();
      this.#initialized = true;
    });
  }

  async #reconcile(): Promise<void> {
    // A TUI may already own native plan mode and its proposal handler. Never replace it.
    if (this.session.getPlanModeState()?.enabled && !this.#previous) {
      this.#emit();
      return;
    }
    const context = this.session.sessionManager.buildSessionContext();
    this.#pending = undefined;
    this.#previous = undefined;
    this.session.setPlanProposalHandler(null);
    this.session.setPlanModeState(undefined);
    if (context.mode !== "plan") {
      if (context.messages.length === 0 && !this.session.sessionManager.getEntries().some((entry) => entry.type === "mode_change") && cfgPlanEnabled.get(this.session.settings) && cfgPlanDefaultOnStartup.get(this.session.settings)) {
        const previous = this.#capturePrevious();
        await this.#enter(previous, DEFAULT_PLAN, false);
        this.#persist();
      }
      this.#emit();
      return;
    }
    const data = context.modeData ?? {};
    const strings = (v: unknown): string[] | undefined => Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
    const modelData = data.previousModel as { provider?: unknown; id?: unknown } | undefined;
    const currentModel = this.session.model;
    const model = currentModel?.provider === modelData?.provider && currentModel?.id === modelData?.id
      ? currentModel
      : this.session.getAvailableModels().find((m) => m.provider === modelData?.provider && m.id === modelData?.id);
    const previous: Previous = {
      tools: (strings(data.previousTools) ?? this.session.getEnabledToolNames()).filter((name) => !isMCPToolName(name)),
      mounted: (strings(data.previousMountedTools) ?? this.session.getMountedXdevToolNames()).filter((name) => !isMCPToolName(name)),
      registered: strings(data.previousRegisteredTools) ?? this.session.getAllToolNames(),
      model,
      thinking: typeof data.previousThinking === "string" ? data.previousThinking as ConfiguredThinkingLevel : undefined,
    };
    await this.#enter(previous, typeof data.planFilePath === "string" ? data.planFilePath : DEFAULT_PLAN, true);
    this.#emit();
  }

  async beforeSessionChange(): Promise<void> {
    await this.initialize();
    await this.#serial(async () => {
      if (this.#changing) throw new CommandError("A session change is in progress", "session_busy");
      if (this.#pending) throw new CommandError("Resolve the pending plan proposal before changing sessions", "session_busy");
      if (this.state().enabled && !this.#previous) throw new CommandError("Plan mode is controlled by the terminal; exit it there before changing sessions", "session_busy");
      if (this.state().enabled && this.session.isStreaming) throw new CommandError("Stop the active turn before changing sessions", "session_busy");
      this.#changing = true;
      try {
        if (this.session.getPlanModeState()?.enabled && this.#previous) {
          this.session.setPlanProposalHandler(null);
          this.session.setPlanModeState(undefined);
          await this.session.restoreNonMCPToolPresentation(this.#previous.tools, this.#previous.mounted, this.#previous.registered);
        }
      } catch (error) {
        this.#changing = false;
        throw error;
      }
    });
  }

  async afterSessionChange(): Promise<void> {
    try { await this.#serial(() => this.#reconcile()); }
    finally { this.#changing = false; }
  }

  async cancelPending(): Promise<void> {
    await this.initialize();
    await this.#serial(async () => {
      const pending = this.#pending;
      if (!pending) return;
      this.#pending = undefined;
      pending.resolve({ approved: false, feedback: "The review was interrupted." });
      await pending.done;
      this.#persist();
      this.#emit();
    });
  }

  async setMode(enabled: boolean): Promise<PlanState> {
    await this.initialize();
    return this.#serial(async () => {
      if (this.state().enabled === enabled) return this.state();
      if (this.state().enabled && !this.#previous) throw new CommandError("Plan mode is controlled by the terminal; exit it there", "session_busy");
      if (this.#changing) throw new CommandError("A session change is in progress", "session_busy");
      if (enabled) {
        if (!cfgPlanEnabled.get(this.session.settings)) throw new Error("Plan mode is disabled in OMP settings");
        if (this.session.getGoalModeState()?.enabled || this.session.getVibeModeState()?.enabled) throw new Error("Exit the current mode before entering plan mode");
        const previous = this.#capturePrevious();
        await this.#enter(previous, DEFAULT_PLAN, false);
        this.#persist();
      } else {
        this.#pendingPlanModel = undefined;
        if (this.#pending) {
          const pending = this.#pending;
          this.#pending = undefined;
          pending.resolve({ approved: false, cancelled: true });
        }
        if (this.session.isStreaming) {
          await this.session.runModeExitTeardown(async () => { await this.session.abort({ reason: USER_INTERRUPT_LABEL }); await this.#exit(); });
        } else await this.#exit();
        this.session.sessionManager.appendModeChange("none");
      }
      this.#emit();
      return this.state();
    });
  }

  async #enter(previous: Previous, planFilePath: string, restoring: boolean): Promise<void> {
    const currentTools = this.session.getEnabledToolNames();
    const planTools = [...new Set([
      ...currentTools.filter((name) => name !== "write"),
      ...(this.session.hasBuiltInTool("write") ? ["write"] : []),
    ])];
    if (!this.session.hasBuiltInTool("write") && currentTools.includes("write")) {
      this.send({ t: "event", event: { type: "notice", level: "warning", message: "Plan mode: the write tool is provided by an extension and cannot submit plans. Disable it to use plan mode." } });
    }
    this.#previous = previous;
    this.session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel", reentry: restoring });
    try {
      await this.session.setActiveToolsByName(planTools);
      this.session.setPlanProposalHandler((title) => this.#propose(title));
      if (this.session.isStreaming) await this.session.sendPlanModeContext({ deliverAs: "steer" });
      if (!restoring) {
        const transition = resolvePlanModelTransition(this.session.model, this.session.resolveRoleModelWithThinking("plan"), this.session.isStreaming);
        if (transition.kind === "thinking") this.session.setThinkingLevel(transition.thinkingLevel);
        else if (transition.kind === "apply") {
          if (transition.deferred) this.#pendingPlanModel = transition;
          else await this.session.setModelTemporary(transition.model, transition.thinkingLevel);
        }
      }
    } catch (error) {
      this.session.setPlanProposalHandler(null);
      this.session.setPlanModeState(undefined);
      await this.session.restoreNonMCPToolPresentation(previous.tools, previous.mounted, previous.registered);
      this.#previous = undefined;
      throw error;
    }
  }

  async #restoreModel(previous: Previous): Promise<void> {
    if (!previous.model) return;
    if (this.session.model?.provider === previous.model.provider && this.session.model.id === previous.model.id) this.session.setThinkingLevel(previous.thinking);
    else {
      await this.session.setModelTemporary(previous.model, previous.thinking);
      if (previous.thinking === undefined) this.session.setThinkingLevel(undefined);
    }
  }

  async #exit(): Promise<void> {
    const previous = this.#previous;
    const state = this.session.getPlanModeState();
    this.#pendingPlanModel = undefined;
    if (this.session.isStreaming) throw new Error("Cannot restore the plan model while the agent is running");
    const planTools = this.session.getEnabledToolNames();
    const planMounted = this.session.getMountedXdevToolNames();
    this.session.setPlanProposalHandler(null);
    this.session.setPlanModeState(undefined);
    try {
      if (previous) {
        await this.session.restoreNonMCPToolPresentation(previous.tools, previous.mounted, previous.registered);
        await this.#restoreModel(previous);
      }
      this.#previous = undefined;
    } catch (error) {
      if (state?.enabled && previous) {
        this.session.setPlanModeState(state);
        await this.session.setActiveToolPresentation(planTools, planMounted);
        this.session.setPlanProposalHandler((title) => this.#propose(title));
      }
      throw error;
    }
  }

  #path(url: string): string {
    return resolvePlanFilePath(url, { localProtocolOptions: { getArtifactsDir: () => this.session.sessionManager.getArtifactsDir(), getSessionId: () => this.session.sessionManager.getSessionId() }, cwd: this.session.sessionManager.getCwd() });
  }

  async #propose(title: string) {
    const state = this.session.getPlanModeState();
    if (!state?.enabled) throw new Error("Plan mode is not active");
    if (this.#pending) throw new Error("A plan proposal is already awaiting review");
    const result = await resolveApprovedPlan({
      suppliedTitle: title, statePlanFilePath: state.planFilePath,
      readPlan: async (url) => { try { return await fs.readFile(this.#path(url), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
      listPlanFiles: async () => { try { const root = this.#path("local://"); const entries = await fs.readdir(root, { withFileTypes: true }); const plans = await Promise.all(entries.filter((e) => e.isFile() && /plan\.md$/i.test(e.name)).map(async (e) => ({ url: `local://${e.name}`, time: (await fs.stat(path.join(root, e.name))).mtimeMs }))); return plans.sort((a, b) => b.time - a.time).map((p) => p.url); } catch { return []; } },
    });
    if (!this.session.getPlanModeState()?.enabled || this.session.getPlanModeState() !== state) throw new Error("Plan mode changed while preparing the proposal");
    if (this.#pending) throw new Error("A plan proposal is already awaiting review");
    const proposal: Proposal = { id: randomUUID(), title: result.title, content: result.planContent, planFilePath: result.planFilePath };
    const decision = Promise.withResolvers<Decision>();
    const done = Promise.withResolvers<unknown>();
    this.#pending = { proposal, resolve: decision.resolve, done: done.promise };
    this.session.setPlanModeState({ ...state, planFilePath: proposal.planFilePath });
    this.#persist();
    this.#emit();
    try {
      const choice = await decision.promise;
      const details = { planFilePath: proposal.planFilePath, title: proposal.title, planExists: true };
      if (choice.cancelled) return { content: [{ type: "text" as const, text: "Plan review cancelled; plan mode exited." }], details };
      if (!choice.approved) {
        const current = this.session.getPlanModeState();
        if (current?.enabled) this.session.setPlanModeState({ ...current, planFilePath: proposal.planFilePath });
        this.#persist();
        return { content: [{ type: "text" as const, text: `Plan refinement requested.${choice.feedback ? ` Feedback: ${choice.feedback}` : ""} Update the plan file, then write ${normalizePlanTitle(proposal.title).title} to xd://propose again when ready.` }], details };
      }
      return { content: [{ type: "text" as const, text: "Plan ready for review." }], details };
    } catch (error) { done.resolve(error); throw error; }
    finally { done.resolve(undefined); }
  }

  async #approve(proposal: Proposal): Promise<void> {
    const currentContent = await fs.readFile(this.#path(proposal.planFilePath), "utf8");
    if (currentContent !== proposal.content) throw new Error("Plan changed since it was submitted; request a new review");
    await this.#exit();
    this.session.setPlanReferencePath(proposal.planFilePath);
    this.session.sessionManager.appendModeChange("none", { approvedPlanFilePath: proposal.planFilePath });
    try { await autosaveApprovedPlan({ settings: this.session.settings, cwd: this.session.sessionManager.getCwd(), title: proposal.title, planContent: proposal.content }); }
    catch (error) { logger.warn("Failed to autosave approved plan", { error: String(error) }); }
  }

  async respond(id: string, approved: boolean, feedback?: string): Promise<PlanState> {
    await this.initialize();
    return this.#serial(async () => {
      const pending = this.#pending;
      if (!pending || pending.proposal.id !== id) throw new CommandError("Plan proposal is no longer pending", "stale_proposal");
      if (approved) {
        const currentContent = await fs.readFile(this.#path(pending.proposal.planFilePath), "utf8");
        if (currentContent !== pending.proposal.content) throw new Error("Plan changed since it was submitted; request a new review");
        this.#pending = undefined;
        await this.session.runModeExitTeardown(async () => {
          this.session.markPlanInternalAbortPending();
          try {
            const stopped = this.session.abort();
            pending.resolve({ approved: true });
            await pending.done;
            await stopped;
          } finally {
            this.session.clearPlanInternalAbortPending();
          }
          await this.#approve(pending.proposal);
          this.#emit();
          this.session.markPlanReferenceSent();
          const text = prompt.render(approvedPlanPrompt, {
            planFilePath: pending.proposal.planFilePath,
            planContent: pending.proposal.content,
            contextPreserved: true,
          });
          const admitted = Promise.withResolvers<void>();
          const execution = this.session.prompt(text, { synthetic: true, onPromptAdmitted: admitted.resolve });
          void execution.catch((error: unknown) => {
            this.send({ t: "prompt_error", command: "prompt", error: error instanceof Error ? error.message : String(error) });
          });
          await Promise.race([admitted.promise, execution.then(() => undefined)]);
        }).catch((error: unknown) => {
          this.#emit();
          throw error;
        });
      } else {
        this.#pending = undefined;
        pending.resolve({ approved: false, feedback });
        const error = await pending.done;
        if (error !== undefined) {
          this.#emit();
          throw error;
        }
        if (this.session.getPlanModeState()?.enabled) this.#persist();
        this.#emit();
      }
      return this.state();
    });
  }
}

const controllers = new WeakMap<AgentSession, PlanController>();
export function planController({ session, send }: CommandContext): PlanController {
  let controller = controllers.get(session);
  if (!controller) { controller = new PlanController(session, send); controllers.set(session, controller); }
  return controller;
}

export const planCommands: CommandTable = {
  /** @apiCommand get_plan_state */
  async get_plan_state(ctx) { const plan = planController(ctx); await plan.initialize(); return plan.state(); },
  /** @apiCommand set_plan_mode */
  async set_plan_mode(ctx, args) { if (typeof args.enabled !== "boolean") throw new Error("set_plan_mode: enabled must be a boolean"); const enabled = args.enabled; return prompting(ctx).enqueue(() => planController(ctx).setMode(enabled)); },
  /** @apiCommand respond_plan_proposal */
  async respond_plan_proposal(ctx, args) {
    if (typeof args.id !== "string" || typeof args.approved !== "boolean" || (args.feedback !== undefined && typeof args.feedback !== "string")) throw new Error("respond_plan_proposal: invalid decision");
    return prompting(ctx).enqueue(() => planController(ctx).respond(args.id as string, args.approved as boolean, args.feedback as string | undefined));
  },
};
