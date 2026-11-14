import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
const { render, cleanup, fireEvent, waitFor } =
  await import("@testing-library/react/pure.js");
const { ShipDialog } = await import("./ShipDialog.tsx");

test("ship loads a plan and submits edited commit messages", async () => {
  const originalFetch = globalThis.fetch;
  const commands = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.startsWith("/api/agent/")) {
      const command = JSON.parse(init.body);
      commands.push(command);
      return Response.json({
        success: true,
        data:
          command.type === "commit_plan"
            ? {
                plan: {
                  kind: "single",
                  commits: [{ message: "Original", files: ["file.ts"] }],
                  changelog: [],
                  warnings: [],
                  usedFallback: false,
                },
              }
            : { commits: [], changelogFiles: [] },
      });
    }
    if (path.startsWith("/api/ship?"))
      return Response.json({
        branch: "work",
        base: "main",
        baseCheckout: "/repo",
        ahead: 0,
        behind: 1,
        dirty: true,
        baseDirty: false,
        github: { repo: null, gh: "missing" },
        pr: null,
      });
    if (path === "/api/ship")
      return Response.json({
        id: "job",
        kind: "ship",
        projectPath: "/repo",
        path: "/work",
        status: "conflict",
        steps: [],
        logs: "",
        conflictFiles: ["file.ts"],
      });
    throw new Error(`Unexpected request ${path}`);
  };
  try {
    const view = render(
      React.createElement(ShipDialog, {
        open: true,
        onOpenChange() {},
        host: "local",
        projectPath: "/repo",
        path: "/work",
        sessionId: "session",
      }),
    );
    const message = await view.findByLabelText("Commit 1 message");
    fireEvent.change(message, { target: { value: "Edited" } });
    fireEvent.click(view.getByRole("button", { name: "Ship" }));
    await waitFor(() =>
      assert.ok(view.getByRole("button", { name: "Ask agent to resolve" })),
    );
    assert.equal(
      commands.find((command) => command.type === "commit_apply").plan
        .commits[0].message,
      "Edited",
    );
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});
