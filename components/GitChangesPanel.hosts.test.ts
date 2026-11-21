import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React, { act } from "react";
import test, { afterEach } from "node:test";
import {
  render,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react/pure.js";
import { GitChangesPanel } from "./GitChangesPanel";
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("same-path Git patches follow their host and ignore a late prior-owner patch", async () => {
  let releaseAlpha!: () => void;
  const patch = (label: string) => ({
    supported: true,
    status: "modified",
    patch: `diff --git a/report.txt b/report.txt\n--- a/report.txt\n+++ b/report.txt\n@@ -1 +1 @@\n-old\n+${label}\n`,
  });
  type Patch = { supported: boolean; status: string; patch: string };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const host = url.searchParams.get("hostId");
      if (url.pathname.endsWith("/status"))
        return Response.json({
          isGitRepository: true,
          repositoryRoot: "/same",
          files: [
            {
              filePath: "/same/report.txt",
              status: "modified",
              code: "M",
              indexStatus: " ",
              worktreeStatus: "M",
            },
          ],
        });
      if (host === "beta") return Response.json(patch("Beta patch bytes"));
      const { promise, resolve } = Promise.withResolvers<Patch>();
      releaseAlpha = () => resolve(patch("Late alpha bytes"));
      return Object.assign(new Response(), { json: () => promise });
    },
    { preconnect: originalFetch.preconnect },
  );
  const props = { cwd: "/same", hostId: "alpha", onOpenFile() {} };
  const view = render(React.createElement(GitChangesPanel, props));
  await waitFor(() => assert.equal(typeof releaseAlpha, "function"));
  view.rerender(
    React.createElement(GitChangesPanel, { ...props, hostId: "beta" }),
  );
  await waitFor(() =>
    assert.ok(view.container.textContent!.includes("Beta patch bytes")),
  );
  await act(async () => {
    releaseAlpha();
  });
  assert.ok(view.container.textContent!.includes("Beta patch bytes"));
  assert.equal(view.container.textContent!.includes("Late alpha bytes"), false);
});

for (const [label, action, choice] of [
  ["Push", "push", null],
  ["Pull", "pull", null],
  ["Fetch", "fetch", null],
  ["Rebase", "rebase-main", "Rebase onto local main"],
  ["Rebase", "rebase-origin-main", "Rebase onto origin/main"],
] as const) {
  test(`${action} targets the owning host and refreshes after completion`, async () => {
    const pending = Promise.withResolvers<Response>();
    const requests: unknown[] = [];
    let statuses = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/git/status?")) {
          statuses++;
          return Response.json({ isGitRepository: true, files: [] });
        }
        assert.equal(String(input), "/api/git/action");
        assert.equal(init?.method, "POST");
        requests.push(JSON.parse(String(init?.body)));
        return pending.promise;
      },
      { preconnect: originalFetch.preconnect },
    );
    const view = render(
      React.createElement(GitChangesPanel, {
        cwd: "/repo",
        hostId: "alpha",
        sourceSessionId: "session-a",
        onOpenFile() {},
      }),
    );
    const button = (await view.findByRole("button", {
      name: label,
    })) as HTMLButtonElement;
    await waitFor(() => assert.equal(button.disabled, false));
    assert.equal(button.title, label);
    assert.equal(button.textContent, "");
    fireEvent.click(button);
    if (choice)
      fireEvent.click(await view.findByRole("button", { name: choice }));
    assert.deepEqual(requests, [
      { cwd: "/repo", hostId: "alpha", sessionId: "session-a", action },
    ]);
    for (const name of ["Push", "Pull", "Fetch", "Rebase"]) {
      assert.equal(
        (view.getByRole("button", { name }) as HTMLButtonElement).disabled,
        true,
      );
    }
    fireEvent.click(view.getByRole("button", { name: "Push" }));
    assert.equal(requests.length, 1);
    await act(async () => pending.resolve(Response.json({ output: "done" })));
    await waitFor(() => assert.equal(statuses, 2));
    await waitFor(() => assert.equal(button.disabled, false));
  });
}

test("rebase conflicts remain visible and refresh state without retrying", async () => {
  let statuses = 0;
  let actions = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/git/status?")) {
        statuses++;
        return Response.json({ isGitRepository: true, files: [] });
      }
      actions++;
      return Response.json({ error: "CONFLICT in file.txt" }, { status: 409 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    React.createElement(GitChangesPanel, {
      cwd: "/repo",
      hostId: "alpha",
      onOpenFile() {},
    }),
  );
  const button = (await view.findByRole("button", {
    name: "Rebase",
  })) as HTMLButtonElement;
  await waitFor(() => assert.equal(button.disabled, false));
  fireEvent.click(button);
  fireEvent.click(
    await view.findByRole("button", { name: "Rebase onto local main" }),
  );
  const alert = await view.findByRole("alert");
  assert.ok(alert.textContent?.includes("CONFLICT in file.txt"));
  assert.ok(alert.textContent?.includes("git rebase --continue"));
  assert.ok(alert.textContent?.includes("git rebase --abort"));
  await waitFor(() => assert.equal(statuses, 2));
  assert.equal(actions, 1);
});

test("uncertain delivery is reported and late responses stay with their owner", async () => {
  const pending = Promise.withResolvers<Response>();
  const statuses: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/git/status") {
        statuses.push(url.searchParams.get("hostId")!);
        return Response.json({ isGitRepository: true, files: [] });
      }
      return pending.promise;
    },
    { preconnect: originalFetch.preconnect },
  );
  const props = { cwd: "/repo", hostId: "alpha", onOpenFile() {} };
  const view = render(React.createElement(GitChangesPanel, props));
  const push = (await view.findByRole("button", {
    name: "Push",
  })) as HTMLButtonElement;
  await waitFor(() => assert.equal(push.disabled, false));
  fireEvent.click(push);
  view.rerender(
    React.createElement(GitChangesPanel, { ...props, hostId: "beta" }),
  );
  await waitFor(() => assert.equal(push.disabled, false));
  await act(async () => pending.reject(new Error("connection lost")));
  assert.equal(view.queryByRole("alert"), null);
  assert.deepEqual(statuses, ["alpha", "beta"]);
  view.rerender(React.createElement(GitChangesPanel, props));
  const alert = await view.findByRole("alert");
  assert.ok(alert.textContent?.includes("Could not confirm"));
  assert.ok(alert.textContent?.includes("Check the repository state"));
});

test("a pending action locks the same workspace across session changes only", async () => {
  const pending = Promise.withResolvers<Response>();
  let actions = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/git/status?"))
        return Response.json({ isGitRepository: true, files: [] });
      actions++;
      return pending.promise;
    },
    { preconnect: originalFetch.preconnect },
  );
  const props = {
    cwd: "/repo",
    hostId: "alpha",
    sourceSessionId: "one",
    onOpenFile() {},
  };
  const view = render(React.createElement(GitChangesPanel, props));
  const push = (await view.findByRole("button", {
    name: "Push",
  })) as HTMLButtonElement;
  await waitFor(() => assert.equal(push.disabled, false));
  fireEvent.click(push);
  view.rerender(
    React.createElement(GitChangesPanel, { ...props, sourceSessionId: "two" }),
  );
  await waitFor(() => assert.equal(push.disabled, true));
  fireEvent.click(push);
  assert.equal(actions, 1);
  view.rerender(
    React.createElement(GitChangesPanel, { ...props, cwd: "/other" }),
  );
  await waitFor(() => assert.equal(push.disabled, false));
  await act(async () => pending.resolve(Response.json({ output: "done" })));
  assert.equal(push.disabled, false);
});
