import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { sessionKey } from "@/lib/session-identity";
import type { SessionInfo } from "../lib/types";
import type { HomeSessions } from "./SessionSidebar";
import type { EffortRecord, SystemRecord } from "../lib/api-contracts/systems";
import { noSystemsSidebar } from "../tests/systems-sidebar-fixture";
const { render, cleanup, fireEvent, screen, waitFor } =
  await import("@testing-library/react/pure.js");
const { SessionSidebar } = await import("./SessionSidebar.tsx");
const { HierarchySidebar } = await import("./HierarchySidebar.tsx");
const { HomeDashboard } = await import("./HomeDashboard.tsx");
// Components load after the DOM fixture is installed.
const { SystemsSidebar } = await import("./SystemsSidebar.tsx");

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

test("the activity filter reveals a collapsed Repo and restores it afterward", async () => {
  const project = snapshot.projects[0];
  const restore = setup(() =>
    Response.json({
      projects: [
        {
          ...project,
          kind: "git",
          workspaces: [{ ...project.workspaces[0], sessionIds: ["active"] }],
        },
      ],
    }),
  );
  try {
    const noop = () => {};
    const tree = (runningOnly: boolean) =>
      React.createElement(HierarchySidebar, {
        ...noSystemsSidebar,
        hosts: [{ id: "local", label: "Local" }],
        sessions: [],
        selectedSessionId: null,
        selectedCwd: null,
        selectedHostId: "local",
        onSelectWorkspace: noop,
        onWorkspaceRemoved: noop,
        onNewWorkspace: noop,
        onProjects: noop,
        onSnapshots: noop,
        searchQuery: "",
        matchedSessionIds: null,
        runningOnly,
        runningSessionIds: new Set([sessionKey("active")]),
        awaitingInputIds: new Set<string>(),
        unreadSessionIds: new Set<string>(),
        hasUndismissedExit: () => false,
        collapsedHosts: new Set<string>(),
        onToggleHost: noop,
        onSelectSession: noop,
        onAddProject: noop,
        onChanged: noop,
      });
    const view = render(tree(false));
    await screen.findByRole("button", { name: "Workspace" });
    const repo = screen.getByRole("button", { name: "Project" });
    fireEvent.click(repo);
    assert.equal(screen.queryByRole("button", { name: "Workspace" }), null);
    view.rerender(tree(true));
    assert.ok(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(repo);
    view.rerender(tree(false));
    assert.equal(screen.queryByRole("button", { name: "Workspace" }), null);
    assert.equal(repo.getAttribute("aria-expanded"), "false");
  } finally {
    restore();
  }
});

test("Repos default to collapsed only when their work is confirmed default", async () => {
  const workspace = snapshot.projects[0].workspaces[0];
  const project = snapshot.projects[0];
  const git = (
    name: string,
    branch?: string,
    defaultBranch?: string,
    isDefault = false,
  ) => ({
    ...project,
    id: name,
    name,
    path: `/${name}`,
    kind: "git",
    defaultBranch,
    workspaces: [{ ...workspace, branch, isDefault }],
  });
  let projects = [
    { ...project, id: "directory", name: "Directory" },
    { ...project, id: "empty", name: "Empty", path: "/empty", workspaces: [] },
    git("Trunk", "trunk", "trunk"),
    git("Feature", "feature", "trunk", true),
    {
      ...git("Mixed", "trunk", "trunk"),
      workspaces: [
        { ...workspace, branch: "trunk" },
        { ...workspace, id: "feature-workspace", branch: "feature" },
      ],
    },
    git("Unknown branch", undefined, "trunk"),
    git("Unknown default", "trunk"),
  ];
  const restore = setup(() => Response.json({ projects }));
  try {
    renderSidebar();
    for (const [name, expanded] of [
      ["Directory", false],
      ["Empty", false],
      ["Trunk", false],
      ["Feature", true],
      ["Unknown branch", true],
      ["Mixed", true],
      ["Unknown default", true],
    ] as const) {
      const button = await screen.findByRole("button", { name });
      assert.equal(
        button.getAttribute("aria-expanded"),
        String(expanded),
        name,
      );
    }

    fireEvent.click(screen.getByRole("button", { name: "Trunk" }));
    fireEvent.click(screen.getByRole("button", { name: "Feature" }));
    projects = [
      git("Trunk", "feature", "trunk"),
      git("Feature", "trunk", "trunk"),
      git("Refreshed", "trunk", "trunk"),
    ];
    fireEvent.focus(window);
    await screen.findByRole("button", { name: "Refreshed" });
    assert.equal(
      screen
        .getByRole("button", { name: "Trunk" })
        .getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      screen
        .getByRole("button", { name: "Feature" })
        .getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      screen
        .getByRole("button", { name: "Refreshed" })
        .getAttribute("aria-expanded"),
      "false",
    );
  } finally {
    restore();
  }
});

test("System expansion uses observed member branches and preserves manual choices", () => {
  const restore = setup(() => Response.json(snapshot));
  const system: SystemRecord = {
    id: "system",
    slug: "system",
    name: "System",
    repoPaths: ["/repo"],
    services: [],
    instructions: "",
    archived: false,
  };
  const member = {
    repoPath: "/repo",
    name: "Repo",
    path: "/efforts/alpha/repo",
    baseRef: "trunk",
    baseCommit: "abc",
    skipsCustomCreate: false,
    status: "complete" as const,
    currentBranch: "trunk",
    defaultBranch: "trunk",
  };
  const effort: EffortRecord = {
    id: "effort",
    systemId: "system",
    systemName: "System",
    name: "Alpha",
    slug: "alpha",
    root: "/efforts/alpha",
    branch: "feature",
    status: "ready",
    members: [member],
    services: [],
    sessionIds: [],
  };
  const makeProps = (efforts: EffortRecord[], query = "") => ({
    host: { id: "local", name: "Local" },
    state: { data: { root: "/efforts", systems: [system], efforts } },
    action: noSystemsSidebar.systemsHosts.run,
    repos: [],
    selectedPath: "/efforts/alpha",
    query,
    runningOnly: false,
    runningIds: new Set<string>(),
    matchedIds: null,
    onOpenEffort() {},
    onChanged() {},
  });
  try {
    const view = render(React.createElement(SystemsSidebar, makeProps([])));
    const systemButton = () => screen.getByRole("button", { name: "System" });
    const expanded = () => systemButton().getAttribute("aria-expanded");
    assert.equal(expanded(), "false");
    view.rerender(React.createElement(SystemsSidebar, makeProps([effort])));
    assert.equal(expanded(), "false");
    view.rerender(
      React.createElement(
        SystemsSidebar,
        makeProps([{ ...effort, members: [] }]),
      ),
    );
    assert.equal(expanded(), "false");
    const switched = {
      ...effort,
      branch: "trunk",
      members: [{ ...member, currentBranch: "feature" }],
    };
    view.rerender(React.createElement(SystemsSidebar, makeProps([switched])));
    assert.equal(expanded(), "true");
    view.rerender(
      React.createElement(SystemsSidebar, {
        ...makeProps([switched]),
        selectedPath: null,
      }),
    );
    assert.equal(expanded(), "false");
    view.rerender(
      React.createElement(
        SystemsSidebar,
        makeProps([effort, { ...switched, id: "other-effort" }]),
      ),
    );
    assert.equal(expanded(), "true");
    const unknown = {
      ...effort,
      members: [{ ...member, currentBranch: undefined }],
    };
    view.rerender(React.createElement(SystemsSidebar, makeProps([unknown])));
    assert.equal(expanded(), "true");
    const mixed = {
      ...effort,
      members: [
        member,
        { ...member, repoPath: "/other", defaultBranch: undefined },
      ],
    };
    view.rerender(React.createElement(SystemsSidebar, makeProps([mixed])));
    assert.equal(expanded(), "true");
    fireEvent.click(systemButton());
    view.rerender(React.createElement(SystemsSidebar, makeProps([effort])));
    assert.equal(expanded(), "false");
    view.rerender(
      React.createElement(SystemsSidebar, makeProps([effort], "alpha")),
    );
    assert.equal(expanded(), "true");
    view.rerender(React.createElement(SystemsSidebar, makeProps([effort])));
    assert.equal(expanded(), "false");
    fireEvent.click(systemButton());
    view.rerender(React.createElement(SystemsSidebar, makeProps([switched])));
    assert.equal(expanded(), "true");
  } finally {
    restore();
  }
});

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
      ...noSystemsSidebar,
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

test("home opens a first-turn agent before its transcript exists", async () => {
  const restore = setup(() => Response.json(snapshot));
  const fallbackFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/sessions")
        return Response.json({
          sessions: [],
          runningSessions: [
            {
              id: "first-turn",
              hostId: "remote",
              cwd: "/repo",
              awaitingInput: true,
            },
          ],
        });
      return fallbackFetch(input, init);
    },
    { preconnect: fallbackFetch.preconnect },
  );
  let opened: SessionInfo | undefined;
  function Home() {
    const [home, setHome] = React.useState<HomeSessions>({
      sessions: [],
      runningIds: new Set(),
      awaitingInputIds: new Set(),
    });
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(SessionSidebar, {
        ...noSystemsSidebar,
        selectedSessionId: null,
        onSelectSession() {},
        onHomeSessionsChange: setHome,
        skipInitialProjectSelection: true,
        addProjectOpen: false,
        setAddProjectOpen() {},
      }),
      React.createElement(HomeDashboard, {
        ...home,
        hostNames: { remote: "Remote host" },
        sessionPlace: () => undefined,
        onSelectSession: (session: SessionInfo) => {
          opened = session;
        },
        onNewWorkspace() {},
        onNewEffort() {},
      }),
    );
  }
  try {
    render(React.createElement(Home));
    await screen.findByText("Remote host");
    const host = screen.getByText("Remote host");
    const button = host.closest("button");
    assert.ok(button);
    fireEvent.click(button);
    assert.equal(opened?.id, "first-turn");
    assert.equal(opened?.hostId, "remote");
    assert.equal(opened?.cwd, "/repo");
  } finally {
    restore();
  }
});
async function expandProject(name = "Project") {
  const project = await screen.findByRole("button", { name });
  if (project.getAttribute("aria-expanded") === "false")
    fireEvent.click(project);
}

test("registered workspaces remain selectable under the single host heading", async () => {
  const hosts: (string | null)[] = [];
  const restore = setup((url) => {
    hosts.push(url.searchParams.get("host"));
    return Response.json(snapshot);
  });
  try {
    renderSidebar();
    await expandProject();
    const workspace = await screen.findByRole("button", { name: "Workspace" });
    assert.ok(hosts.includes("local"));
    assert.equal(workspace.getAttribute("aria-pressed"), "false");
    fireEvent.click(workspace);
    await waitFor(() =>
      assert.equal(workspace.getAttribute("aria-pressed"), "true"),
    );
    const host = screen.getByRole("button", { name: "This machine" });
    fireEvent.click(host);
    assert.equal(screen.queryByRole("button", { name: "Workspace" }), null);
    fireEvent.click(host);
    assert.ok(screen.getByRole("button", { name: "Workspace", pressed: true }));
  } finally {
    restore();
  }
});

test("Repos and Systems collapse independently", async () => {
  const restore = setup(() => Response.json(snapshot));
  try {
    renderSidebar();
    await expandProject();
    await screen.findByRole("button", { name: "Workspace" });
    const repos = screen.getByRole("button", { name: "Repos" });
    const systems = screen.getByRole("button", { name: "Systems" });

    fireEvent.click(repos);
    assert.equal(screen.queryByRole("button", { name: "Workspace" }), null);
    assert.ok(screen.getByText("Loading Systems…"));

    fireEvent.click(repos);
    fireEvent.click(systems);
    assert.equal(screen.queryByText("Loading Systems…"), null);
    assert.ok(screen.getByRole("button", { name: "Workspace" }));
  } finally {
    restore();
  }
});

test("sidebar search reveals collapsed Repos and Systems until cleared", async () => {
  const restore = setup(() => Response.json(snapshot));
  try {
    renderSidebar({
      systemsHosts: {
        ...noSystemsSidebar.systemsHosts,
        byHost: {
          local: {
            data: {
              root: "/efforts",
              efforts: [],
              systems: [
                {
                  id: "system-1",
                  slug: "workspace-system",
                  name: "Workspace System",
                  repoPaths: ["/workspace"],
                  services: [],
                  instructions: "",
                  archived: false,
                },
              ],
            },
          },
        },
      },
    });
    await expandProject();
    await screen.findByRole("button", { name: "Workspace" });
    const repos = screen.getByRole("button", { name: "Repos" });
    const systems = screen.getByRole("button", { name: "Systems" });
    fireEvent.click(repos);
    fireEvent.click(systems);
    const search = screen.getByRole("button", { name: "Search sidebar" });
    fireEvent.click(search);
    fireEvent.change(screen.getByRole("textbox", { name: "Search sidebar" }), {
      target: { value: "workspace" },
    });
    await screen.findByRole("button", { name: "Workspace" });
    assert.ok(screen.getByRole("button", { name: "Workspace System" }));
    fireEvent.click(repos);
    fireEvent.click(systems);
    fireEvent.click(search);
    await waitFor(() => {
      assert.equal(repos.getAttribute("aria-expanded"), "false");
      assert.equal(systems.getAttribute("aria-expanded"), "false");
      assert.equal(screen.queryByRole("button", { name: "Workspace" }), null);
      assert.equal(
        screen.queryByRole("button", { name: "Workspace System" }),
        null,
      );
    });
  } finally {
    restore();
  }
});

test("pending workspace does not select its base workspace", async () => {
  const restore = setup(() => Response.json(snapshot));
  try {
    const props = { selectedCwd: "/workspace", selectedHostId: "local" };
    const view = renderSidebar(props);
    await expandProject();
    const workspace = await screen.findByRole("button", { name: "Workspace" });
    await waitFor(() =>
      assert.equal(workspace.getAttribute("aria-pressed"), "true"),
    );
    view.rerender(
      React.createElement(SessionSidebar, {
        ...noSystemsSidebar,
        selectedSessionId: null,
        onSelectSession() {},
        skipInitialProjectSelection: true,
        addProjectOpen: false,
        setAddProjectOpen() {},
        usageVisible: false,
        ...props,
        pendingWorkspace: true,
      }),
    );
    assert.equal(workspace.getAttribute("aria-pressed"), "false");
    fireEvent.click(workspace);
    assert.equal(workspace.getAttribute("aria-pressed"), "false");
    view.rerender(
      React.createElement(SessionSidebar, {
        ...noSystemsSidebar,
        selectedSessionId: null,
        onSelectSession() {},
        skipInitialProjectSelection: true,
        addProjectOpen: false,
        setAddProjectOpen() {},
        usageVisible: false,
        ...props,
      }),
    );
    assert.equal(workspace.getAttribute("aria-pressed"), "true");
  } finally {
    restore();
  }
});
test("workspace click reconciles after its registered sessions load", async () => {
  const { promise: sessions, resolve: resolveSessions } =
    Promise.withResolvers<Response>();
  const restore = setup(() =>
    Response.json({
      projects: [
        {
          ...snapshot.projects[0],
          workspaces: [
            { ...snapshot.projects[0].workspaces[0], sessionIds: ["saved"] },
          ],
        },
      ],
    }),
  );
  const fetchBase = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input), "http://localhost").pathname === "/api/sessions"
        ? sessions
        : fetchBase(input, init),
    { preconnect: fetchBase.preconnect },
  );
  const changes: unknown[][] = [];
  try {
    renderSidebar({ onCwdChange: (...args) => changes.push(args) });
    await expandProject();
    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    assert.ok(changes.some((args) => args[6] === "pending"));
    resolveSessions(
      Response.json({
        sessions: [
          {
            id: "saved",
            cwd: "/workspace",
            path: "/saved",
            created: "2026-01-01",
            modified: "2026-01-02",
            messageCount: 1,
            firstMessage: "hello",
          },
        ],
      }),
    );
    await waitFor(() => assert.equal(changes.at(-1)?.[6], "resolved"));
    assert.equal((changes.at(-1)?.[5] as SessionInfo).id, "saved");
  } finally {
    restore();
  }
});

test("collapsing the connected host leaves the offline host's repos visible", async () => {
  const restore = setup((url) => {
    const offline = url.searchParams.get("host") === "remote";
    return Response.json(
      offline
        ? {
            projects: [
              {
                ...snapshot.projects[0],
                id: "remote-project",
                name: "Offline project",
                workspaces: [
                  {
                    ...snapshot.projects[0].workspaces[0],
                    id: "remote-workspace",
                    name: "Offline workspace",
                  },
                ],
              },
            ],
          }
        : snapshot,
    );
  });
  try {
    render(
      React.createElement(HierarchySidebar, {
        ...noSystemsSidebar,
        hosts: [
          { id: "local", label: "Local", status: "omp-missing" },
          { id: "remote", label: "Remote", status: "offline" },
        ],
        sessions: [],
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
        hasUndismissedExit: () => false,
        collapsedHosts: new Set(["local"]),
        onToggleHost() {},
        onSelectSession() {},
        onAddProject() {},
        onChanged() {},
      }),
    );
    await expandProject("Offline project");
    assert.ok(await screen.findByRole("button", { name: "Offline workspace" }));
    assert.equal(screen.queryByRole("button", { name: "Workspace" }), null);
    assert.equal(
      screen
        .getByRole("button", { name: "Local" })
        .getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      screen
        .getByRole("button", { name: "Remote" })
        .getAttribute("aria-expanded"),
      "true",
    );
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
    await expandProject();
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
    await expandProject();
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
    await expandProject();
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
    await expandProject();
    fireEvent.click(await screen.findByLabelText("Actions for repo Project"));
    assert.equal(
      screen.getByRole("button", { name: "Repo settings" }).textContent?.trim(),
      "Repo settings",
    );
    fireEvent.click(screen.getByRole("button", { name: "Unregister repo" }));
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
    ...noSystemsSidebar,
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
    hasUndismissedExit: () => false,
    collapsedHosts: new Set<string>(),
    onToggleHost() {},
    onSelectSession: (value: SessionInfo) => selected.push(value),
    onAddProject() {},
    onChanged() {},
  };
  try {
    const view = render(React.createElement(HierarchySidebar, props));
    await expandProject();
    await screen.findByRole("button", { name: "Workspace" });
    assert.equal(screen.queryByRole("button", { name: "Saved chat" }), null);
    view.rerender(
      React.createElement(HierarchySidebar, {
        ...props,
        searchQuery: "saved",
        matchedSessionIds: new Set([sessionKey("chat-1")]),
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
          ...noSystemsSidebar,
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
          hasUndismissedExit: () => false,
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
        ...noSystemsSidebar,
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
        hasUndismissedExit: () => false,
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
        ...noSystemsSidebar,
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
        matchedSessionIds: new Set([sessionKey("chat-1")]),
        runningOnly: false,
        runningSessionIds: new Set<string>(),
        awaitingInputIds: new Set<string>(),
        unreadSessionIds: new Set<string>(),
        hasUndismissedExit: () => false,
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

test("manager setup and teardown stay visible in the sidebar after dismissal", async () => {
  const project = { ...snapshot.projects[0], kind: "git" };
  const feature = {
    ...project.workspaces[0],
    id: "feature",
    path: "/workspace-feature",
    name: "Feature",
    isDefault: false,
  };
  const hierarchy = { projects: [project] };
  const restore = setup(() => Response.json(hierarchy));
  const createReply = Promise.withResolvers<Response>();
  const deleteReply = Promise.withResolvers<Response>();
  const statusReply = Promise.withResolvers<Response>();
  const baseFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname !== "/api/worktrees") return baseFetch(input, init);
      if (url.searchParams.get("action") === "branches") {
        return Response.json({
          local: ["main"],
          remote: [],
          defaultRef: "main",
        });
      }
      if (url.searchParams.get("action") === "status")
        return statusReply.promise;
      const request = JSON.parse(String(init?.body));
      if (request.action === "create") return createReply.promise;
      if (request.action === "delete") return deleteReply.promise;
      throw new Error(`Unexpected action: ${request.action}`);
    },
    { preconnect: baseFetch.preconnect },
  );
  const dismiss = () =>
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      code: "Escape",
    });
  const openManager = async () => {
    fireEvent.click(await screen.findByLabelText("Actions for repo Project"));
    fireEvent.click(screen.getByRole("button", { name: "Manage workspaces" }));
    return screen.findByRole("dialog", { name: "Manage workspaces" });
  };
  try {
    renderSidebar();
    await openManager();
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Branch name" }), {
      target: { value: "feature" },
    });
    await waitFor(() =>
      assert.equal(
        (screen.getByRole("button", { name: "Create" }) as HTMLButtonElement)
          .disabled,
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    dismiss();
    await waitFor(() =>
      assert.ok(!screen.queryByRole("dialog", { name: "Create workspace" })),
    );
    dismiss();
    await waitFor(() =>
      assert.ok(!screen.queryByRole("dialog", { name: "Manage workspaces" })),
    );
    assert.ok(screen.getByTitle("Building workspace…"));

    hierarchy.projects = [
      { ...project, workspaces: [...project.workspaces, feature] },
    ];
    const job = {
      id: "setup-job",
      workspaceId: feature.id,
      status: "running",
      stage: "postBlocking",
    };
    createReply.resolve(Response.json(job));
    const featureButton = await screen.findByRole("button", {
      name: "Feature",
    });
    const featureRow = featureButton.closest(".sidebar-workspace-row");
    assert.ok(featureRow?.contains(screen.getByTitle("Setting up workspace…")));
    statusReply.resolve(Response.json({ ...job, status: "complete" }));
    await waitFor(
      () => assert.ok(!screen.queryByTitle("Setting up workspace…")),
      { timeout: 3000 },
    );

    await openManager();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete workspace" }),
    );
    await screen.findByText("Deleting workspace…");
    dismiss();
    await waitFor(() =>
      assert.ok(!screen.queryByRole("dialog", { name: "Manage workspaces" })),
    );
    assert.ok(featureRow?.contains(screen.getByTitle("Deleting…")));
    hierarchy.projects = [project];
    deleteReply.resolve(Response.json({ status: "deleted" }));
    await waitFor(() =>
      assert.ok(!screen.queryByRole("button", { name: "Feature" })),
    );
    assert.equal(screen.queryByTitle("Deleting…"), null);
  } finally {
    restore();
  }
});
