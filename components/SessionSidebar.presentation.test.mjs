import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
const { render, cleanup, fireEvent, screen, waitFor } =
  await import("@testing-library/react/pure.js");
const { SessionSidebar } = await import("./SessionSidebar.tsx");
const { HierarchySidebar } = await import("./HierarchySidebar.tsx");

class FakeWorker {
  postMessage() {}
}

const snapshot = {
  projects: [
    {
      id: "project-1",
      path: "/workspace",
      name: "Project",
      kind: "directory",
      addedAt: "2026-01-01T00:00:00.000Z",
      workspaces: [
        {
          id: "workspace-1",
          projectId: "project-1",
          path: "/workspace",
          name: "Workspace",
          isDefault: true,
          sessionIds: [],
        },
      ],
    },
  ],
};

function setup(hierarchy) {
  const original = {
    fetch: globalThis.fetch,
    Worker: globalThis.Worker,
    SharedWorker: globalThis.SharedWorker,
    matchMedia: window.matchMedia,
    confirm: window.confirm,
  };
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/hierarchy") return hierarchy(url, init);
    if (url.pathname === "/api/sessions")
      return Response.json({ sessions: [] });
    if (url.pathname === "/api/projects")
      return Response.json({ projects: [] });
    return Response.json({});
  };
  return () => {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
    window.confirm = original.confirm;
  };
}

function renderSidebar(props = {}) {
  return render(
    React.createElement(SessionSidebar, {
      selectedSessionId: null,
      onSelectSession() {},
      skipInitialProjectSelection: true,
      addProjectOpen: false,
      setAddProjectOpen() {},
      usageVisible: false,
      ...props,
    }),
  );
}

test("registered hierarchy workspaces can be selected and hosts collapsed", async () => {
  const hosts = [];
  const restore = setup((url) => {
    hosts.push(url.searchParams.get("host"));
    return Response.json(snapshot);
  });
  try {
    renderSidebar();
    const workspace = await screen.findByRole("button", { name: "Workspace" });
    assert.ok(hosts.includes("local"));
    assert.equal(workspace.getAttribute("aria-pressed"), "false");
    fireEvent.click(workspace);
    await waitFor(() =>
      assert.equal(workspace.getAttribute("aria-pressed"), "true"),
    );
    fireEvent.click(screen.getByRole("button", { name: /This machine/ }));
    assert.equal(screen.queryByRole("button", { name: "Workspace" }), null);
    fireEvent.click(screen.getByRole("button", { name: /This machine/ }));
    assert.ok(screen.getByRole("button", { name: "Workspace" }));
  } finally {
    restore();
  }
});

test("selecting any workspace closes the mobile sidebar", async () => {
  const restore = setup(() => Response.json(snapshot));
  let closes = 0;
  try {
    renderSidebar({ onClose: () => closes++ });
    const workspace = await screen.findByRole("button", { name: "Workspace" });
    fireEvent.click(workspace);
    await waitFor(() => assert.equal(workspace.getAttribute("aria-pressed"), "true"));
    assert.equal(closes, 1);
    fireEvent.click(workspace);
    assert.equal(closes, 2);
  } finally {
    restore();
  }
});

test("hierarchy load errors are shown", async () => {
  const restore = setup(() =>
    Response.json({ error: "Host unavailable" }, { status: 503 }),
  );
  try {
    renderSidebar();
    assert.equal(
      (await screen.findByRole("alert")).textContent,
      "Host unavailable",
    );
  } finally {
    restore();
  }
});

test("failed project unregistration reports the error and keeps the hierarchy", async () => {
  const writes = [];
  const restore = setup((_url, init) => {
    if (init.method === "POST") {
      writes.push(JSON.parse(init.body));
      return Response.json({ error: "Unregister refused" }, { status: 400 });
    }
    return Response.json(snapshot);
  });
  try {
    renderSidebar();
    fireEvent.click(
      await screen.findByLabelText("Actions for project Project"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unregister project" }));
    fireEvent.click(await screen.findByRole("button", { name: "Unregister", exact: true }));
    assert.equal(
      (await screen.findByRole("alert")).textContent,
      "Unregister refused",
    );
    assert.deepEqual(writes, [
      {
        host: "local",
        input: { action: "unregisterProject", projectId: "project-1" },
      },
    ]);
    assert.ok(screen.getByRole("button", { name: "Workspace" }));
  } finally {
    restore();
  }
});

test("registered chats appear only as search results and remain selectable", async () => {
  const registered = {
    ...snapshot,
    projects: [
      {
        ...snapshot.projects[0],
        workspaces: [
          { ...snapshot.projects[0].workspaces[0], sessionIds: ["chat-1"] },
        ],
      },
    ],
  };
  const restore = setup(() => Response.json(registered));
  const selected = [];
  const session = {
    id: "chat-1",
    name: "Saved chat",
    firstMessage: "",
    messageCount: 1,
    cwd: "/workspace",
  };
  const props = {
    hosts: [{ id: "local", label: "" }],
    sessions: [session],
    selectedSessionId: null,
    selectedCwd: null,
    selectedHostId: "local",
    onSelectWorkspace() {},
    onProjects() {},
    onSnapshots() {},
    searchQuery: "",
    matchedSessionIds: null,
    runningOnly: false,
    runningSessionIds: new Set(),
    awaitingInputIds: new Set(),
    unreadSessionIds: new Set(),
    exitedSessionIds: [],
    collapsedHosts: new Set(),
    onToggleHost() {},
    onSelectSession: (value) => selected.push(value),
    onAddProject() {},
    onChanged() {},
  };
  try {
    const view = render(React.createElement(HierarchySidebar, props));
    await screen.findByRole("button", { name: "Workspace" });
    assert.equal(screen.queryByRole("button", { name: "Saved chat" }), null);
    view.rerender(
      React.createElement(HierarchySidebar, {
        ...props,
        searchQuery: "saved",
        matchedSessionIds: new Set(["chat-1"]),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Saved chat" }));
    assert.deepEqual(selected, [session]);
  } finally {
    restore();
  }
});

test("workspace branch choice sends keep, delete, or cancel without typing", async () => {
  for (const [label, expected] of [["Keep branch", true], ["Delete branch", false], ["Cancel", null]]) {
    const hierarchy = {
      projects: [{ ...snapshot.projects[0], kind: "git", workspaces: [
        { ...snapshot.projects[0].workspaces[0], isDefault: false },
      ] }],
    };
    const restore = setup(() => Response.json(hierarchy));
    const baseFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (input, init = {}) => {
      if (new URL(String(input), "http://localhost").pathname !== "/api/worktrees")
        return baseFetch(input, init);
      requests.push(JSON.parse(init.body).input);
      return Response.json(requests.length === 1
        ? { status: "branch", branch: "feature" }
        : { status: expected === null ? "cancelled" : "deleted" });
    };
    try {
      render(React.createElement(HierarchySidebar, {
        hosts: [{ id: "local", label: "This machine" }], sessions: [],
        selectedSessionId: null, selectedCwd: null, selectedHostId: "local",
        onSelectWorkspace() {}, onWorkspaceRemoved() {}, onProjects() {}, onSnapshots() {},
        searchQuery: "", matchedSessionIds: null, runningOnly: false,
        runningSessionIds: new Set(), awaitingInputIds: new Set(), unreadSessionIds: new Set(),
        exitedSessionIds: [], collapsedHosts: new Set(), onToggleHost() {}, onSelectSession() {},
        onAddProject() {}, onChanged() {},
      }));
      fireEvent.click(await screen.findByLabelText("Actions for workspace Workspace"));
      fireEvent.click(screen.getByRole("button", { name: "Unregister workspace" }));
      fireEvent.click(await screen.findByRole("button", { name: "Delete workspace", exact: true }));
      assert.ok(await screen.findByRole("dialog", { name: "Keep or delete branch?" }));
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => assert.equal(requests.length, 2));
      assert.equal(requests[1].cancel, expected === null);
      assert.equal(requests[1].keepBranch, expected === null ? undefined : expected);
    } finally {
      restore();
    }
  }
});

test("workspace deletion confirms processes and preserves cancellation after stopping", async () => {
  const hierarchy = { projects: [{ ...snapshot.projects[0], workspaces: [
    { ...snapshot.projects[0].workspaces[0], isDefault: false },
  ] }] };
  const restore = setup(() => Response.json(hierarchy));
  const baseFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    if (new URL(String(input), "http://localhost").pathname !== "/api/worktrees") return baseFetch(input, init);
    requests.push(JSON.parse(init.body).input);
    return Response.json(requests.length === 1
      ? { status: "processes", processes: [{ id: "chat-1", cwd: "/workspace" }] }
      : requests.length === 2 ? { status: "dirty" } : { status: "cancelled" });
  };
  try {
    render(React.createElement(HierarchySidebar, {
      hosts: [{ id: "local", label: "This machine" }], sessions: [{ id: "chat-1", name: "Active chat" }],
      selectedSessionId: null, selectedCwd: null, selectedHostId: "local",
      onSelectWorkspace() {}, onWorkspaceRemoved() {}, onProjects() {}, onSnapshots() {},
      searchQuery: "", matchedSessionIds: null, runningOnly: false,
      runningSessionIds: new Set(), awaitingInputIds: new Set(), unreadSessionIds: new Set(),
      exitedSessionIds: [], collapsedHosts: new Set(), onToggleHost() {}, onSelectSession() {},
      onAddProject() {}, onChanged() {},
    }));
    fireEvent.click(await screen.findByLabelText("Actions for workspace Workspace"));
    fireEvent.click(screen.getByRole("button", { name: "Unregister workspace" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete workspace" }));
    assert.ok(await screen.findByText(/Session: Active chat/));
    fireEvent.click(screen.getByRole("button", { name: "Stop and continue" }));
    assert.ok(await screen.findByText(/Previously stopped sessions remain stopped/));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => assert.equal(requests.length, 3));
    assert.equal(requests[1].stopProcesses, true);
    assert.equal(requests[2].cancel, true);
    assert.equal(requests[2].discardChanges, false);
  } finally {
    restore();
  }
});

test("session unregister cancellation leaves the registration unchanged", async () => {
  const registered = { projects: [{ ...snapshot.projects[0], workspaces: [
    { ...snapshot.projects[0].workspaces[0], sessionIds: ["chat-1"] },
  ] }] };
  const writes = [];
  const restore = setup((_url, init) => {
    if (init.method === "POST") writes.push(JSON.parse(init.body));
    return Response.json(registered);
  });
  try {
    render(React.createElement(HierarchySidebar, {
      hosts: [{ id: "local", label: "This machine" }],
      sessions: [{ id: "chat-1", name: "Saved chat", firstMessage: "", cwd: "/workspace" }],
      selectedSessionId: null, selectedCwd: null, selectedHostId: "local",
      onSelectWorkspace() {}, onWorkspaceRemoved() {}, onProjects() {}, onSnapshots() {},
      searchQuery: "saved", matchedSessionIds: new Set(["chat-1"]), runningOnly: false,
      runningSessionIds: new Set(), awaitingInputIds: new Set(), unreadSessionIds: new Set(),
      exitedSessionIds: [], collapsedHosts: new Set(), onToggleHost() {}, onSelectSession() {},
      onAddProject() {}, onChanged() {},
    }));
    fireEvent.click(await screen.findByLabelText("Actions for session Saved chat"));
    fireEvent.click(screen.getByRole("button", { name: "Unregister session" }));
    assert.ok(await screen.findByText(/Files and processes will not be deleted/));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
    assert.deepEqual(writes, []);
    assert.ok(screen.getByRole("button", { name: "Saved chat" }));
  } finally {
    restore();
  }
});
