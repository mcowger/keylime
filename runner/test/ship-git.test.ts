import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { gitCommands } from "../src/commands/git";
import type { CommandContext } from "../src/commands/types";

let directory: string | undefined;
const previousFallback = process.env.PI_COMMIT_TEST_FALLBACK;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  if (previousFallback === undefined)
    delete process.env.PI_COMMIT_TEST_FALLBACK;
  else process.env.PI_COMMIT_TEST_FALLBACK = previousFallback;
});

test("fallback plan creates a commit in a scratch repository", async () => {
  directory = await mkdtemp(path.join(tmpdir(), "keylime-ship-"));
  const cwd = directory;
  for (const args of [
    ["init"],
    ["config", "user.email", "ship@example.test"],
    ["config", "user.name", "Ship Test"],
  ]) {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
  }
  await Bun.write(path.join(cwd, "file.txt"), "new content\n");
  process.env.PI_COMMIT_TEST_FALLBACK = "true";
  const session = {
    isStreaming: false,
    hasAdmittedSubmission: false,
    queuedMessageCount: 0,
    hasPendingAsyncWork: () => false,
    sessionManager: { getCwd: () => cwd },
  } as unknown as AgentSession;
  const ctx: CommandContext = { session, send: () => {} };
  const result = (await gitCommands.commit_plan(ctx, { changelog: false })) as {
    plan: { usedFallback: boolean };
  };
  expect(result.plan.usedFallback).toBe(true);
  const applied = (await gitCommands.commit_apply(ctx, {
    plan: result.plan,
  })) as { commits: Array<{ sha: string }> };
  expect(applied.commits).toHaveLength(1);
  expect(applied.commits[0].sha).toBeTruthy();
});
