import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const calls: Array<{ model: unknown; thinkingLevel: unknown }> = [];
mock.module("@oh-my-pi/pi-coding-agent/commit/agentic/agent", () => ({
  runCommitAgentSession: async (input: { model: unknown; thinkingLevel: unknown }) => {
    calls.push(input);
    return { proposal: { analysis: { type: "feat", scope: null, details: [], issueRefs: [] }, summary: "add feature", warnings: [] } };
  },
}));
// Load the command after installing its agent mock; a static import runs too early.
const { gitCommands } = await import("../src/commands/git");

test("commit plan uses the configured commit model and thinking level", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keylime-commit-model-"));
  const previousFallback = process.env.PI_COMMIT_TEST_FALLBACK;
  try {
    delete process.env.PI_COMMIT_TEST_FALLBACK;
    const init = Bun.spawn(["git", "init"], { cwd, stdout: "ignore", stderr: "pipe" });
    expect(await init.exited).toBe(0);
    await Bun.write(path.join(cwd, "feature.ts"), "export function feature() { return 42; }\n");
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
      settings: Settings.isolated({ modelRoles: { commit: "test/commit:high" } }),
      modelRegistry: {
        getAvailable: () => [sessionModel, commitModel],
        getApiKey: async () => "test-key",
        resolver: () => () => Promise.resolve("test-key"),
        authStorage: {},
      },
    } as unknown as AgentSession;
    const result = (await gitCommands.commit_plan({ session, send: () => {} }, { changelog: false })) as { plan: { usedFallback: boolean } };
    expect(result.plan.usedFallback).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(commitModel);
    expect(calls[0].thinkingLevel).toBe("high");
  } finally {
    if (previousFallback === undefined) delete process.env.PI_COMMIT_TEST_FALLBACK;
    else process.env.PI_COMMIT_TEST_FALLBACK = previousFallback;
    await rm(cwd, { recursive: true, force: true });
  }
});
