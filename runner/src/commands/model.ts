import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CACHE_WARMING_MODES } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { isSessionSettled } from "@oh-my-pi/pi-coding-agent/session/session-settle";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { activityFor } from "../activity";
import { advisorReviewPending } from "../advisor";
import type { CommandTable, FrameTable } from "./types";

/** A live in-process snapshot, not a durable completion receipt. The settled flag includes pending
 * asynchronous work; clients should refresh it as the session changes. */
export function sessionState(session: AgentSession) {
  const queued = session.getQueuedMessages();
  return {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    modelActivity: activityFor(session),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    interruptMode: session.interruptMode,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    autoCompactionEnabled: session.autoCompactionEnabled,
    queuedMessageCount: session.queuedMessageCount,
    hasPendingAsyncWork: session.hasPendingAsyncWork(),
    advisorReviewPending: advisorReviewPending(session),
    isSettled: isSessionSettled(session),
    queuedMessages: {
      steering: [...queued.steering],
      followUp: [...queued.followUp],
      liveSteered: queued.liveSteered,
    },
    todoPhases: session.getTodoPhases(),
    fastModeEnabled: session.isFastModeEnabled(),
    tokensPerSecond: calculateTokensPerSecond(
      session.messages,
      session.isStreaming,
    ),
    fastModeActive: session.isFastModeActive(),
    slowModeSupported: session.isSlowModeSupported(),
    slowModeEnabled: session.isSlowModeEnabled(),
    slowModeScope: session.getSlowModeScope(),
    usageLimit: session.getUsageLimitState(),
    messageCount: session.messages.length,
    systemPrompt: session.systemPrompt,
    dumpTools: session.agent.state.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toolWireSchema(tool),
      examples: tool.examples,
    })),
    contextUsage: session.getContextUsage(),
    goal: session.getGoalModeState() ?? null,
  };
}

// Channel commands can overlap; serialize discovery mutations per live registry.
const registryRefreshes = new WeakMap<AgentSession["modelRegistry"], Promise<void>>();

async function withRegistryRefresh(
  session: AgentSession,
  refresh: () => Promise<void>,
): Promise<void> {
  const registry = session.modelRegistry;
  const previous = registryRefreshes.get(registry) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(refresh);
  registryRefreshes.set(registry, current);
  try {
    await current;
  } finally {
    if (registryRefreshes.get(registry) === current) registryRefreshes.delete(registry);
  }
}

/** Resolve against this session's registry, including newly discovered models on its host. */
export async function findModel(
  session: AgentSession,
  provider: string,
  modelId: string,
) {
  const find = () =>
    session
      .getAvailableModels()
      .find((m) => m.provider === provider && m.id === modelId);
  let model = find();
  if (model) return model;
  const registry = session.modelRegistry;
  await registry.awaitBackgroundRefresh();
  model = find();
  if (model) return model;
  // The web utility may be on another host, so refresh the owning registry.
  await withRegistryRefresh(session, async () => {
    if (find()) return;
    await registry.refreshProvider(provider, "online");
    const discoveryId = registry.getDiscoveryProviderId(provider) ?? provider;
    if (registry.getProviderDiscoveryState(discoveryId)?.error) {
      throw new Error(`Model discovery failed for provider ${provider}`);
    }
    await session.refreshScopedModels();
  });
  return find();
}

function bool(op: string, value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new Error(`${op}: enabled must be a boolean`);
  return value;
}

export const modelCommands: CommandTable = {
  /** @apiCommand get_state */
  async get_state({ session }) {
    return sessionState(session);
  },
  /** @apiCommand set_model */
  async set_model({ session }, { provider, modelId }) {
    if (typeof provider !== "string" || typeof modelId !== "string")
      throw new Error("set_model: provider and modelId must be strings");
    const model = await findModel(session, provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await session.setModel(model);
    return model;
  },
  /** @apiCommand cycle_model */
  async cycle_model({ session }) {
    return (await session.cycleModel()) ?? null;
  },
  /** @apiCommand get_available_models */
  async get_available_models({ session }) {
    await session.modelRegistry.awaitBackgroundRefresh();
    return { models: session.getAvailableModels() };
  },
  /** @apiCommand refresh_available_models */
  async refresh_available_models({ session }) {
    const registry = session.modelRegistry;
    await withRegistryRefresh(session, async () => {
      await registry.awaitBackgroundRefresh();
      await registry.refresh("online", { refreshCommandCredentials: true });
      if (registry.getError()) throw new Error("Model configuration could not be loaded");
      const providers = new Set([
        ...registry.getDiscoverableProviders(),
        ...registry.getAll().map((model) => model.provider),
      ]);
      const failed = [...providers].some(
        (provider) => registry.getProviderDiscoveryState(provider)?.error,
      );
      if (failed || registry.getRuntimeDiscoveryFailures().length > 0) {
        throw new Error("Model discovery failed for one or more providers");
      }
      await session.refreshScopedModels();
    });
    return { models: session.getAvailableModels() };
  },
  /** @apiCommand set_thinking_level */
  async set_thinking_level({ session }, { level }) {
    const parsed =
      typeof level === "string"
        ? parseConfiguredThinkingLevel(level)
        : undefined;
    if (!parsed)
      throw new Error(`set_thinking_level: invalid level ${String(level)}`);
    session.setThinkingLevel(parsed);
  },
  /** @apiCommand cycle_thinking_level */
  async cycle_thinking_level({ session }) {
    const level = session.cycleThinkingLevel();
    return level ? { level } : null;
  },
  /** @apiCommand get_available_thinking_levels */
  async get_available_thinking_levels({ session }) {
    return {
      levels: [ThinkingLevel.Off, ...session.getAvailableThinkingLevels()],
    };
  },
  /** @apiCommand set_fast_mode */
  async set_fast_mode({ session }, { enabled }) {
    const on = bool("set_fast_mode", enabled);
    if (!session.setFastMode(on) && on)
      throw new Error("Fast mode is unavailable for the current model.");
    return {
      enabled: session.isFastModeEnabled(),
      active: session.isFastModeActive(),
    };
  },
  /** @apiCommand set_slow_mode */
  async set_slow_mode({ session }, { enabled }) {
    const on = bool("set_slow_mode", enabled);
    if (!session.setSlowMode(on) && on)
      throw new Error("Slow mode is unavailable for the current model.");
    return { enabled: session.isSlowModeEnabled() };
  },
  /** @apiCommand set_auto_compaction */
  async set_auto_compaction({ session }, { enabled }) {
    session.setAutoCompactionEnabled(bool("set_auto_compaction", enabled));
  },
  /** @apiCommand set_auto_retry */
  async set_auto_retry({ session }, { enabled }) {
    session.setAutoRetryEnabled(bool("set_auto_retry", enabled));
  },
  /** @apiCommand abort_retry */
  async abort_retry({ session }) {
    session.abortRetry();
  },
  /** @apiCommand set_cache_warming */
  async set_cache_warming({ session }, { mode }) {
    const valid = CACHE_WARMING_MODES.find((m) => m === mode);
    if (!valid) throw new Error(`Invalid cache warming mode: ${String(mode)}`);
    return { mode: session.setCacheWarmingMode(valid) };
  },
  /** @apiCommand compact */
  async compact({ session }, { customInstructions }) {
    if (
      customInstructions !== undefined &&
      typeof customInstructions !== "string"
    )
      throw new Error("compact: customInstructions must be a string");
    return session.compact(customInstructions);
  },
  /** @apiCommand abort_compaction */
  async abort_compaction({ session }) {
    session.abortCompaction();
  },
  // The runner's own command; mirrors argument-less `/rename`: generate, persist as a user title, return it.
  /** @apiCommand generate_title */
  async generate_title({ session }) {
    const title = await session.renameTitle();
    if (!title) return { title: null };
    if (!(await session.sessionManager.setSessionName(title, "user")))
      throw new Error("generate_title: a user-set name takes precedence");
    return { title };
  },
  /** @apiCommand get_session_stats */
  async get_session_stats({ session }) {
    return session.getSessionStats();
  },
  /** @apiCommand get_available_commands */
  async get_available_commands({ session }) {
    return { commands: await buildAvailableSlashCommands(session) };
  },
};

export const modelFrames: FrameTable = {};
