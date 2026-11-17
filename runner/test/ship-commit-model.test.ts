import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const calls: Array<{ model: unknown; thinkingLevel: unknown }> = [];
let emitProgress = false;
mock.module("@oh-my-pi/pi-coding-agent/commit/agentic/agent", () => ({
  runCommitAgentSession: async (input: {
    model: unknown;
    thinkingLevel: unknown;
  }) => {
    calls.push(input);
    if (emitProgress) {
      process.stdout.write("\x1b[");
      process.stdout.write("32mInspecting\x1b[0m ");
      const utf8 = Buffer.from("café\n");
      process.stdout.write(utf8.subarray(0, utf8.length - 2));
      process.stdout.write(utf8.subarray(utf8.length - 2));
      process.stdout.write("\x1b]0;hidden");
      process.stdout.write("\x07" + "x".repeat(700) + "\n");
    }
    return {
      proposal: {
        analysis: { type: "feat", scope: null, details: [], issueRefs: [] },
        summary: "add feature",
        warnings: [],
      },
    };
  },
}));
// Load the command after installing its agent mock; a static import runs too early.
const { gitCommands } = await import("../src/commands/git");

test("commit plan uses the configured commit model and thinking level", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keylime-commit-model-"));
  const previousFallback = process.env.PI_COMMIT_TEST_FALLBACK;
  try {
    delete process.env.PI_COMMIT_TEST_FALLBACK;
    const init = Bun.spawn(["git", "init"], {
      cwd,
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await init.exited).toBe(0);
    await Bun.write(
      path.join(cwd, "feature.ts"),
      "export function feature() { return 42; }\n",
    );
    const sessionModel = { provider: "test", id: "session", name: "Session" };
    const commitModel = { provider: "test", id: "commit", name: "Commit" };
    const session = {
      isStreaming: false,
      hasAdmittedSubmission: false,
      queuedMessageCount: 0,
      hasPendingAsyncWork: () => false,
      sessionManager: { getCwd: () => cwd },
      model: sessionModel,
      thinkingLevel: "low",
      settings: Settings.isolated({
        modelRoles: { commit: "test/commit:high" },
      }),
      modelRegistry: {
        getAvailable: () => [sessionModel, commitModel],
        getApiKey: async () => "test-key",
        resolver: () => () => Promise.resolve("test-key"),
        authStorage: {},
      },
    } as unknown as AgentSession;
    const frames: Array<{ t: string } & Record<string, unknown>> = [];
    emitProgress = true;
    const result = (await gitCommands.commit_plan(
      { session, send: (frame) => frames.push(frame) },
      { changelog: false, requestId: "plan-1" },
    )) as { plan: { usedFallback: boolean } };
    expect(result.plan.usedFallback).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(commitModel);
    expect(calls[0].thinkingLevel).toBe("high");
    const messages = frames.map((frame) => frame.message);
    expect(frames.every((frame) => frame.t === "commit_plan_progress" && frame.requestId === "plan-1")).toBe(true);
    expect(messages).toContain("Inspecting café");
    expect(messages).toContain("x".repeat(500));
    expect(messages.every((message) => typeof message === "string" && !/[\x00-\x1f\x7f-\x9f]/.test(message))).toBe(true);
    frames.length = 0;
    await gitCommands.commit_plan({ session, send: (frame) => frames.push(frame) }, { changelog: false });
    expect(frames).toHaveLength(0);
    await expect(gitCommands.commit_plan({ session, send: () => {} }, { requestId: 42 })).rejects.toThrow("requestId must be a string");
  } finally {
    emitProgress = false;
    if (previousFallback === undefined)
      delete process.env.PI_COMMIT_TEST_FALLBACK;
    else process.env.PI_COMMIT_TEST_FALLBACK = previousFallback;
    await rm(cwd, { recursive: true, force: true });
  }
});
