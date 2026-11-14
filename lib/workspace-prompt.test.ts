import { test, expect, mock } from "bun:test";

let reply: unknown = {
  choices: [
    {
      message: {
        content: JSON.stringify({ name: "Fix sidebar", branch: "fix sidebar" }),
      },
    },
  ],
};
let requestedModel: unknown;
mock.module("./omp/auth-gateway", () => ({
  authGatewayRequest: async (_path: string, body: { model: unknown }) => {
    requestedModel = body.model;
    return { status: 200, body: reply };
  },
}));
// Load after the gateway mock so this test never starts a real credential process.
const { workspacePromptNames } = await import("./workspace-prompt");

test("workspace names use smol and produce a safe collision-resistant branch", async () => {
  const result = await workspacePromptNames(
    "Fix the sidebar",
    new AbortController().signal,
  );
  expect(requestedModel).toBe("@smol");
  expect(result.name).toBe("Fix sidebar");
  expect(result.branch).toMatch(/^fix-sidebar-[0-9a-f]{8}$/);
});

test("invalid model output cannot supply workspace creation names", async () => {
  reply = { choices: [{ message: { content: "not JSON" } }] };
  await expect(
    workspacePromptNames("Fix the sidebar", new AbortController().signal),
  ).rejects.toThrow("Invalid workspace naming response");
});
