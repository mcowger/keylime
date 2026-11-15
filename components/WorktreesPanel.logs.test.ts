import "../tests/setup-dom.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";
import React from "react";
const { render, fireEvent, cleanup } =
  await import("@testing-library/react/pure.js");
const { WorktreesPanel } = await import("./WorktreesPanel");

test("View logs displays setup output and errors without opening creation", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.startsWith("/api/hierarchy"))
        return Response.json({
          projects: [
            {
              path: "/repo",
              kind: "git",
              workspaces: [
                {
                  id: "w",
                  name: "Feature",
                  path: "/repo/feature",
                  setup: { status: "failed", jobId: "j", error: "exit 1" },
                },
              ],
            },
          ],
        });
      if (path.includes("action=branches"))
        return Response.json({ local: [], remote: [], defaultRef: "main" });
      if (path.includes("action=status"))
        return Response.json({
          id: "j",
          status: "failed",
          stage: "postNonBlocking",
          error: "exit 1",
          logs: "$ setup\nfailed output",
        });
      throw new Error(`Unexpected request ${path}`);
    },
    { preconnect: original.preconnect },
  );
  try {
    const view = render(
      React.createElement(WorktreesPanel, {
        ctx: {
          hostId: "local",
          projectRoot: "/repo",
          currentPath: "/repo",
          worktrees: [],
          refresh() {},
          select() {},
        },
      }),
    );
    fireEvent.click(await view.findByRole("button", { name: "View logs" }));
    const logs = await view.findByRole("region", {
      name: "Workspace setup logs",
    });
    assert.match(
      logs.textContent ?? "",
      /failed \/ postNonBlocking[\s\S]*exit 1/,
    );
    assert.match(logs.textContent ?? "", /failed output/);
    assert.equal(
      view.queryByRole("dialog", { name: "Create workspace" }),
      null,
    );
    fireEvent.click(view.getByRole("button", { name: "Close logs" }));
    assert.equal(
      view.queryByRole("region", { name: "Workspace setup logs" }),
      null,
    );
  } finally {
    cleanup();
    globalThis.fetch = original;
  }
});
