import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";
const { render, cleanup, waitFor } =
  await import("@testing-library/react/pure.js");
const { GitChangesPanel } = await import("./GitChangesPanel.tsx");
const { WorktreesPanel } = await import("./WorktreesPanel.tsx");
const original = {
  fetch: globalThis.fetch,
  Worker: globalThis.Worker,
  SharedWorker: globalThis.SharedWorker,
};
afterEach(() => {
  cleanup();
  Object.assign(globalThis, original);
  delete window.matchMedia;
});
const advice =
  "Upgrade the linked Beta host daemon before using this workspace feature";
function setup() {
  globalThis.Worker = class {
    postMessage() {}
  };
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (
      url.pathname.startsWith("/api/git/") ||
      url.pathname === "/api/worktrees"
    )
      return Response.json(
        { error: advice, code: "workspace_unsupported" },
        { status: 501 },
      );
    if (url.pathname === "/api/hierarchy")
      return Response.json({
        projects: [{ path: "/same", kind: "git", workspaces: [] }],
      });
    if (url.pathname === "/api/projects")
      return Response.json({ projects: [{ path: "/same", hostId: "remote" }] });
    if (url.pathname === "/api/sessions")
      return Response.json({ sessions: [] });
    return Response.json({});
  };
}

test("Git preserves an older daemon's actionable upgrade explanation", async () => {
  setup();
  const view = render(
    React.createElement(GitChangesPanel, {
      cwd: "/same",
      hostId: "remote",
      onOpenFile() {},
    }),
  );
  await waitFor(() => assert.ok(view.container.textContent.includes(advice)));
});

test("workspace creation shows an older daemon's upgrade explanation", async () => {
  setup();
  const view = render(
    React.createElement(WorktreesPanel, {
      ctx: {
        hostId: "remote",
        projectRoot: "/same",
        currentPath: "/same",
        worktrees: [],
        select() {},
        refresh() {},
      },
      createOnly: true,
      createOpen: true,
      onCreateOpenChange() {},
    }),
  );
  await waitFor(() => assert.ok(view.baseElement.textContent.includes(advice)));
  assert.ok(
    view
      .getByRole("dialog", { name: "Create workspace" })
      .textContent.includes(advice),
  );
});
