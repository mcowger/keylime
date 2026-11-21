import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { modelCommands } from "../src/commands/model";
import type { CommandContext } from "../src/commands/types";
import { registerThinkingCeiling } from "../src/thinking-ceiling";
import type { ThinkingLevelCeiling } from "@oh-my-pi/pi-tui/thinking";
import { Value } from "@sinclair/typebox/value";
import { SetChatRoleResultSchema } from "../../lib/api-contracts/runner-lifecycle";

const model = {
  provider: "example", id: "main", name: "Main", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High] },
  contextWindow: 1000, maxTokens: 100,
} as Model;

function context(roles: Record<string, string>, models: Model[] = [model], thinking: ThinkingLevel | "auto" | undefined = undefined, ceiling?: ThinkingLevelCeiling): CommandContext {
  const settings = Settings.isolated({ modelRoles: roles });
  const session = {
    configuredThinkingLevel: () => thinking,
    settings,
    model: models[0],
    modelRegistry: { awaitBackgroundRefresh: async () => {}, getAvailable: () => models },
  } as unknown as AgentSession;
  registerThinkingCeiling(session, ceiling);
  return { session, send: () => {} };
}

describe("workspace chat roles", () => {
  it("uses the current model for the default and resolves configured custom selectors", async () => {
    const response = await modelCommands.get_chat_roles(context({
      custom: "example/main:high", missing: "example/not-found", image: "example/main", commit: "example/main",
    }), {}) as { roles: Array<{ id: string; provider: string | null; modelId: string | null; thinkingLevel: string | null }> };
    expect(response.roles.map((role) => role.id)).toEqual(["default", "smol", "slow", "custom", "missing"]);
    expect(response.roles[0]).toMatchObject({ provider: "example", modelId: "main" });
    expect(response.roles[3]).toMatchObject({ provider: "example", modelId: "main", thinkingLevel: "high" });
    expect(response.roles[4]).toMatchObject({ provider: null, modelId: null, thinkingLevel: null });
  });
  it("reports inherited current thinking without turning it into an explicit role setting", async () => {
    const response = await modelCommands.get_chat_roles(context({ custom: "example/main" }, [model], ThinkingLevel.Off), {}) as { roles: Array<{ id: string; thinkingLevel: string | null; effectiveThinkingLevel: string | null }> };
    const custom = response.roles.find((role) => role.id === "custom");
    expect(custom).toMatchObject({ thinkingLevel: null, effectiveThinkingLevel: "off" });
    const automatic = await modelCommands.get_chat_roles(context({ custom: "example/main" }, [model], "auto"), {}) as { roles: Array<{ id: string; effectiveThinkingLevel: string | null }> };
    expect(automatic.roles.find((role) => role.id === "custom")?.effectiveThinkingLevel).toBe("auto");
  });
  it("clamps explicit and inherited efforts to the session ceiling", async () => {
    const response = await modelCommands.get_chat_roles(context({ explicit: "example/main:high", inherited: "example/main" }, [model], ThinkingLevel.High, () => Effort.Medium), {}) as { roles: Array<{ id: string; thinkingLevel: string | null; effectiveThinkingLevel: string | null }> };
    expect(response.roles.find((role) => role.id === "explicit")).toMatchObject({ thinkingLevel: "high", effectiveThinkingLevel: "medium" });
    expect(response.roles.find((role) => role.id === "inherited")).toMatchObject({ thinkingLevel: null, effectiveThinkingLevel: "medium" });
  });
  it("previews the supplied composer effort without overriding explicit role effort", async () => {
    const response = await modelCommands.get_chat_roles(context({ inherited: "example/main", explicit: "example/main:high" }, [model], ThinkingLevel.Low, () => Effort.Medium), { thinkingLevel: "off" }) as { roles: Array<{ id: string; effectiveThinkingLevel: string | null }> };
    expect(response.roles.find((role) => role.id === "inherited")?.effectiveThinkingLevel).toBe("off");
    expect(response.roles.find((role) => role.id === "explicit")?.effectiveThinkingLevel).toBe("medium");
    await expect(modelCommands.get_chat_roles(context({}), { thinkingLevel: "not-a-level" })).rejects.toThrow("invalid thinking level");
  });

  it("reports the native unset result for non-reasoning models", async () => {
    const plain = { ...model, id: "plain", name: "Plain", reasoning: false, thinking: undefined } as Model;
    const response = await modelCommands.get_chat_roles(context({ plain: "example/plain" }, [model, plain], ThinkingLevel.High), {}) as { roles: Array<{ id: string; effectiveThinkingLevel: string | null }> };
    expect(response.roles.find((role) => role.id === "plain")?.effectiveThinkingLevel).toBeNull();
  });

  it("keeps built-in roles unresolved when no models are available", async () => {
    const response = await modelCommands.get_chat_roles(context({}, []), {}) as { roles: Array<{ id: string; modelId: string | null }> };
    expect(response.roles).toHaveLength(3);
    expect(response.roles.every((role) => role.modelId === null)).toBe(true);
  });

  it("resolves and applies an excluded role model using native role and thinking semantics", async () => {
    const excluded = { ...model, id: "excluded", name: "Excluded", headers: { Authorization: "runner-secret-sentinel" }, thinking: { ...model.thinking, headers: { Authorization: "runner-secret-sentinel" } } } as Model;
    const settings = Settings.isolated({ enabledModels: ["example/main"], modelRoles: { smol: "example/excluded:high", custom: "example/excluded" } });
    let active = model;
    const changes: Array<{ model: string; role: string }> = [];
    const registry = {
      awaitBackgroundRefresh: async () => {},
      getAvailable: () => [model, excluded],
      hasConfiguredAuth: () => true,
      refreshSelectedModelMetadata: async (selected: Model) => selected,
      clearSuppressedSelector: () => {},
      refreshProvider: async () => {},
      getDiscoveryProviderId: () => undefined,
      getProviderDiscoveryState: () => undefined,
    };
    const host = {
      settings, modelRegistry: registry,
      agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} },
      model: () => active,
      sessionManager: {
        getLastModelChangeRole: () => changes.at(-1)?.role,
        appendModelChange: (selected: string, role: string) => changes.push({ model: selected, role }),
        appendThinkingLevelChange: () => {},
      },
      resolveActiveEditMode: () => "",
      setModelWithProviderSessionReset: async (selected: Model) => { active = selected; },
      syncAfterModelChange: async () => {},
      clearActiveRetryFallback: () => {},
      clearInheritedProviderPromptCacheKey: () => {},
      emit: () => {},
    } as unknown as ModelControlsHost;
    const controls = new ModelControls(host, { thinkingLevel: ThinkingLevel.Low });
    const session = {
      settings, modelRegistry: registry,
      get model() { return active; },
      get thinkingLevel() { return controls.thinkingLevel; },
      getAvailableModels: () => [model],
      refreshScopedModels: async () => {},
      configuredThinkingLevel: () => controls.configuredThinkingLevel(),
      getRoleModelCycle: (roles: string[]) => controls.getRoleModelCycle(roles),
      applyRoleModel: controls.applyRoleModel.bind(controls),
    } as unknown as AgentSession;
    const ctx: CommandContext = { session, send: () => {} };
    const preview = await modelCommands.get_chat_roles(ctx, {}) as { roles: Array<{ id: string; modelId: string | null }> };
    expect(preview.roles.find((role) => role.id === "smol")?.modelId).toBe("excluded");
    await expect(modelCommands.set_model(ctx, { provider: "example", modelId: "excluded" })).rejects.toThrow("Model not found");
    expect(preview.roles.find((role) => role.id === "slow")?.modelId).toBeNull();
    const result: unknown = JSON.parse(JSON.stringify(await modelCommands.set_chat_role(ctx, { role: "smol" })));
    expect(Value.Check(SetChatRoleResultSchema, result)).toBe(true);
    if (!Value.Check(SetChatRoleResultSchema, result)) throw new Error("Invalid role response");
    expect(result.model).toEqual({ id: "excluded", provider: "example", name: "Excluded", reasoning: true, thinking: { efforts: ["low", "medium", "high"] } });
    expect(result.thinkingLevel).toBe("high");
    expect(JSON.stringify(result)).not.toContain("runner-secret-sentinel");
    expect(changes).toEqual([{ model: "example/excluded", role: "smol" }]);
    expect(settings.getModelRole("smol")).toBe("example/excluded:high");
    await modelCommands.set_chat_role(ctx, { role: "custom" });
    expect(controls.thinkingLevel).toBe(ThinkingLevel.High);
    expect(changes.at(-1)?.role).toBe("custom");
    await expect(modelCommands.set_chat_role(ctx, { role: "slow" })).rejects.toThrow("role is not available");
    await expect(modelCommands.set_chat_role(ctx, { role: "image" })).rejects.toThrow("invalid chat role");
    await expect(modelCommands.set_chat_role(ctx, { role: 42 })).rejects.toThrow("invalid chat role");
  });

  it("does not present a temporary runner's model as the unconfigured default", async () => {
    const ctx = context({});
    const response = await modelCommands.get_chat_roles(ctx, { currentModelFallback: false }) as { roles: Array<{ id: string; modelId: string | null }> };
    expect(response.roles.find((role) => role.id === "default")?.modelId).toBeNull();
    const configured = await modelCommands.get_chat_roles(context({ default: "example/main" }), { currentModelFallback: false }) as { roles: Array<{ id: string; modelId: string | null }> };
    expect(configured.roles.find((role) => role.id === "default")?.modelId).toBe("main");
    const other = { ...model, id: "other", name: "Other" } as Model;
    const withCurrent = await modelCommands.get_chat_roles(context({}, [model, other]), { currentModelFallback: false, currentProvider: "example", currentModelId: "other" }) as { roles: Array<{ id: string; modelId: string | null }> };
    expect(withCurrent.roles.find((role) => role.id === "default")?.modelId).toBe("other");
    const unavailable = await modelCommands.get_chat_roles(ctx, { currentModelFallback: false, currentProvider: "example", currentModelId: "missing" }) as { roles: Array<{ id: string; modelId: string | null }> };
    expect(unavailable.roles.find((role) => role.id === "default")?.modelId).toBeNull();
    const configuredWithCurrent = await modelCommands.get_chat_roles(context({ default: "example/main" }, [model, other]), { currentModelFallback: false, currentProvider: "example", currentModelId: "other" }) as { roles: Array<{ id: string; modelId: string | null }> };
    expect(configuredWithCurrent.roles.find((role) => role.id === "default")?.modelId).toBe("main");
    await expect(modelCommands.get_chat_roles(ctx, { currentModelFallback: false, currentProvider: "example" })).rejects.toThrow("must be non-empty strings together");
    await expect(modelCommands.get_chat_roles(ctx, { currentModelFallback: "false" })).rejects.toThrow("must be a boolean");
  });
});
