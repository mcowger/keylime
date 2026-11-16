import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
const { render, cleanup, fireEvent, waitFor } =
  await import("@testing-library/react/pure.js");
const { ShipDialog } = await import("./ShipDialog.tsx");
type Command = {
  type: string;
  plan: { commits: { message: string }[] };
  plannedMessages: string[];
};

test("PR lookup failure warns but leaves all paths available", async () => {
  const originalFetch = globalThis.fetch;
  const commands: string[] = [];
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      if (String(url).startsWith("/api/ship?"))
        return Response.json({
          branch: "work",
          base: "main",
          baseCheckout: "/repo",
          ahead: 1,
          behind: 0,
          dirty: false,
          baseDirty: false,
          issues: [],
          pr: null,
          github: {
            repo: "owner/repo",
            gh: "ok",
            prLookupError: "Pull request lookup failed: rate limit exceeded",
          },
        });
      const command = JSON.parse(String(init.body)) as Command;
      commands.push(command.type);
      return Response.json({
        success: true,
        data:
          command.type === "commit_plan"
            ? { plan: null }
            : { title: "Feature", body: "Details" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
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
    await view.findByText(/Pull request lookup failed: rate limit exceeded/);
    assert.equal(
      (view.getByRole("radio", { name: /Open PR/ }) as HTMLInputElement)
        .disabled,
      false,
    );
    assert.equal(
      (
        view.getByRole("radio", {
          name: /PR \+ auto-merge/,
        }) as HTMLInputElement
      ).disabled,
      false,
    );
    assert.equal(
      (view.getByRole("radio", { name: /Land locally/ }) as HTMLInputElement)
        .disabled,
      false,
    );
    assert.equal(
      (view.getByRole("button", { name: "Ship" }) as HTMLButtonElement)
        .disabled,
      false,
    );
    assert.deepEqual(commands, ["commit_plan"]);
    fireEvent.click(view.getByRole("radio", { name: /PR \+ auto-merge/ }));
    await view.findByLabelText("PR description");
    assert.equal(
      (view.getByRole("button", { name: "Ship" }) as HTMLButtonElement)
        .disabled,
      false,
    );
    assert.deepEqual(commands, ["commit_plan", "generate_pr_description"]);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("ship loads a plan and submits edited commit messages", async () => {
  const originalFetch = globalThis.fetch;
  const commands: Command[] = [];
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const path = String(url);
      if (path.startsWith("/api/agent/")) {
        const command = JSON.parse(String(init.body)) as Command;
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
    },
    { preconnect: originalFetch.preconnect },
  );
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
      commands.find((command) => command.type === "commit_apply")!.plan
        .commits[0].message,
      "Edited",
    );
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("PR generation waits for the commit plan when the base is dirty", async () => {
  const originalFetch = globalThis.fetch;
  const commands: Command[] = [];
  const { promise: pendingPlan, resolve: finishPlan } =
    Promise.withResolvers<Response>();
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      if (String(url).startsWith("/api/ship?"))
        return Response.json({
          branch: "work",
          base: "main",
          ahead: 0,
          behind: 0,
          dirty: true,
          baseDirty: true,
          issues: [],
          github: { repo: "owner/repo", gh: "ok" },
        });
      const command = JSON.parse(String(init.body)) as Command;
      commands.push(command);
      if (command.type === "commit_plan") return pendingPlan;
      if (command.type === "generate_pr_description")
        return Response.json({
          success: true,
          data: { title: "Add feature", body: "Changes" },
        });
      throw new Error(`Unexpected command ${command.type}`);
    },
    { preconnect: originalFetch.preconnect },
  );
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
    await waitFor(() => assert.equal(commands.length, 1));
    assert.equal(commands[0].type, "commit_plan");
    const ship = view.getByRole("button", { name: "Ship" }) as HTMLButtonElement;
    assert.equal(ship.disabled, true);
    assert.equal(ship.style.opacity, "0.5");
    finishPlan(
      Response.json({
        success: true,
        data: {
          plan: {
            kind: "single",
            commits: [{ message: "Add feature", files: ["feature.txt"] }],
            changelog: [],
            warnings: [],
            usedFallback: false,
          },
        },
      }),
    );
    await view.findByLabelText("PR description");
    assert.deepEqual(commands[1].plannedMessages, ["Add feature"]);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("an existing open PR disables Open PR and can be auto-merged without a description", async () => {
  const originalFetch = globalThis.fetch;
  const commands: string[] = [];
  let submitted: Record<string, unknown> | undefined;
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const path = String(url);
      if (path.startsWith("/api/ship?"))
        return Response.json({
          branch: "work",
          base: "main",
          baseCheckout: "/repo",
          ahead: 0,
          behind: 0,
          dirty: false,
          baseDirty: true,
          issues: [],
          github: { repo: "owner/repo", gh: "ok" },
          pr: {
            number: 42,
            url: "https://github.com/owner/repo/pull/42",
            state: "open",
            checks: "none",
            autoMerge: false,
            cleanup: false,
            checkedAt: "2026-01-01T00:00:00Z",
          },
        });
      if (path.startsWith("/api/agent/")) {
        const command = JSON.parse(String(init.body)) as Command;
        commands.push(command.type);
        if (command.type === "commit_plan")
          return Response.json({ success: true, data: { plan: null } });
        throw new Error(`Unexpected command ${command.type}`);
      }
      if (path === "/api/ship") {
        submitted = JSON.parse(String(init.body)).input;
        return Response.json({
          id: "job",
          status: "failed",
          steps: [],
          error: "Stopped",
          logs: "",
        });
      }
      throw new Error(`Unexpected request ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );
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
    const openPr = (await view.findByRole("radio", {
      name: /Open PR/,
    })) as HTMLInputElement;
    const autoMerge = view.getByRole("radio", {
      name: "PR + auto-merge",
    }) as HTMLInputElement;
    assert.equal(openPr.disabled, true);
    assert.equal(autoMerge.disabled, false);
    assert.equal(autoMerge.checked, true);
    assert.equal(view.queryByLabelText("PR description"), null);
    fireEvent.click(view.getByRole("button", { name: "Ship" }));
    await waitFor(() => assert.ok(submitted));
    assert.equal(submitted!.mode, "pr-auto");
    assert.equal("pr" in submitted!, false);
    assert.deepEqual(commands, ["commit_plan"]);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("a closed PR does not disable Open PR", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).startsWith("/api/ship?"))
        return Response.json({
          branch: "work",
          base: "main",
          baseCheckout: "/repo",
          ahead: 1,
          behind: 0,
          dirty: false,
          baseDirty: false,
          issues: [],
          github: { repo: "owner/repo", gh: "ok" },
          pr: {
            number: 42,
            url: "https://github.com/owner/repo/pull/42",
            state: "closed",
            checks: "none",
            autoMerge: false,
            cleanup: false,
            checkedAt: "2026-01-01T00:00:00Z",
          },
        });
      return Response.json({ success: true, data: { plan: null } });
    },
    { preconnect: originalFetch.preconnect },
  );
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
    const openPr = (await view.findByRole("radio", {
      name: "Open PR",
    })) as HTMLInputElement;
    assert.equal(openPr.disabled, false);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("preflight issues prevent commit planning and can be sent to the agent", async () => {
  const originalFetch = globalThis.fetch;
  const commands: unknown[] = [];
  const messages: string[] = [];
  let closed = false;
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      if (String(url).startsWith("/api/agent/")) {
        commands.push(JSON.parse(String(init.body)));
        throw new Error("Unexpected agent command");
      }
      return Response.json({
        branch: "work",
        base: "main",
        baseCheckout: "/repo",
        ahead: 1,
        behind: 1,
        dirty: true,
        baseDirty: false,
        issues: ["Unresolved conflicts: file"],
        github: { repo: null, gh: "missing" },
        pr: null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const view = render(
      React.createElement(ShipDialog, {
        open: true,
        onOpenChange: (open) => {
          closed = !open;
        },
        host: "local",
        projectPath: "/repo",
        path: "/work",
        sessionId: "session",
        onAskAgentToResolve: async (message) => {
          messages.push(message);
        },
      }),
    );
    await view.findByText("Unresolved conflicts: file");
    assert.deepEqual(commands, []);
    assert.equal(
      (view.getByRole("button", { name: "Ship" }) as HTMLButtonElement)
        .disabled,
      true,
    );
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
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        branch: "work",
        base: "main",
        baseCheckout: "/repo",
        ahead: 0,
        behind: 0,
        dirty: true,
        baseDirty: false,
        issues: ["Unresolved conflicts: file"],
        github: { repo: null, gh: "missing" },
        pr: null,
      }),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const view = render(
      React.createElement(ShipDialog, {
        open: true,
        onOpenChange: () => {
          closed = true;
        },
        host: "local",
        projectPath: "/repo",
        path: "/work",
        sessionId: "session",
        onAskAgentToResolve: async () => {
          throw new Error("Send failed");
        },
      }),
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Ask agent to resolve" }),
    );
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
  const { promise: pending, resolve: finish } = Promise.withResolvers<void>();
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        branch: "work",
        base: "main",
        baseCheckout: "/repo",
        ahead: 0,
        behind: 0,
        dirty: true,
        baseDirty: false,
        issues: ["Unresolved conflicts: file"],
        github: { repo: null, gh: "missing" },
        pr: null,
      }),
    { preconnect: originalFetch.preconnect },
  );
  try {
    const view = render(
      React.createElement(ShipDialog, {
        open: true,
        onOpenChange() {},
        host: "local",
        projectPath: "/repo",
        path: "/work",
        sessionId: "session",
        onAskAgentToResolve: () => {
          calls++;
          return pending;
        },
      }),
    );
    const button = (await view.findByRole("button", {
      name: "Ask agent to resolve",
    })) as HTMLButtonElement;
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
