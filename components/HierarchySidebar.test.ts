import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react/pure.js";
import test from "node:test";
import React from "react";
import type { HierarchySnapshot } from "@/lib/project-hierarchy-types";
import { HierarchySidebar } from "./HierarchySidebar";

for (const [state, label] of [
  ["watching", "Monitoring"],
  ["error", "Monitoring error"],
  ["delivery-expired", "Delivery expired"],
] as const) {
  test(`the PR pill shows ${label} and can stop monitoring`, async () => {
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
                    sessionIds: [],
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
          sessions: [],
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
          exitedSessionIds: [],
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
        name: new RegExp(`PR #42 · ${label}$`),
      });
      assert.equal(
        link.getAttribute("href"),
        "https://github.com/owner/repo/pull/42",
      );
      const button = view.getByRole("button", {
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
        assert.ok(view.getByRole("link", { name: /PR #42$/ }));
        assert.equal(
          view.queryByRole("button", { name: /Stop monitoring|Stopping/ }),
          null,
        );
        assert.equal(changed, 1);
      });
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
    }
  });
}
