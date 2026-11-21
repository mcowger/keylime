import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react/pure.js";
import test from "node:test";
import React from "react";
import type { HierarchySnapshot } from "@/lib/project-hierarchy-types";
import { HierarchySidebar } from "./HierarchySidebar";

for (const [state, label] of [
  ["watching", "Monitoring on"],
  ["error", "Monitoring error"],
  ["delivery-expired", "Feedback delivery expired"],
] as const) {
  test(`the sidebar shows ${label} and keeps the PR link in place after stopping`, async () => {
    const chat = {
      id: "22222222-2222-4222-8222-222222222222",
      path: "/sessions/work.jsonl",
      cwd: "/work",
      name: "Work chat",
      created: "2026-11-20",
      modified: "2026-11-20",
      messageCount: 1,
      firstMessage: "Review the change",
    };
    const originalFetch = globalThis.fetch;
    const stop = Promise.withResolvers<Response>();
    let monitored = true;
    const requests: unknown[] = [];
    let changed = 0;
    globalThis.fetch = Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(url).startsWith("/api/hierarchy?")) {
          const snapshot: HierarchySnapshot = {
            projects: [
              {
                id: "project",
                path: "/repo",
                name: "Repo",
                kind: "git",
                addedAt: "2026-11-20",
                workspaces: [
                  {
                    id: "workspace",
                    projectId: "project",
                    path: "/work",
                    name: "Work",
                    isDefault: false,
                    sessionIds: [chat.id],
                    ship: {
                      pr: {
                        number: 42,
                        url: "https://github.com/owner/repo/pull/42",
                        state: "open",
                        checks: "passing",
                        autoMerge: false,
                        cleanup: false,
                        checkedAt: "2026-11-20",
                        ...(monitored
                          ? { monitor: { id: "generation", state } }
                          : {}),
                      },
                    },
                  },
                ],
              },
            ],
          };
          return Response.json(snapshot);
        }
        if (String(url) === "/api/ship/monitor/start") {
          assert.equal(init?.method, "POST");
          requests.push(JSON.parse(String(init?.body)));
          monitored = true;
          return Response.json({ id: "new-generation", state: "watching" });
        }
        assert.equal(String(url), "/api/ship/monitor/stop");
        assert.equal(init?.method, "POST");
        requests.push(JSON.parse(String(init?.body)));
        return stop.promise;
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const noop = () => {};
      const view = render(
        React.createElement(HierarchySidebar, {
          hosts: [{ id: "local", label: "Local" }],
          sessions: [chat],
          selectedSessionId: null,
          selectedCwd: null,
          selectedHostId: "local",
          systemsHosts: {
            byHost: {},
            run: async () => {
              throw new Error("Unexpected Systems action");
            },
          },
          onOpenEffort: noop,
          onSelectWorkspace: noop,
          onWorkspaceRemoved: noop,
          onProjects: noop,
          onSnapshots: noop,
          searchQuery: "",
          matchedSessionIds: null,
          runningOnly: false,
          runningSessionIds: new Set<string>(),
          awaitingInputIds: new Set<string>(),
          unreadSessionIds: new Set<string>(),
          hasUndismissedExit: () => false,
          collapsedHosts: new Set<string>(),
          onToggleHost: noop,
          onSelectSession: noop,
          onAddProject: noop,
          onNewWorkspace: noop,
          onChanged: () => {
            changed++;
          },
        }),
      );
      const link = await view.findByRole("link", {
        name: "PR #42",
      });
      const summary = view.getByLabelText("Actions for workspace Work");
      const menu = summary.closest("details")!;
      const actions = within(menu);
      assert.equal(menu.open, false);
      fireEvent.click(summary);
      assert.equal(menu.open, true);
      assert.ok(link.title.includes(label));
      assert.equal(
        link.getAttribute("href"),
        "https://github.com/owner/repo/pull/42",
      );
      const button = actions.getByRole("button", {
        name: "Stop monitoring",
      }) as HTMLButtonElement;
      fireEvent.click(button);
      fireEvent.click(button);
      assert.equal(button.disabled, true);
      assert.deepEqual(requests, [
        {
          host: "local",
          projectPath: "/repo",
          path: "/work",
          monitorId: "generation",
        },
      ]);
      monitored = false;
      stop.resolve(Response.json({ stopped: true }));
      await waitFor(() => {
        assert.equal(view.getByRole("link", { name: "PR #42" }), link);
        assert.ok(link.title.includes("Monitoring off"));
        assert.ok(actions.getByRole("button", { name: "Start monitoring" }));
        assert.equal(changed, 1);
      });
      const start = actions.getByRole("button", { name: "Start monitoring" });
      start.focus();
      fireEvent.click(start);
      const picker = await view.findByRole("dialog", {
        name: "Monitor PR #42",
      });
      assert.equal(menu.open, false);
      fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
      await waitFor(() => assert.equal(document.activeElement, summary));
      assert.equal(requests.length, 1);
      fireEvent.click(summary);
      fireEvent.click(actions.getByRole("button", { name: "Start monitoring" }));
      const secondDialog = await view.findByRole("dialog", {
        name: "Monitor PR #42",
      });
      fireEvent.click(
        within(secondDialog).getByRole("button", { name: "Start monitoring" }),
      );
      await waitFor(() => assert.equal(requests.length, 2));
      assert.deepEqual(requests[1], {
        host: "local",
        projectPath: "/repo",
        path: "/work",
        sessionId: chat.id,
        prUrl: "https://github.com/owner/repo/pull/42",
      });
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
    }
  });
}
