import { statSync } from "node:fs";
import type { HostModels } from "./api-contracts/configuration-models";
import { HostOpError } from "./hosts/link-protocol";
import {
  disposeUtilityRpc,
  runUtilityCommand,
  type OmpModel,
} from "./omp/rpc-utility";
import { getModelsConfigPath, getSettingsPath } from "./omp/paths";
import { readDisabledProviders } from "./omp/model-roles";
import { readAnthropicSlowMode } from "./omp/settings-config";
import type { ModelsData as ContractModelsData } from "./api-contracts/configuration-models";
export type ModelsData = ContractModelsData;

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
// Never expose caught provider/configuration details in a fallback response.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE =
  "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piModelsCacheState;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
}

export function withModelRuntimeError(
  data: ModelsData,
  modelError: string | undefined,
): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

export function loadModelsWithCache(
  cwd: string,
  loader: () => Promise<ModelsData>,
): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached && cached.expiresAt > Date.now())
    return Promise.resolve(cached.data);

  const load = state.inFlight.get(cwd) ?? startModelsLoad(state, cwd, loader);

  if (cached) {
    // Stale-while-revalidate: serve the expired entry immediately while the
    // refresh runs in the background. Staleness here only ever means TTL age —
    // invalidateModelsCache() (login, set_model, models.yml writes) clears
    // entries outright, so mutations never serve through this path.
    load.catch(() => {
      // A failed background refresh keeps serving the stale entry; the next
      // request retries.
    });
    return Promise.resolve(cached.data);
  }
  return load;
}

function startModelsLoad(
  state: ModelsCacheState,
  cwd: string,
  loader: () => Promise<ModelsData>,
): Promise<ModelsData> {
  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (
        state.generation === generation &&
        state.inFlight.get(cwd) === loadPromise
      ) {
        // Expired entries are kept (they back stale-while-revalidate serving);
        // the entry cap alone bounds the map.
        state.entries.delete(cwd);
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(cwd, {
          data,
          expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
        });
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    });

  state.inFlight.set(cwd, loadPromise);
  return loadPromise;
}

// Each daemon has one OMP model registry, shared across its workspaces.
const MODELS_CACHE_KEY = "global";

declare global {
  var __ompModelsConfigFingerprint: string | undefined;
}

function refreshModelsIfConfigChanged(): void {
  const fingerprint = [getModelsConfigPath(), getSettingsPath()]
    .map((path) => {
      try {
        const stat = statSync(path);
        return `${path}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      } catch {
        return `${path}:missing`;
      }
    })
    .join("\n");

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

export async function getHostModels(refresh = false): Promise<HostModels> {
  refreshModelsIfConfigChanged();
  const anthropicSlowMode = readAnthropicSlowMode();
  if (refresh) invalidateModelsCache();
  try {
    const data = await loadModelsWithCache(MODELS_CACHE_KEY, () =>
      loadModels(refresh),
    );
    return { ...data, anthropicSlowMode };
  } catch {
    if (refresh)
      throw new HostOpError(
        503,
        "model_refresh_failed",
        "Model refresh failed. Check your configuration and try again.",
      );
    return { ...withSafeModelLoadFailure(EMPTY_MODELS), anthropicSlowMode };
  }
}
