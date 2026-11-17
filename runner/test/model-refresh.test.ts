import { describe, expect, it } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { findModel, modelCommands } from "../src/commands/model";
import type { CommandContext } from "../src/commands/types";

function fixture() {
  const model = { provider: "remote", id: "new-model" };
  let models: typeof model[] = [];
  let discoveryError: string | undefined;
  let configError = false;
  let refreshes = 0;
  let scopedRefreshes = 0;
  const registry = {
    awaitBackgroundRefresh: async () => {},
    refresh: async (strategy: string, options: { refreshCommandCredentials: boolean }) => {
      expect(strategy).toBe("online");
      expect(options.refreshCommandCredentials).toBe(true);
      refreshes++;
      models = [model];
    },
    refreshProvider: async (provider: string, strategy: string) => {
      expect(provider).toBe("remote");
      expect(strategy).toBe("online");
      refreshes++;
      models = [model];
    },
    getDiscoveryProviderId: (provider: string) => provider,
    getProviderDiscoveryState: () => ({ error: discoveryError }),
    getDiscoverableProviders: () => ["remote"],
    getAll: () => models,
    getRuntimeDiscoveryFailures: () => [],
    getError: () => configError ? {} : undefined,
  };
  const session = {
    modelRegistry: registry,
    getAvailableModels: () => models,
    refreshScopedModels: async () => { scopedRefreshes++; },
  } as unknown as AgentSession;
  const ctx: CommandContext = { session, send: () => {} };
  return {
    model, session, ctx,
    get refreshes() { return refreshes; },
    get scopedRefreshes() { return scopedRefreshes; },
    failDiscovery() { discoveryError = "private provider details"; },
    failConfig() { configError = true; },
  };
}

describe("model registry refresh", () => {
  it("refreshes online and updates the session scope without replacing the session", async () => {
    const f = fixture();
    expect(await modelCommands.refresh_available_models(f.ctx, {})).toEqual({ models: [f.model] });
    expect(f.refreshes).toBe(1);
    expect(f.scopedRefreshes).toBe(1);
  });

  it("rejects provider and config failures without exposing details", async () => {
    const failed = fixture();
    failed.failDiscovery();
    await expect(modelCommands.refresh_available_models(failed.ctx, {})).rejects.toThrow("Model discovery failed");
    const invalid = fixture();
    invalid.failConfig();
    await expect(modelCommands.refresh_available_models(invalid.ctx, {})).rejects.toThrow("Model configuration could not be loaded");
  });

  it("refreshes a missing model on the session host and coalesces concurrent misses", async () => {
    const f = fixture();
    const results = await Promise.all([
      findModel(f.session, "remote", "new-model"),
      findModel(f.session, "remote", "new-model"),
    ]);
    expect(results).toEqual([f.model, f.model]);
    expect(f.refreshes).toBe(1);
    expect(f.scopedRefreshes).toBe(1);
  });

  it("surfaces discovery failure during model selection", async () => {
    const f = fixture();
    f.failDiscovery();
    await expect(findModel(f.session, "remote", "new-model")).rejects.toThrow("Model discovery failed for provider remote");
  });
});
