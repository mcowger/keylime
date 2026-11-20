import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { mock } from "bun:test";
import type { EventStream, EventStreamChannel } from "@/lib/event-stream";
const transport = await import("@/lib/event-stream");
const streams: EventStream[] = [];
let autoOpenStream = true;
mock.module("@/lib/event-stream", () => ({
  ...transport,
  openEventStream(channel: EventStreamChannel) {
    const stream: EventStream = {
      channel,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      close() { Object.assign(this, { readyState: 2 }); },
    };
    streams.push(stream);
    if (autoOpenStream) queueMicrotask(() => {
      if (stream.readyState !== 0) return;
      Object.assign(stream, { readyState: 1 });
      stream.onopen?.();
    });
    return stream;
  },
}));
// Load the real client before replacing the module so other commands use its transport.
const agentClient = await import("@/lib/agent-client");
const sendAgentCommand = agentClient.sendAgentCommand;
mock.module("@/lib/agent-client", () => ({
  ...agentClient,
  sendAgentCommand: (sessionId: string, command: Record<string, unknown>) =>
    command.type === "get_state" ? Promise.resolve({}) : sendAgentCommand(sessionId, command),
}));
const { render, cleanup, fireEvent, waitFor, act } =
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

test("ship shows complete hook output and retries with the edited commit message", async () => {
  const originalFetch = globalThis.fetch;
  const commands: Command[] = [];
  const hookError = `Pre-commit hook failed\n${"Checking staged changes\n".repeat(100)}Typecheck failed`;
  let failCommit = true;
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const path = String(url);
      if (path.startsWith("/api/agent/")) {
        const command = JSON.parse(String(init.body)) as Command;
        commands.push(command);
        if (command.type === "commit_apply" && failCommit) {
          failCommit = false;
          return Response.json({ error: hookError }, { status: 500 });
        }
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
    const details = await view.findByRole("region", { name: "Ship error details" });
    assert.equal(details.textContent, hookError);
    details.focus();
    assert.equal(document.activeElement, details);
    fireEvent.click(view.getByRole("button", { name: "Ship" }));
    await waitFor(() =>
      assert.ok(view.getByRole("button", { name: "Ask agent to resolve" })),
    );
    assert.deepEqual(
      commands.filter((command) => command.type === "commit_apply")
        .map((command) => command.plan.commits[0].message),
      ["Edited", "Edited"],
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

test("hidden preparation completes once and preserves edits on reveal", async () => {
  const originalFetch = globalThis.fetch;
  const { promise: pendingPlan, resolve: finishPlan } = Promise.withResolvers<Response>();
  const commands: string[] = [];
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      if (String(url).startsWith("/api/ship?"))
        return Response.json({
          branch: "work", base: "main", ahead: 0, behind: 0, dirty: true,
          baseDirty: true, issues: [], github: { repo: "owner/repo", gh: "ok" },
        });
      assert.match(String(url), /session/);
      const command = JSON.parse(String(init.body)) as Command;
      commands.push(command.type);
      if (command.type === "commit_plan") return pendingPlan;
      if (command.type === "generate_pr_description")
        return Response.json({ success: true, data: { title: "Title", body: "Body" } });
      throw new Error(`Unexpected command ${command.type}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const props = {
    open: true, onOpenChange() {}, host: "local", projectPath: "/repo",
    path: "/work", sessionId: "session", onAskAgentToResolve: async () => {},
  };
  try {
    const view = render(React.createElement(ShipDialog, props));
    await waitFor(() => assert.deepEqual(commands, ["commit_plan"]));
    view.rerender(React.createElement(ShipDialog, { ...props, visible: false }));
    assert.equal(view.queryByRole("dialog"), null);
    finishPlan(Response.json({ success: true, data: { plan: {
      kind: "single", commits: [{ message: "Original", files: ["file.ts"] }],
      changelog: [], warnings: [], usedFallback: false,
    } } }));
    await waitFor(() => assert.deepEqual(commands, ["commit_plan", "generate_pr_description"]));
    view.rerender(React.createElement(ShipDialog, props));
    const message = await view.findByLabelText("Commit 1 message");
    const description = await view.findByLabelText("PR description");
    fireEvent.change(message, { target: { value: "Edited commit" } });
    fireEvent.change(description, { target: { value: "Edited description" } });
    view.rerender(React.createElement(ShipDialog, { ...props, visible: false }));
    view.rerender(React.createElement(ShipDialog, props));
    assert.equal((view.getByLabelText("Commit 1 message") as HTMLTextAreaElement).value, "Edited commit");
    assert.equal((view.getByLabelText("PR description") as HTMLTextAreaElement).value, "Edited description");
    assert.deepEqual(commands, ["commit_plan", "generate_pr_description"]);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("ship job polling continues while hidden and restores progress", async () => {
  const originalFetch = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const path = String(url);
      if (path.startsWith("/api/ship?"))
        return Response.json({ branch: "work", base: "main", ahead: 1, behind: 0,
          dirty: false, baseDirty: false, issues: [], github: { repo: null, gh: "missing" } });
      if (path.startsWith("/api/agent/"))
        return Response.json({ success: true, data: { plan: null } });
      if (path === "/api/ship")
        return Response.json({ id: "job", status: "running", steps: [{ name: "push", status: "running" }, { name: "autoMerge", status: "skipped" }] });
      if (path.startsWith("/api/ship/job?")) {
        polls++;
        return Response.json({ id: "job", status: "conflict", steps: [{ name: "push", status: "done" }], conflictFiles: ["file.ts"] });
      }
      throw new Error(`Unexpected request ${path} ${init.method}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  const props = {
    open: true, onOpenChange() {}, host: "local", projectPath: "/repo",
    path: "/work", sessionId: "session", onAskAgentToResolve: async () => {},
  };
  try {
    const view = render(React.createElement(ShipDialog, props));
    await waitFor(() => assert.equal((view.getByRole("button", { name: "Ship" }) as HTMLButtonElement).disabled, false));
    await view.findByText(/No uncommitted changes.*won't generate a new commit message/);
    fireEvent.click(view.getByRole("button", { name: "Ship" }));
    await view.findByText(/push/);
    assert.equal(view.queryByText("autoMerge"), null);
    view.rerender(React.createElement(ShipDialog, { ...props, visible: false }));
    assert.equal(view.queryByRole("dialog"), null);
    await waitFor(() => assert.equal(polls, 1), { timeout: 3000 });
    view.rerender(React.createElement(ShipDialog, props));
    await view.findByText(/file\.ts/);
    assert.ok(view.getByRole("button", { name: "Ask agent to resolve" }));
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("commit planning waits for its session stream and displays only matching progress", async () => {
  const originalFetch = globalThis.fetch;
  const plans: { requestId: string; finish: (response: Response) => void }[] = [];
  autoOpenStream = false;
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      if (String(url).startsWith("/api/ship?")) return Response.json({
        branch: "work", base: "main", ahead: 0, behind: 0, dirty: true,
        baseDirty: false, issues: [], github: { repo: null, gh: "missing" },
      });
      const command = JSON.parse(String(init.body));
      assert.equal(command.type, "commit_plan");
      const { promise, resolve } = Promise.withResolvers<Response>();
      plans.push({ requestId: command.requestId, finish: resolve });
      return promise;
    },
    { preconnect: originalFetch.preconnect },
  );
  const props = { open: true, onOpenChange() {}, host: "local", projectPath: "/repo", path: "/work", sessionId: "session", onAskAgentToResolve: async () => {} };
  try {
    const first = streams.length;
    const view = render(React.createElement(ShipDialog, props));
    await waitFor(() => assert.equal(streams.length, first + 1));
    const stream = streams[first];
    assert.deepEqual(stream.channel, { kind: "commit-plan-progress", sessionId: "session" });
    assert.equal(plans.length, 0);
    await act(async () => { Object.assign(stream, { readyState: 1 }); stream.onopen?.(); });
    await waitFor(() => assert.equal(plans.length, 1));
    const emit = (requestId: string, message: string) => stream.onmessage?.({ data: JSON.stringify({ type: "commit_plan_progress", requestId, message }) });
    await act(async () => {
      emit("unrelated", "Other plan");
      emit(plans[0].requestId, "Staging workspace changes");
      emit(plans[0].requestId, "Inspecting staged changes");
      emit(plans[0].requestId, "\u001b[31mReading diff\u001b[0m");
    });
    assert.equal(view.queryByText("Other plan"), null);
    assert.ok(view.getByText("Staging workspace changes"));
    assert.ok(view.getByText("Inspecting staged changes"));
    assert.equal(view.container.querySelectorAll(".lucide-circle-check").length, 1);
    assert.equal(view.container.querySelectorAll(".lucide-loader-circle").length, 1);
    assert.equal(view.getByRole("status").textContent, "Reading diff");
    view.rerender(React.createElement(ShipDialog, { ...props, visible: false }));
    await act(async () => emit(plans[0].requestId, "Preparing message"));
    view.rerender(React.createElement(ShipDialog, props));
    assert.equal(view.getByRole("status").textContent, "Preparing message");
    await act(async () => {
      for (let index = 0; index < 7; index++) emit(plans[0].requestId, `Step ${index}`);
      emit(plans[0].requestId, "x".repeat(500));
    });
    assert.equal(view.queryByText("Step 0"), null);
    assert.equal(view.getByRole("status").textContent?.length, 300);
    view.rerender(React.createElement(ShipDialog, { ...props, open: false }));
    assert.equal(stream.readyState, 2);
    view.rerender(React.createElement(ShipDialog, props));
    await waitFor(() => assert.equal(streams.length, first + 2));
    const next = streams[first + 1];
    await act(async () => { Object.assign(next, { readyState: 1 }); next.onopen?.(); });
    await waitFor(() => assert.equal(plans.length, 2));
    assert.notEqual(plans[0].requestId, plans[1].requestId);
    assert.equal(view.queryByText("Preparing message"), null);
    await act(async () => {
      plans[0].finish(Response.json({ success: true, data: { plan: null } }));
      next.onmessage?.({ data: JSON.stringify({ type: "commit_plan_progress", requestId: plans[0].requestId, message: "Old plan" }) });
    });
    assert.equal(view.queryByText("Old plan"), null);
    await act(async () => plans[1].finish(Response.json({ success: true, data: { plan: null } })));
    await view.findByText("Nothing to ship.");
    assert.equal(next.readyState, 2);
  } finally {
    cleanup();
    autoOpenStream = true;
    globalThis.fetch = originalFetch;
  }
});

test("planning continues when the session stream cannot connect", async () => {
  const originalFetch = globalThis.fetch;
  const { promise: pendingPlan, resolve: finishPlan } = Promise.withResolvers<Response>();
  let commands = 0;
  autoOpenStream = false;
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).startsWith("/api/ship?")) return Response.json({
        branch: "work", base: "main", ahead: 0, behind: 0, dirty: true,
        baseDirty: false, issues: [], github: { repo: null, gh: "missing" },
      });
      commands++;
      return pendingPlan;
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const first = streams.length;
    const view = render(React.createElement(ShipDialog, {
      open: true, onOpenChange() {}, host: "local", projectPath: "/repo", path: "/work",
      sessionId: "session", onAskAgentToResolve: async () => {},
    }));
    await waitFor(() => assert.equal(streams.length, first + 1));
    await act(async () => {
      Object.assign(streams[first], { readyState: 2 });
      streams[first].onerror?.();
    });
    await waitFor(() => assert.equal(commands, 1));
    assert.equal(view.getByRole("status").textContent, "Live progress is unavailable.");
    await act(async () => finishPlan(Response.json({ success: true, data: { plan: null } })));
    await view.findByText("Nothing to ship.");
  } finally {
    cleanup();
    autoOpenStream = true;
    globalThis.fetch = originalFetch;
  }
});
