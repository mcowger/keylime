import { expect, mock, test } from "bun:test";

let naming: (signal: AbortSignal) => Promise<{ name: string; branch: string }>;
const created: unknown[] = [];
const workspaceOps = {
  hierarchy: async () => ({
    ok: true,
    value: { projects: [{ path: "/project", kind: "git" }] },
  }),
  workspaceBranches: async () => ({ ok: true, value: { defaultRef: "main" } }),
  createWorkspace: async (input: unknown) => {
    created.push(input);
    return { ok: true, value: { id: "job" } };
  },
};

mock.module("@/lib/api-utils", () => ({
  resolveWorkspaceHost: async () => ({ host: { workspaceOps } }),
  opErrorResponse: () => new Response(null, { status: 500 }),
  apiErrorResponse: () => new Response(null, { status: 500 }),
}));
mock.module("@/lib/workspace-prompt", () => ({
  workspacePromptNames: (_prompt: string, signal: AbortSignal) =>
    naming(signal),
}));

// The route must load after its host and naming dependencies are mocked.
const { POST } = await import("./route");

function prepare(signal?: AbortSignal) {
  return POST(
    new Request("http://localhost/api/worktrees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "prepare",
        input: { projectPath: "/project", prompt: "Fix sidebar" },
      }),
      signal,
    }),
  );
}

test("a naming failure creates a workspace with a unique safe branch", async () => {
  created.length = 0;
  naming = async () => {
    throw new Error("model unavailable");
  };
  expect((await prepare()).status).toBe(200);
  expect((await prepare()).status).toBe(200);
  const [first, second] = created as Array<{
    name: string;
    branch: string;
    baseRef: string;
    projectPath: string;
    mode: string;
  }>;
  expect(first).toMatchObject({
    name: "Workspace",
    projectPath: "/project",
    baseRef: "main",
    mode: "new",
  });
  expect(first.branch).toMatch(/^workspace-[0-9a-f]{8}$/);
  expect(second.branch).not.toBe(first.branch);
});

test("a cancelled naming request never starts workspace creation", async () => {
  created.length = 0;
  const controller = new AbortController();
  naming = async () => {
    controller.abort();
    throw new DOMException("Cancelled", "AbortError");
  };
  const response = await prepare(controller.signal);
  expect(response.status).toBe(499);
  expect(created).toEqual([]);
});

test("a cancellation after a successful naming response never starts creation", async () => {
  created.length = 0;
  const controller = new AbortController();
  naming = async () => {
    controller.abort();
    return { name: "Sidebar", branch: "sidebar-12345678" };
  };
  expect((await prepare(controller.signal)).status).toBe(499);
  expect(created).toEqual([]);
});
