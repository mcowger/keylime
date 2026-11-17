import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import type { SessionInfo } from "../lib/types";
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

function setup(
  hierarchy: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  const original = {
    fetch: globalThis.fetch,
    Worker: globalThis.Worker,
    SharedWorker: globalThis.SharedWorker,
    matchMedia: window.matchMedia,
    confirm: window.confirm,
  };
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  (
    globalThis as unknown as { SharedWorker: typeof SharedWorker | undefined }
  ).SharedWorker = undefined;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/hierarchy") return hierarchy(url, init);
      if (url.pathname === "/api/sessions")
        return Response.json({ sessions: [] });
      if (url.pathname === "/api/projects")
        return Response.json({ projects: [] });
      return Response.json({});
    },
    { preconnect: original.fetch.preconnect },
  );
  return () => {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
    window.confirm = original.confirm;
  };
}

function renderSidebar(
  props: Partial<React.ComponentProps<typeof SessionSidebar>> = {},
) {
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

test("registered hierarchy workspaces can be selected without a single-host heading", async () => {
  const hosts: (string | null)[] = [];
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
    assert.equal(screen.queryByRole("button", { name: /This machine/ }), null);
  } finally {
    restore();
  }
});

test("pending workspace does not select its base workspace", async () => {
  const restore = setup(() => Response.json(snapshot));
  try {
    const props = { selectedCwd: "/workspace", selectedHostId: "local" };
    const view = renderSidebar(props);
    const workspace = await screen.findByRole("button", { name: "Workspace" });
    await waitFor(() => assert.equal(workspace.getAttribute("aria-pressed"), "true"));
    view.rerender(React.createElement(SessionSidebar, {
      selectedSessionId: null, onSelectSession() {}, skipInitialProjectSelection: true,
      addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
      ...props, pendingWorkspace: true,
    }));
    assert.equal(workspace.getAttribute("aria-pressed"), "false");
    fireEvent.click(workspace);
    assert.equal(workspace.getAttribute("aria-pressed"), "false");
    view.rerender(React.createElement(SessionSidebar, {
      selectedSessionId: null, onSelectSession() {}, skipInitialProjectSelection: true,
      addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false, ...props,
    }));
    assert.equal(workspace.getAttribute("aria-pressed"), "true");
  } finally {
    restore();
  }
});
test("workspace click reconciles after its registered sessions load", async () => {
  const { promise: sessions, resolve: resolveSessions } = Promise.withResolvers<Response>();
  const restore = setup(() => Response.json({ projects: [{ ...snapshot.projects[0], workspaces: [{ ...snapshot.projects[0].workspaces[0], sessionIds: ["saved"] }] }] }));
  const fetchBase = globalThis.fetch;
  globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input), "http://localhost").pathname === "/api/sessions" ? sessions : fetchBase(input, init),
    { preconnect: fetchBase.preconnect });
  const changes: unknown[][] = [];
  try {
    renderSidebar({ onCwdChange: (...args) => changes.push(args) });
    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    assert.ok(changes.some((args) => args[6] === "pending"));
    resolveSessions(Response.json({ sessions: [{ id: "saved", cwd: "/workspace", path: "/saved", created: "2026-01-01", modified: "2026-01-02", messageCount: 1, firstMessage: "hello" }] }));
    await waitFor(() => assert.equal(changes.at(-1)?.[6], "resolved"));
    assert.equal((changes.at(-1)?.[5] as SessionInfo).id, "saved");
  } finally { restore(); }
});

test("one connected host is ungrouped while offline host projects remain visible", async () => {
  const restore = setup((url) => {
    const offline = url.searchParams.get("host") === "remote";
    return Response.json(offline ? { projects: [{ ...snapshot.projects[0], id: "remote-project", name: "Offline project", workspaces: [{ ...snapshot.projects[0].workspaces[0], id: "remote-workspace", name: "Offline workspace" }] }] } : snapshot);
  });
  try {
    render(React.createElement(HierarchySidebar, {
      hosts: [{ id: "local", label: "Local", status: "omp-missing" }, { id: "remote", label: "Remote", status: "offline" }],
      sessions: [], selectedSessionId: null, selectedCwd: null, selectedHostId: "local",
      onSelectWorkspace() {}, onWorkspaceRemoved() {}, onNewWorkspace() {}, onProjects() {}, onSnapshots() {},
      searchQuery: "", matchedSessionIds: null, runningOnly: false,
      runningSessionIds: new Set<string>(), awaitingInputIds: new Set<string>(), unreadSessionIds: new Set<string>(), exitedSessionIds: [],
      collapsedHosts: new Set(["local"]), onToggleHost() {}, onSelectSession() {}, onAddProject() {}, onChanged() {},
    }));
    assert.ok(await screen.findByRole("button", { name: "Workspace" }));
    assert.ok(await screen.findByRole("button", { name: "Offline workspace" }));
    assert.equal(screen.queryByRole("button", { name: "Local" }), null);
    assert.ok(screen.getByRole("button", { name: "Remote" }));
  } finally {
    restore();
  }
});

test("workspace loading error clears after the host recovers", async () => {
  let offline = true;
  const restore = setup(() =>
    offline
      ? Response.json({ error: "MacMini is offline" }, { status: 503 })
      : Response.json(snapshot),
  );
  try {
    renderSidebar();
    await screen.findByText("MacMini is offline");
    offline = false;
    fireEvent.focus(window);
    await screen.findByRole("button", { name: "Workspace" });
    await waitFor(() =>
      assert.equal(screen.queryByText("MacMini is offline"), null),
    );
  } finally {
    restore();
  }
});

test("a slow successful hierarchy refresh recovers despite a newer pending refresh", async () => {
  const pending: ((response: Response) => void)[] = [];
  let offline = true;
  const restore = setup(() => {
    if (offline)
      return Response.json({ error: "MacMini is offline" }, { status: 503 });
    return new Promise<Response>((resolve) => pending.push(resolve));
  });
  try {
    renderSidebar();
    await screen.findByText("MacMini is offline");
    offline = false;
    fireEvent.focus(window);
    fireEvent.focus(window);
    await waitFor(() => assert.equal(pending.length, 2));
    pending[0](Response.json(snapshot));
    await screen.findByRole("button", { name: "Workspace" });
    await waitFor(() =>
      assert.equal(screen.queryByText("MacMini is offline"), null),
    );
    pending[1](Response.json(snapshot));
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
    await waitFor(() =>
      assert.equal(workspace.getAttribute("aria-pressed"), "true"),
    );
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
  const writes: unknown[] = [];
  const restore = setup((_url, init) => {
    if (init.method === "POST") {
      assert.ok(typeof init.body === "string");
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
    fireEvent.click(await screen.findByRole("button", { name: "Unregister" }));
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
  const selected: SessionInfo[] = [];
  const session: SessionInfo = {
    id: "chat-1",
    name: "Saved chat",
    firstMessage: "",
    messageCount: 1,
    cwd: "/workspace",
    path: "/workspace/chat-1.jsonl",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
  };
  const props = {
    hosts: [{ id: "local", label: "" }],
    sessions: [session],
    selectedSessionId: null,
    selectedCwd: null,
    selectedHostId: "local",
    onSelectWorkspace() {},
    onWorkspaceRemoved() {},
    onNewWorkspace() {},
    onProjects() {},
    onSnapshots() {},
    searchQuery: "",
    matchedSessionIds: null,
    runningOnly: false,
    runningSessionIds: new Set<string>(),
    awaitingInputIds: new Set<string>(),
    unreadSessionIds: new Set<string>(),
    exitedSessionIds: [],
    collapsedHosts: new Set<string>(),
    onToggleHost() {},
    onSelectSession: (value: SessionInfo) => selected.push(value),
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
  for (const [label, expected] of [
    ["Keep branch", true],
    ["Delete branch", false],
    ["Cancel", null],
  ]) {
    assert.ok(typeof label === "string");
    const hierarchy = {
      projects: [
        {
          ...snapshot.projects[0],
          kind: "git",
          workspaces: [
            { ...snapshot.projects[0].workspaces[0], isDefault: false },
          ],
        },
      ],
    };
    const restore = setup(() => Response.json(hierarchy));
    const baseFetch = globalThis.fetch;
    const requests: { cancel?: boolean; keepBranch?: boolean }[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (
          new URL(String(input), "http://localhost").pathname !==
          "/api/worktrees"
        )
          return baseFetch(input, init);
        assert.ok(typeof init.body === "string");
        requests.push(JSON.parse(init.body).input);
        return Response.json(
          requests.length === 1
            ? { status: "branch", branch: "feature" }
            : { status: expected === null ? "cancelled" : "deleted" },
        );
      },
      { preconnect: baseFetch.preconnect },
    );
    try {
      render(
        React.createElement(HierarchySidebar, {
          hosts: [{ id: "local", label: "This machine" }],
          sessions: [],
          selectedSessionId: null,
          selectedCwd: null,
          selectedHostId: "local",
          onSelectWorkspace() {},
          onWorkspaceRemoved() {},
          onProjects() {},
          onSnapshots() {},
          searchQuery: "",
          matchedSessionIds: null,
          runningOnly: false,
          runningSessionIds: new Set<string>(),
          awaitingInputIds: new Set<string>(),
          unreadSessionIds: new Set<string>(),
          exitedSessionIds: [],
          collapsedHosts: new Set<string>(),
          onToggleHost() {},
          onSelectSession() {},
          onAddProject() {},
          onNewWorkspace() {},
          onChanged() {},
        }),
      );
      fireEvent.click(
        await screen.findByLabelText("Actions for workspace Workspace"),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Unregister workspace" }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Delete workspace" }),
      );
      assert.ok(
        await screen.findByRole("dialog", { name: "Keep or delete branch?" }),
      );
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => assert.equal(requests.length, 2));
      assert.equal(requests[1].cancel, expected === null);
      assert.equal(
        requests[1].keepBranch,
        expected === null ? undefined : expected,
      );
    } finally {
      restore();
    }
  }
});

test("workspace deletion confirms processes and preserves cancellation after stopping", async () => {
  const hierarchy = {
    projects: [
      {
        ...snapshot.projects[0],
        workspaces: [
          { ...snapshot.projects[0].workspaces[0], isDefault: false },
        ],
      },
    ],
  };
  const restore = setup(() => Response.json(hierarchy));
  const baseFetch = globalThis.fetch;
  const requests: {
    stopProcesses?: boolean;
    cancel?: boolean;
    discardChanges?: boolean;
  }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (
        new URL(String(input), "http://localhost").pathname !== "/api/worktrees"
      )
        return baseFetch(input, init);
      assert.ok(typeof init.body === "string");
      requests.push(JSON.parse(init.body).input);
      return Response.json(
        requests.length === 1
          ? {
              status: "processes",
              processes: [{ id: "chat-1", cwd: "/workspace" }],
            }
          : requests.length === 2
            ? { status: "dirty" }
            : { status: "cancelled" },
      );
    },
    { preconnect: baseFetch.preconnect },
  );
  try {
    render(
      React.createElement(HierarchySidebar, {
        hosts: [{ id: "local", label: "This machine" }],
        sessions: [
          {
            id: "chat-1",
            name: "Active chat",
            path: "/workspace/chat-1.jsonl",
            cwd: "/workspace",
            created: "",
            modified: "",
            messageCount: 0,
            firstMessage: "",
          },
        ],
        selectedSessionId: null,
        selectedCwd: null,
        selectedHostId: "local",
        onSelectWorkspace() {},
        onWorkspaceRemoved() {},
        onProjects() {},
        onSnapshots() {},
        searchQuery: "",
        matchedSessionIds: null,
        runningOnly: false,
        runningSessionIds: new Set<string>(),
        awaitingInputIds: new Set<string>(),
        unreadSessionIds: new Set<string>(),
        exitedSessionIds: [],
        collapsedHosts: new Set<string>(),
        onToggleHost() {},
        onSelectSession() {},
        onAddProject() {},
        onNewWorkspace() {},
        onChanged() {},
      }),
    );
    fireEvent.click(
      await screen.findByLabelText("Actions for workspace Workspace"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Unregister workspace" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete workspace" }),
    );
    assert.ok(await screen.findByText(/Session: Active chat/));
    fireEvent.click(screen.getByRole("button", { name: "Stop and continue" }));
    assert.ok(
      await screen.findByText(/Previously stopped sessions remain stopped/),
    );
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
  const registered = {
    projects: [
      {
        ...snapshot.projects[0],
        workspaces: [
          { ...snapshot.projects[0].workspaces[0], sessionIds: ["chat-1"] },
        ],
      },
    ],
  };
  const writes: unknown[] = [];
  const restore = setup((_url, init) => {
    if (init.method === "POST") {
      assert.ok(typeof init.body === "string");
      writes.push(JSON.parse(init.body));
    }
    return Response.json(registered);
  });
  try {
    render(
      React.createElement(HierarchySidebar, {
        hosts: [{ id: "local", label: "This machine" }],
        sessions: [
          {
            id: "chat-1",
            name: "Saved chat",
            firstMessage: "",
            cwd: "/workspace",
            path: "/workspace/chat-1.jsonl",
            created: "",
            modified: "",
            messageCount: 0,
          },
        ],
        selectedSessionId: null,
        selectedCwd: null,
        selectedHostId: "local",
        onSelectWorkspace() {},
        onWorkspaceRemoved() {},
        onProjects() {},
        onSnapshots() {},
        searchQuery: "saved",
        matchedSessionIds: new Set(["chat-1"]),
        runningOnly: false,
        runningSessionIds: new Set<string>(),
        awaitingInputIds: new Set<string>(),
        unreadSessionIds: new Set<string>(),
        exitedSessionIds: [],
        collapsedHosts: new Set<string>(),
        onToggleHost() {},
        onSelectSession() {},
        onAddProject() {},
        onNewWorkspace() {},
        onChanged() {},
      }),
    );
    fireEvent.click(
      await screen.findByLabelText("Actions for session Saved chat"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Unregister session" }));
    assert.ok(
      await screen.findByText(/Files and processes will not be deleted/),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
    assert.deepEqual(writes, []);
    assert.ok(screen.getByRole("button", { name: "Saved chat" }));
  } finally {
    restore();
  }
});
