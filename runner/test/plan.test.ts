import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { resolvePlanFilePath } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import { createTestSession, startHost, type Frame, type TestHost, type TestSession } from "./harness";

let host: TestHost | undefined;
let test: TestSession | undefined;

afterEach(async () => {
  await test?.dispose();
  host?.close();
  test = undefined;
  host = undefined;
});

function proposalOf(frame: Frame): { id: string; content: string } | undefined {
  const event = frame.event;
  if (frame.t !== "event" || typeof event !== "object" || event === null || !("type" in event) || event.type !== "plan_state_changed" || !("proposal" in event)) return undefined;
  const proposal = event.proposal;
  if (typeof proposal !== "object" || proposal === null || !("id" in proposal) || typeof proposal.id !== "string" || !("content" in proposal) || typeof proposal.content !== "string") return undefined;
  return { id: proposal.id, content: proposal.content };
}

function planEvent(frame: Frame): boolean {
  return proposalOf(frame) !== undefined;
}

const tools = ["read", "grep", "glob", "write", "edit", "bash", "eval"];

function reasoningModel(id: string) {
  return Object.assign(createMockModel({ id, reasoning: true }), {
    thinking: { mode: "effort", efforts: ["low", "high"] } as NonNullable<Model["thinking"]>,
  });
}

describe("runner plan mode", () => {
  it("keeps the native toolset, validates a proposal, and supports revision and approval", async () => {
    host = await startHost();
    test = await createTestSession({
      toolNames: tools,
      responses: [
        { content: [{ type: "toolCall", name: "write", arguments: { path: "local://feature-plan.md", content: "# Feature\n\nImplement the feature." } }] },
        { content: [{ type: "toolCall", name: "write", arguments: { path: "xd://propose", content: "feature" } }] },
        { content: [{ type: "toolCall", name: "write", arguments: { path: "xd://propose", content: "feature" } }] },
        { content: ["implementation started"] },
      ],
    });
    await host.connected;
    expect(await host.command("set_plan_mode", { enabled: true })).toMatchObject({ ok: true, data: { enabled: true } });
    expect(test.session.getEnabledToolNames()).toContain("bash");
    expect(test.session.getEnabledToolNames()).toContain("eval");
    expect(await host.command("set_host_tools", { tools: [] })).toMatchObject({ ok: true });
    expect(await host.command("prompt", { message: "Plan the feature" })).toMatchObject({ ok: true });
    const firstFrame = await host.waitFor(planEvent);
    const first = proposalOf(firstFrame)!;
    expect(first.content).toContain("Implement the feature");
    expect(await host.command("respond_plan_proposal", { id: "stale", approved: true })).toMatchObject({ ok: false });
    expect(await host.command("respond_plan_proposal", { id: first.id, approved: false, feedback: "Add tests" })).toMatchObject({ ok: true, data: { enabled: true } });
    const secondFrame = await host.waitFor((frame) => {
      const proposal = proposalOf(frame);
      return proposal !== undefined && proposal.id !== first.id;
    });
    const second = proposalOf(secondFrame)!;
    expect(JSON.stringify(test.session.messages)).toContain("Add tests");
    expect(await host.command("respond_plan_proposal", { id: second.id, approved: true })).toMatchObject({ ok: true, data: { enabled: false } });
    expect(test.session.getEnabledToolNames()).toContain("bash");
  });

  it("restores the previous model and effort before the first approved implementation inference", async () => {
    host = await startHost();
    test = await createTestSession({
      toolNames: tools,
      responses: [
        { content: [{ type: "toolCall", name: "write", arguments: { path: "local://feature-plan.md", content: "# Feature\n\nImplement the feature." } }] },
        { content: [{ type: "toolCall", name: "write", arguments: { path: "xd://propose", content: "feature" } }] },
        { content: ["implementation started"] },
      ],
    });
    await host.connected;
    const session = test.session;
    const previousModel = reasoningModel("pre-plan");
    const planModel = reasoningModel("plan-model");
    await session.setModelTemporary(previousModel, "low");
    spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({ model: planModel, thinkingLevel: "high", explicitThinkingLevel: true, warning: undefined });
    const calls: Array<{ model: string; reasoning: string | undefined }> = [];
    const stream = session.agent.streamFn!;
    session.agent.streamFn = (model, context, options) => {
      calls.push({ model: model.id, reasoning: options?.reasoning });
      return stream(model, context, options);
    };
    expect(await host.command("set_plan_mode", { enabled: true })).toMatchObject({ ok: true });
    expect(await host.command("prompt", { message: "Plan the feature" })).toMatchObject({ ok: true });
    const proposal = proposalOf(await host.waitFor(planEvent))!;
    expect(calls.at(-1)).toEqual({ model: "plan-model", reasoning: "high" });
    const planningCalls = calls.length;
    expect(await host.command("respond_plan_proposal", { id: proposal.id, approved: true })).toMatchObject({ ok: true, data: { enabled: false } });
    await host.waitFor((frame) => frame.t === "event" && JSON.stringify(frame.event).includes("implementation started"));
    expect(calls[planningCalls]).toEqual({ model: "pre-plan", reasoning: "low" });
    expect(JSON.stringify(test.mock.calls[planningCalls]?.context.messages)).toContain("Implement the feature.");
  });

  it("enters Plan during a running turn and switches models after that turn", async () => {
    host = await startHost();
    test = await createTestSession({
      toolNames: tools,
      responses: [{ content: ["first turn"], delayMs: 500 }, { content: ["plan context received"] }],
    });
    await host.connected;
    const session = test.session;
    const previousModel = reasoningModel("pre-plan");
    const planModel = reasoningModel("plan-model");
    await session.setModelTemporary(previousModel, "low");
    spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({ model: planModel, thinkingLevel: "high", explicitThinkingLevel: true, warning: undefined });
    expect(await host.command("prompt", { message: "Explore" })).toMatchObject({ ok: true });
    expect(await host.command("set_plan_mode", { enabled: true })).toMatchObject({ ok: true, data: { enabled: true } });
    expect(session.model?.id).toBe("pre-plan");
    await host.waitFor((frame) => frame.t === "event" && session.model?.id === "plan-model");
    expect(session.configuredThinkingLevel()).toBe("high");
  });

  it("does not apply a deferred Plan model after manually leaving a running turn", async () => {
    host = await startHost();
    test = await createTestSession({ toolNames: tools, responses: [{ content: ["first turn"], delayMs: 1000 }] });
    await host.connected;
    const session = test.session;
    const previousModel = reasoningModel("pre-plan");
    const planModel = reasoningModel("plan-model");
    await session.setModelTemporary(previousModel, "low");
    spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({ model: planModel, thinkingLevel: "high", explicitThinkingLevel: true, warning: undefined });
    expect(await host.command("prompt", { message: "Explore" })).toMatchObject({ ok: true });
    expect(await host.command("set_plan_mode", { enabled: true })).toMatchObject({ ok: true, data: { enabled: true } });
    expect(await host.command("set_plan_mode", { enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
    await host.command("get_plan_state");
    expect(session.model?.id).toBe("pre-plan");
    expect(session.configuredThinkingLevel()).toBe("low");
  });

  it("uses the native write guard and restores the pre-plan thinking level on manual exit", async () => {
    host = await startHost();
    test = await createTestSession({ toolNames: tools });
    await host.connected;
    const session = test.session;
    const model = reasoningModel("pre-plan");
    await session.setModelTemporary(model, "low");
    expect(session.model?.id).toBe(model.id);
    expect(session.configuredThinkingLevel()).toBe("low");
    spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({ model, thinkingLevel: "high", explicitThinkingLevel: true, warning: undefined });
    expect(await host.command("set_plan_mode", { enabled: true })).toMatchObject({ ok: true });
    expect(session.configuredThinkingLevel()).toBe("high");
    const write = session.agent.state.tools.find((tool) => tool.name === "write");
    expect(write).toBeDefined();
    const target = path.join(session.sessionManager.getCwd(), "forbidden.txt");
    await expect(write!.execute("test", { path: target, content: "no" })).rejects.toThrow("read-only");
    expect(fs.existsSync(target)).toBe(false);
    expect(await host.command("set_plan_mode", { enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
    expect(session.model?.id).toBe(model.id);
    expect(session.configuredThinkingLevel()).toBe("low");
  });

  it.each(["low", undefined] as const)("restores the previous model and %s thinking after a plan model switch", async (initialThinking) => {
    host = await startHost();
    test = await createTestSession({ toolNames: tools });
    await host.connected;
    const session = test.session;
    const previousModel = reasoningModel("pre-plan");
    const planModel = reasoningModel("plan-model");
    await session.setModelTemporary(previousModel);
    session.setThinkingLevel(initialThinking);
    expect(session.model?.id).toBe(previousModel.id);
    expect(session.configuredThinkingLevel()).toBe(initialThinking);
    spyOn(session, "resolveRoleModelWithThinking").mockReturnValue({ model: planModel, thinkingLevel: "high", explicitThinkingLevel: true, warning: undefined });
    expect(await host.command("set_plan_mode", { enabled: true })).toMatchObject({ ok: true });
    expect(session.model?.id).toBe(planModel.id);
    expect(session.configuredThinkingLevel()).toBe("high");
    expect(await host.command("set_plan_mode", { enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
    expect(session.model?.id).toBe(previousModel.id);
    expect(session.configuredThinkingLevel()).toBe(initialThinking);
  });

  it("does not take over a native terminal-owned plan", async () => {
    host = await startHost();
    test = await createTestSession({ toolNames: tools });
    const session = test.session;
    const nativeState = { enabled: true, planFilePath: "local://native-plan.md", workflow: "parallel" as const, reentry: false };
    session.setPlanModeState(nativeState);
    const handler = async () => ({ content: [{ type: "text" as const, text: "terminal review" }], details: {} });
    session.setPlanProposalHandler(handler);
    const installedHandler = session.peekPlanProposalHandler();
    await host.connected;
    expect(await host.command("get_plan_state")).toMatchObject({ ok: true, data: { enabled: true } });
    expect(await host.command("set_plan_mode", { enabled: false })).toMatchObject({ ok: false });
    expect(session.getPlanModeState()).toBe(nativeState);
    expect(session.peekPlanProposalHandler()).toBe(installedHandler);
  });

  it("recovers plan mode and artifact without reviving a stale review", async () => {
    host = await startHost();
    test = await createTestSession({ toolNames: tools });
    const session = test.session;
    const planPath = resolvePlanFilePath("local://feature-plan.md", { localProtocolOptions: { getArtifactsDir: () => session.sessionManager.getArtifactsDir(), getSessionId: () => session.sessionManager.getSessionId() }, cwd: session.sessionManager.getCwd() });
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "# Feature");
    session.sessionManager.appendModeChange("plan", {
      planFilePath: "local://feature-plan.md",
      previousTools: session.getEnabledToolNames(),
      previousMountedTools: session.getMountedXdevToolNames(),
      keylimeProposal: { id: "saved", title: "feature", content: "# Feature", planFilePath: "local://feature-plan.md" },
    });
    await host.connected;
    const recovered = await host.command("get_plan_state");
    expect(recovered.ok).toBe(true);
    expect(recovered.data).toEqual({ enabled: true });
    expect(session.getPlanModeState()?.planFilePath).toBe("local://feature-plan.md");
    expect(fs.readFileSync(planPath, "utf8")).toBe("# Feature");
    expect(session.getEnabledToolNames()).toContain("bash");
    expect(await host.command("respond_plan_proposal", { id: "saved", approved: true })).toMatchObject({ ok: false });
    expect(await host.command("set_plan_mode", { enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
    expect(session.getEnabledToolNames()).toContain("bash");
  });
});
