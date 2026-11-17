import { statSync } from "fs";
import {
  invalidateModelsCache,
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData,
} from "@/lib/models-cache";
import {
  disposeUtilityRpc,
  runUtilityCommand,
  type OmpModel,
} from "@/lib/omp/rpc-utility";
import { getModelsConfigPath } from "@/lib/omp/paths";
import { readDisabledProviders } from "@/lib/omp/model-roles";
import { readAnthropicSlowMode } from "@/lib/omp/settings-config";

// The omp model registry (auth + models.yml) is global, not per-cwd, so one
// cache entry serves every request. The ?cwd= query parameter is still
// accepted for client compatibility but no longer affects the result.
const MODELS_CACHE_KEY = "global";

declare global {
  var __ompModelsConfigFingerprint: string | undefined;
}

function refreshModelsIfConfigChanged(): void {
  const path = getModelsConfigPath();
  let fingerprint = `${path}:missing`;
  try {
    const stat = statSync(path);
    fingerprint = `${path}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch {
    // A missing models file is a valid state; the fingerprint still detects
    // its later creation.
  }

  const previous = globalThis.__ompModelsConfigFingerprint;
  globalThis.__ompModelsConfigFingerprint = fingerprint;
  if (previous !== undefined && previous !== fingerprint) {
    // The utility process reads models.yml once at startup. External edits
    // therefore need the same invalidation as the web editor's PUT route.
    invalidateModelsCache();
    disposeUtilityRpc();
  }
}

const modelNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string },
): number {
  return (
    modelNameCollator.compare(a.name || a.id, b.name || b.id) ||
    modelNameCollator.compare(a.provider, b.provider) ||
    modelNameCollator.compare(a.id, b.id)
  );
}

// "off" is always a valid selector; the concrete efforts come from the model's
// baked thinking metadata (omp: getSupportedEfforts = reasoning ? efforts : []).
function thinkingLevelsFor(model: OmpModel): string[] {
  if (!model.reasoning) return ["off"];
  return ["off", ...(model.thinking?.efforts ?? [])];
}

// OMP's /fast maps to a priority service tier. These are the provider families
// OMP currently resolves for that control (ModelControls.setFastMode).
function supportsFastMode(model: OmpModel): boolean {
  return (
    model.provider === "anthropic" ||
    model.provider === "openai" ||
    model.provider === "google"
  );
}

// Copy of omp's AgentSession#slowModeTarget for the composer's Slow toggle
// before omp runs: Claude low priority on `anthropic`, else the flex tier of
// the OpenAI/Google service-tier families. Live get_state wins once omp runs.
// ponytail: provider-only; OpenRouter's openai/google ids need omp's model identity.
const SLOW_MODE_PROVIDERS: Record<string, true> = {
  anthropic: true,
  openai: true,
  "openai-codex": true,
  google: true,
  "google-vertex": true,
};

async function loadModels(refresh = false): Promise<ModelsData> {
  const availableResponse = await runUtilityCommand<{ models?: unknown }>(
    { type: refresh ? "refresh_available_models" : "get_available_models" },
    120_000,
  );
  if (!Array.isArray(availableResponse.models)) {
    throw new Error("Invalid model registry response");
  }
  const available = Array.isArray(availableResponse.models)
    ? availableResponse.models
        .filter(
          (model): model is OmpModel =>
            typeof model === "object" &&
            model !== null &&
            typeof (model as OmpModel).id === "string" &&
            typeof (model as OmpModel).provider === "string",
        )
        .map((model) => ({
          ...model,
          name:
            typeof model.name === "string" && model.name.trim().length > 0
              ? model.name
              : model.id,
        }))
    : [];

  const nameMap = new Map<string, string>();
  const thinkingLevels: Record<string, string[]> = {};
  const modelList = available
    .map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      thinkingLevels: thinkingLevelsFor(m),
      supportsFastMode: supportsFastMode(m),
      supportsSlowMode: SLOW_MODE_PROVIDERS[m.provider] === true,
      contextWindow: m.contextWindow ?? undefined,
      maxTokens: m.maxTokens ?? undefined,
    }))
    .sort(compareModelEntries);
  const loginResponse = await runUtilityCommand<{ providers?: unknown }>(
    { type: "get_login_providers" },
    30_000,
  );
  const loginProviders = Array.isArray(loginResponse.providers)
    ? loginResponse.providers.filter(
        (
          provider,
        ): provider is { id: string; name: string; authenticated: boolean } =>
          typeof provider === "object" &&
          provider !== null &&
          typeof (provider as { id?: unknown }).id === "string" &&
          typeof (provider as { name?: unknown }).name === "string" &&
          typeof (provider as { authenticated?: unknown }).authenticated ===
            "boolean",
      )
    : [];
  const disabledProviders = readDisabledProviders();
  const connectedProviders = loginProviders
    .filter((provider) => provider.authenticated)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      disabled: disabledProviders.has(provider.id),
    }));
  for (const m of available) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = thinkingLevelsFor(m);
  }

  // omp resolves the default model at session start; a --no-session utility
  // process reports it via get_state.
  let defaultModel: { provider: string; modelId: string } | null = null;
  try {
    const state = await runUtilityCommand<{
      model?: { provider?: string; id?: string };
    }>({ type: "get_state" }, 30_000);
    const provider = state.model?.provider;
    const modelId = state.model?.id;
    if (
      provider &&
      modelId &&
      available.some((m) => m.provider === provider && m.id === modelId)
    ) {
      defaultModel = { provider, modelId };
    }
  } catch {
    // Default model is cosmetic — the models list is still useful without it.
  }

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      thinkingLevels,
      connectedProviders,
    },
    undefined,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
};

/**
 * @apiContract getModels
 * @apiUsage Read the global model selector snapshot and current Anthropic slow-mode setting.
 * @apiInputs The legacy cwd query does not affect the result.
 * @apiInvariants Model data is cached globally for 60 seconds; models.yml changes invalidate the cache and restart the utility process. Slow mode is read separately on every request. The HTTP response adds anthropicSlowMode, and each modelList entry includes thinkingLevels plus contextWindow and maxTokens when supplied by omp, in tokens.
 * @apiEffects Queries omp on cache misses; failures return a safe empty snapshot with an error marker.
 * @apiRecovery Inspect the error marker and configuration before retrying.
 */
export async function GET() {
  refreshModelsIfConfigChanged();
  // Outside the cache: `/slow` on a Claude model rewrites config.yml.
  const anthropicSlowMode = readAnthropicSlowMode();
  try {
    return Response.json({
      ...(await loadModelsWithCache(MODELS_CACHE_KEY, () => loadModels())),
      anthropicSlowMode,
    });
  } catch {
    return Response.json({
      ...withSafeModelLoadFailure(EMPTY_MODELS),
      anthropicSlowMode,
    });
  }
}

/**
 * @apiContract refreshModels
 * @apiUsage Refresh the global model selector snapshot from configured providers.
 * @apiInputs No request body is required; the legacy cwd query does not affect the result.
 * @apiInvariants Bypasses both the web cache and omp discovery cache; successful responses have the same shape as GET. Concurrent GET requests join the refresh. Active sessions are not stopped.
 * @apiEffects Runs online discovery, refreshes command-backed credentials, and replaces the cached snapshot on success.
 * @apiRecovery A 503 indicates discovery or loading failed; inspect provider configuration and retry.
 */
export async function POST() {
  refreshModelsIfConfigChanged();
  invalidateModelsCache();
  try {
    const data = await loadModelsWithCache(MODELS_CACHE_KEY, () => loadModels(true));
    return Response.json({ ...data, anthropicSlowMode: readAnthropicSlowMode() });
  } catch {
    return Response.json(
      { error: "Model refresh failed. Check your configuration and try again." },
      { status: 503 },
    );
  }
}
