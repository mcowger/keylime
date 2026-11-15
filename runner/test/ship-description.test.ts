import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CommandContext } from "../src/commands/types";

let prompt = "";
mock.module("@oh-my-pi/pi-ai", () => ({
  completeSimple: async (
    _model: unknown,
    input: { messages: Array<{ content: string }> },
  ) => {
    prompt = input.messages[0].content;
    return {
      content: [
        {
          type: "text",
          text: '{"title":"feat: add file","body":"Added file"}',
        },
      ],
      stopReason: "stop",
    };
  },
}));
// Load after the completion mock is installed.
const { gitCommands } = await import("../src/commands/git");

test("describes staged changes with no branch commits", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ship-description-"));
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(err);
  };
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "ship@example.test");
    await git("config", "user.name", "Ship Test");
    await git("commit", "--allow-empty", "-m", "base");
    await git("checkout", "-b", "work");
    await Bun.write(path.join(cwd, "feature.txt"), "new feature\n");
    await git("add", "feature.txt");
    const model = { provider: "test", id: "commit", name: "Commit" };
    const session = {
      sessionManager: { getCwd: () => cwd, getBranch: () => [] },
      settings: Settings.isolated({ modelRoles: { commit: "test/commit" } }),
      modelRegistry: {
        getAvailable: () => [model],
        getApiKey: async () => "key",
        resolver: () => () => Promise.resolve("key"),
        authStorage: {},
      },
    };
    const ctx = { session, send: () => {} } as unknown as CommandContext; // Minimal session fixture.
    const result = await gitCommands.generate_pr_description(ctx, {
      base: "main",
      plannedMessages: ["feat: add file"],
    });
    expect(result).toEqual({ title: "feat: add file", body: "Added file" });
    expect(prompt).toContain("+new feature");
    expect(prompt).toContain("feat: add file");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
