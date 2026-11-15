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
        issues: [],
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
        onAskAgentToResolve: async () => {},
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

test("preflight issues prevent commit planning and can be sent to the agent", async () => {
  const originalFetch = globalThis.fetch;
  const commands = [];
  const messages = [];
  let closed = false;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("/api/agent/")) {
      commands.push(JSON.parse(init.body));
      throw new Error("Unexpected agent command");
    }
    return Response.json({
      branch: "work", base: "main", baseCheckout: "/repo", ahead: 1, behind: 1,
      dirty: true, baseDirty: false, issues: ["Unresolved conflicts: file"],
      github: { repo: null, gh: "missing" }, pr: null,
    });
  };
  try {
    const view = render(React.createElement(ShipDialog, {
      open: true, onOpenChange: (open) => { closed = !open; }, host: "local",
      projectPath: "/repo", path: "/work", sessionId: "session",
      onAskAgentToResolve: async (message) => { messages.push(message); },
    }));
    await view.findByText("Unresolved conflicts: file");
    assert.deepEqual(commands, []);
    assert.equal(view.getByRole("button", { name: "Ship" }).disabled, true);
    fireEvent.click(view.getByRole("button", { name: "Ask agent to resolve" }));
    await waitFor(() => assert.equal(closed, true));
    assert.match(messages[0], /Unresolved conflicts: file/);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("agent submission failure keeps the dialog open and reports the error", async () => {
  const originalFetch = globalThis.fetch;
  let closed = false;
  globalThis.fetch = async () => Response.json({
    branch: "work", base: "main", baseCheckout: "/repo", ahead: 0, behind: 0,
    dirty: true, baseDirty: false, issues: ["Unresolved conflicts: file"],
    github: { repo: null, gh: "missing" }, pr: null,
  });
  try {
    const view = render(React.createElement(ShipDialog, {
      open: true, onOpenChange: () => { closed = true; }, host: "local",
      projectPath: "/repo", path: "/work", sessionId: "session",
      onAskAgentToResolve: async () => { throw new Error("Send failed"); },
    }));
    fireEvent.click(await view.findByRole("button", { name: "Ask agent to resolve" }));
    await view.findByText("Send failed");
    assert.equal(closed, false);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("agent resolution submission cannot be sent twice while pending", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  globalThis.fetch = async () => Response.json({
    branch: "work", base: "main", baseCheckout: "/repo", ahead: 0, behind: 0,
    dirty: true, baseDirty: false, issues: ["Unresolved conflicts: file"],
    github: { repo: null, gh: "missing" }, pr: null,
  });
  try {
    const view = render(React.createElement(ShipDialog, {
      open: true, onOpenChange() {}, host: "local", projectPath: "/repo",
      path: "/work", sessionId: "session",
      onAskAgentToResolve: () => { calls++; return pending; },
    }));
    const button = await view.findByRole("button", { name: "Ask agent to resolve" });
    fireEvent.click(button);
    fireEvent.click(button);
    assert.equal(calls, 1);
    assert.equal(button.disabled, true);
    finish();
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});
