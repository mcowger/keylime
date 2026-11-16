import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import React from "react";
import type { SessionSidebar } from "./SessionSidebar";
import type { ChatWindow } from "./ChatWindow";
import type { WorkspaceTerminalTabs } from "./WorkspaceTerminalTabs";
import type { EventStreamChannel } from "@/lib/event-stream";
import { setDraft, clearDraft } from "@/lib/draft-store";
import { newChatDraftKey } from "@/lib/project-ordering";
const { render, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react/pure.js");

const projects = ["/repo", "/repo/worktrees/B", "/other"].map((path) => ({
  path,
  hostId: "local",
  name: path,
}));
const empty = () => null;
mock.module("./SessionSidebar", () => ({
  SessionSidebar: (props: React.ComponentProps<typeof SessionSidebar>) => {
    React.useEffect(() => {
      props.onWorkspaceOptionsChange!(projects, null, "/repo", "local");
    }, []);
    React.useEffect(() => {
      if (props.selectedCwd)
        props.onCwdChange!(
          props.selectedCwd,
          props.selectedCwd,
          "local",
          undefined,
          true,
        );
    }, [props.selectedCwd]);
    return React.createElement(
      "nav",
      null,
      projects.map(({ path }) =>
        React.createElement(
          "button",
          { key: path, onClick: () => props.onCwdChange!(path, path, "local") },
          path,
        ),
      ),
      React.createElement(
        "button",
        {
          onClick: () =>
            props.onNewWorkspace!({
              path: "/repo",
              hostId: "local",
              projectKind: "git",
            }),
        },
        "New workspace",
      ),
      React.createElement(
        "button",
        {
          onClick: () =>
            props.onSelectSession({
              id: "saved",
              cwd: "/repo/worktrees/B",
              path: "/saved.jsonl",
              created: "2026-11-14",
              modified: "2026-11-14",
              messageCount: 0,
              firstMessage: "",
              name: "Saved",
            }),
        },
        "Open saved nested chat",
      ),
      React.createElement("button", {
        onClick: () => props.onCwdChange!("/other", "/other", "local", undefined, false, {
          id: "remote-saved", cwd: "/other", path: "/saved.jsonl", created: "2026-11-14",
          modified: "2026-11-14", messageCount: 1, firstMessage: "hello", name: "Existing",
        }),
      }, "Open workspace with saved chat"),
      React.createElement("button", { onClick: () => props.onCwdChange!("/other", "/other", "local", undefined, false, undefined, "pending") }, "Pending workspace"),
      React.createElement("button", { onClick: () => props.onCwdChange!("/other", "/other", "local", undefined, false, { id: "late", cwd: "/other", path: "/late", created: "2026-11-14", modified: "2026-11-14", messageCount: 1, firstMessage: "hello" }, "resolved") }, "Resolve workspace"),
    );
  },
}));
let prepareWorkspace: NonNullable<
  React.ComponentProps<typeof ChatWindow>["prepareNewWorkspace"]
>;
mock.module("./ChatWindow", () => ({
  ChatWindow: (props: React.ComponentProps<typeof ChatWindow>) => {
    prepareWorkspace = props.prepareNewWorkspace!;
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "main",
        null,
        props.session?.cwd ?? props.newSessionCwd,
      ),
      React.createElement(
        "button",
        {
          onClick: () =>
            props.onSessionCreated!({
              id: "created",
              cwd: "/repo/worktrees/B",
              path: "",
              created: "2026-11-14",
              modified: "2026-11-14",
              messageCount: 1,
              firstMessage: "hi",
            }),
        },
        "Create session",
      ),
    );
  },
}));
for (const [path, name] of [
  ["./SettingsConfig", "SettingsConfig"],
  ["./CommandPaletteMount", "CommandPaletteMount"],
  ["./LocalDaemonBanner", "LocalDaemonBanner"],
  ["./NotificationBell", "NotificationBell"],
] as const) {
  mock.module(path, () => ({ [name]: empty }));
}
let tabProps: React.ComponentProps<typeof WorkspaceTerminalTabs>;
const streams: {
  channel: EventStreamChannel;
  closed: boolean;
  onmessage?: (event: { data: string }) => void;
  close(): void;
  addEventListener(): void;
  removeEventListener(): void;
}[] = [];
mock.module("./WorkspaceTerminalTabs", () => ({
  WorkspaceTerminalTabs: (
    props: React.ComponentProps<typeof WorkspaceTerminalTabs>,
  ) => {
    tabProps = props;
    return React.createElement(
      "output",
      { "data-testid": "workspace-tabs" },
      JSON.stringify({ cwd: props.cwd, tabs: props.chatTabs }),
    );
  },
}));
mock.module("@/hooks/useHostRows", () => ({
  useHostRows: () => ({ hosts: [], pools: [] }),
}));
mock.module("@/hooks/useNotifications", () => ({
  useNotifications: () => ({}),
}));
const transport = await import("@/lib/event-stream");
mock.module("@/lib/event-stream", () => ({
  ...transport,
  openEventStream: (channel: EventStreamChannel) => {
    const stream = {
      channel,
      closed: false,
      close() {
        this.closed = true;
      },
      addEventListener() {},
      removeEventListener() {},
    };
    streams.push(stream);
    return stream;
  },
}));
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};
window.matchMedia = globalThis.matchMedia;
Object.defineProperty(document, "fonts", {
  value: new EventTarget(),
  configurable: true,
});
globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) =>
  Response.json(
    String(url).includes("cwd/validate") ? { cwd: "/repo" } : {},
  )) as typeof fetch;
const { AppShell } = await import("./AppShell.tsx");

test("workspace entry opens its registered saved chat on a new browser", async () => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  const view = render(React.createElement(AppShell, { appName: "Keylime" }));
  await waitFor(() => assert.equal(tabProps.cwd, "/repo"));
  fireEvent.click(view.getByRole("button", { name: "Open workspace with saved chat" }));
  await waitFor(() => assert.ok(tabProps.chatTabs.some((tab) => tab.sessionId === "remote-saved")));
  assert.equal(window.location.search, "?session=remote-saved");
  cleanup();
});
test("delayed discovery replaces only the untouched auto-created chat", async () => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  const view = render(React.createElement(AppShell, { appName: "Keylime" }));
  await waitFor(() => assert.equal(tabProps.cwd, "/repo"));
  fireEvent.click(view.getByRole("button", { name: "Pending workspace" }));
  await waitFor(() => assert.equal(tabProps.cwd, "/other"));
  fireEvent.click(view.getByRole("button", { name: "Resolve workspace" }));
  await waitFor(() => assert.equal(window.location.search, "?session=late"));
  assert.ok(tabProps.chatTabs.some((tab) => tab.sessionId === "late"));
  cleanup();
});
test("delayed discovery preserves a draft edited after workspace entry", async () => {
  sessionStorage.clear();
  const key = newChatDraftKey("/other");
  clearDraft(key);
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  const view = render(React.createElement(AppShell, { appName: "Keylime" }));
  await waitFor(() => assert.equal(tabProps.cwd, "/repo"));
  fireEvent.click(view.getByRole("button", { name: "Pending workspace" }));
  await waitFor(() => assert.equal(tabProps.cwd, "/other"));
  setDraft(key, { value: "my draft", images: [], files: [] });
  fireEvent.click(view.getByRole("button", { name: "Resolve workspace" }));
  assert.equal(window.location.search, "");
  assert.ok(!tabProps.chatTabs.some((tab) => tab.sessionId === "late"));
  clearDraft(key);
  cleanup();
});
test("restored and nested workspaces switch on the first click", async () => {
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  const view = render(React.createElement(AppShell, { appName: "Keylime" }));
  const main = () => view.container.querySelector("main main")?.textContent;
  await waitFor(() => assert.equal(main(), "/repo"));
  for (const path of [
    "/other",
    "/repo",
    "/repo/worktrees/B",
    "/repo",
    "/other",
  ]) {
    fireEvent.click(view.getByRole("button", { name: path }));
    await waitFor(() => assert.equal(main(), path));
  }
  fireEvent.click(view.getByRole("button", { name: "Open saved nested chat" }));
  await waitFor(() => assert.equal(main(), "/repo/worktrees/B"));
  fireEvent.click(view.getByRole("button", { name: "/repo" }));
  await waitFor(() => assert.equal(main(), "/repo"));
  cleanup();
});

test("a quick-created workspace session leaves the parent workspace clickable", async () => {
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  const view = render(React.createElement(AppShell, { appName: "Keylime" }));
  const main = () => view.container.querySelector("main main")?.textContent;
  await waitFor(() => assert.equal(main(), "/repo"));
  fireEvent.click(view.getByRole("button", { name: "Create session" }));
  await waitFor(() => assert.equal(main(), "/repo/worktrees/B"));
  fireEvent.click(view.getByRole("button", { name: "/other" }));
  await waitFor(() => assert.equal(main(), "/other"));
  fireEvent.click(view.getByRole("button", { name: "/repo/worktrees/B" }));
  await waitFor(() => assert.equal(main(), "/repo/worktrees/B"));
  cleanup();
});

test("a pending workspace does not own the parent workspace tabs or its restored selection", async () => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  const view = render(React.createElement(AppShell, { appName: "Keylime" }));
  const tabs = () =>
    JSON.parse(view.getByTestId("workspace-tabs").textContent!);
  await waitFor(() => assert.equal(tabs().cwd, "/repo"));
  const key = "keylime:workspace-chat-tabs:active:local:/repo";
  const parent = sessionStorage.getItem(key);
  assert.ok(parent);
  fireEvent.click(view.getByRole("button", { name: "New workspace" }));
  await waitFor(() => assert.equal(tabs().cwd, null));
  assert.deepEqual(tabs().tabs, []);
  assert.equal(sessionStorage.getItem(key), parent);
  fireEvent.click(view.getByRole("button", { name: "/repo" }));
  await waitFor(() => assert.equal(tabs().cwd, "/repo"));
  assert.equal(tabs().tabs.length, 1);
  assert.equal(sessionStorage.getItem(key), parent);
  cleanup();
});

test("creating a workspace from another workspace survives sidebar synchronization", async () => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  const view = render(React.createElement(AppShell, { appName: "Keylime" }));
  const tabs = () =>
    JSON.parse(view.getByTestId("workspace-tabs").textContent!);
  await waitFor(() => assert.equal(tabs().cwd, "/repo"));
  const parent = sessionStorage.getItem(
    "keylime:workspace-chat-tabs:active:local:/repo",
  );
  fireEvent.click(view.getByRole("button", { name: "/other" }));
  await waitFor(() => assert.equal(tabs().cwd, "/other"));
  fireEvent.click(view.getByRole("button", { name: "New workspace" }));
  await waitFor(() => assert.equal(tabs().cwd, null));
  assert.deepEqual(tabs().tabs, []);
  assert.equal(
    sessionStorage.getItem("keylime:workspace-chat-tabs:active:local:/repo"),
    parent,
  );
  fireEvent.click(view.getByRole("button", { name: "/repo" }));
  await waitFor(() => assert.equal(tabs().cwd, "/repo"));
  assert.equal(tabs().tabs.length, 1);
  cleanup();
});

test("shared chats appear without local membership and can be selected or dismissed without archiving", async () => {
  sessionStorage.clear();
  streams.length = 0;
  const originalFetch = globalThis.fetch;
  const session = {
    id: "shared",
    cwd: "/repo",
    path: "/shared.jsonl",
    created: "2026-11-14",
    modified: "2026-11-14",
    messageCount: 1,
    firstMessage: "hello",
    name: "Shared",
  };
  const requests: string[] = [];
  globalThis.fetch = (async (
    url: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1],
  ) => {
    requests.push(String(url));
    if (String(url) === "/api/sessions")
      return Response.json({ sessions: [session] });
    return originalFetch(url, options);
  }) as typeof fetch;
  try {
    window.history.replaceState(null, "", "/?cwd=%2Frepo");
    const view = render(React.createElement(AppShell, { appName: "Keylime" }));
    await waitFor(() => assert.equal(tabProps.cwd, "/repo"));
    const snapshot = streams.find(
      (stream) => stream.channel.kind === "open-chats",
    );
    assert.ok(snapshot);
    const onSnapshot = snapshot.onmessage;
    assert.ok(onSnapshot);
    await act(async () =>
      onSnapshot({ data: JSON.stringify({ sessionIds: ["shared"] }) }),
    );
    await waitFor(() =>
      assert.ok(tabProps.chatTabs.some((tab) => tab.title === "Shared")),
    );
    assert.ok(tabProps.openSessionIds.includes("shared"));
    assert.equal(
      streams.filter(
        (stream) => stream.channel.kind === "open-chat" && !stream.closed,
      ).length,
      0,
    );
    await act(async () => tabProps.onCloseChat("shared:shared"));
    assert.ok(!tabProps.chatTabs.some((tab) => tab.title === "Shared"));
    assert.ok(!requests.some((url) => url.includes("/archive")));
    await act(async () =>
      onSnapshot({ data: JSON.stringify({ sessionIds: [] }) }),
    );
    await act(async () =>
      onSnapshot({ data: JSON.stringify({ sessionIds: ["shared"] }) }),
    );
    await waitFor(() =>
      assert.ok(tabProps.chatTabs.some((tab) => tab.title === "Shared")),
    );
    act(() => tabProps.onSelectChat("shared:shared"));
    await waitFor(() =>
      assert.equal(
        streams.filter(
          (stream) =>
            stream.channel.kind === "open-chat" &&
            stream.channel.sessionId === "shared" &&
            !stream.closed,
        ).length,
        1,
      ),
    );
    assert.equal(
      tabProps.chatTabs.filter((tab) => tab.sessionId === "shared").length,
      1,
    );
    await act(async () =>
      onSnapshot({ data: JSON.stringify({ sessionIds: [] }) }),
    );
    assert.ok(tabProps.chatTabs.some((tab) => tab.sessionId === "shared"));
    assert.ok(view);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("entering a workspace selects its first shared chat and shows all shared chats", async () => {
  sessionStorage.clear();
  streams.length = 0;
  const originalFetch = globalThis.fetch;
  const sessions = ["first", "second"].map((id) => ({
    id, cwd: "/other", path: `/${id}.jsonl`, created: "2026-11-14",
    modified: "2026-11-14", messageCount: 1, firstMessage: id, name: id,
  }));
  globalThis.fetch = (async (url, options) => String(url) === "/api/sessions"
    ? Response.json({ sessions }) : originalFetch(url, options)) as typeof fetch;
  try {
    window.history.replaceState(null, "", "/?cwd=%2Frepo");
    const view = render(React.createElement(AppShell, { appName: "Keylime" }));
    await waitFor(() => assert.equal(tabProps.cwd, "/repo"));
    const source = streams.find((stream) => stream.channel.kind === "open-chats");
    assert.ok(source?.onmessage);
    await act(async () => source.onmessage!({ data: JSON.stringify({ sessionIds: ["first", "second"] }) }));
    await waitFor(() => assert.ok(tabProps.openSessionIds.includes("second")));
    fireEvent.click(view.getByRole("button", { name: "/other" }));
    await waitFor(() => assert.equal(tabProps.chatTabs.find((tab) => tab.id === tabProps.activeChatId)?.sessionId, "first"));
    assert.deepEqual(tabProps.chatTabs.map((tab) => tab.sessionId), ["first", "second"]);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("workspace entry reconciles a restored draft when shared chat discovery resolves", async () => {
  sessionStorage.clear();
  sessionStorage.setItem("keylime:workspace-chat-tabs", JSON.stringify([
    { id: "draft", cwd: "/other", hostId: undefined, session: null, creation: { id: "draft-creation" } },
  ]));
  streams.length = 0;
  const originalFetch = globalThis.fetch;
  const { promise: delayed, resolve: resolveSessions } = Promise.withResolvers<Response>();
  globalThis.fetch = (async (url, options) => String(url) === "/api/sessions"
    ? delayed : originalFetch(url, options)) as typeof fetch;
  try {
    window.history.replaceState(null, "", "/?cwd=%2Frepo");
    const view = render(React.createElement(AppShell, { appName: "Keylime" }));
    await waitFor(() => assert.equal(tabProps.cwd, "/repo"));
    const source = streams.find((stream) => stream.channel.kind === "open-chats");
    assert.ok(source?.onmessage);
    await act(async () => source.onmessage!({ data: JSON.stringify({ sessionIds: ["shared"] }) }));
    fireEvent.click(view.getByRole("button", { name: "/other" }));
    await waitFor(() => assert.equal(tabProps.activeChatId, "draft"));
    fireEvent.click(view.getByRole("button", { name: "/other" }));
    await act(async () => resolveSessions(Response.json({ sessions: [{
      id: "shared", cwd: "/other", path: "/shared.jsonl", created: "2026-11-14",
      modified: "2026-11-14", messageCount: 1, firstMessage: "shared", name: "Shared",
    }] })));
    await waitFor(() => assert.equal(tabProps.chatTabs.find((tab) => tab.id === tabProps.activeChatId)?.sessionId, "shared"));
    assert.ok(tabProps.chatTabs.some((tab) => tab.id === "draft"));
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("new workspace chat proceeds while post setup is running or has failed", async () => {
  const originalFetch = globalThis.fetch;
  sessionStorage.clear();
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  let status = "running";
  globalThis.fetch = (async (
    url: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1],
  ) => {
    if (String(url) === "/api/worktrees" && options?.method === "POST")
      return Response.json({
        id: "job",
        input: { name: "Feature" },
        status,
        stage: "postNonBlocking",
        workspaceId: "workspace",
        workspacePath: "/repo/worktrees/feature",
        error: status === "failed" ? "setup failed" : undefined,
      });
    return originalFetch(url, options);
  }) as typeof fetch;
  try {
    const view = render(React.createElement(AppShell, { appName: "Keylime" }));
    await waitFor(() =>
      assert.ok(view.getByRole("button", { name: "New workspace" })),
    );
    fireEvent.click(view.getByRole("button", { name: "New workspace" }));
    await waitFor(() => assert.equal(typeof prepareWorkspace, "function"));
    await act(async () => {
      assert.deepEqual(await prepareWorkspace("first prompt"), {
        cwd: "/repo/worktrees/feature",
        name: "Feature",
      });
    });
    cleanup();
    status = "failed";
    sessionStorage.clear();
    const second = render(
      React.createElement(AppShell, { appName: "Keylime" }),
    );
    fireEvent.click(second.getByRole("button", { name: "New workspace" }));
    await waitFor(() => assert.equal(typeof prepareWorkspace, "function"));
    await act(async () => {
      assert.deepEqual(await prepareWorkspace("first prompt"), {
        cwd: "/repo/worktrees/feature",
        name: "Feature",
      });
    });
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("new workspace chat waits for blocking setup and rejects its failure", async () => {
  const originalFetch = globalThis.fetch;
  sessionStorage.clear();
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  let fail = false;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const { promise: statusRequested, resolve: requested } =
    Promise.withResolvers<void>();
  const job = (stage: string, status = "running") => ({
    id: "job",
    input: { name: "Feature" },
    status,
    stage,
    workspaceId: "workspace",
    workspacePath: "/repo/worktrees/feature",
    ...(status === "failed" ? { error: "blocking failed" } : {}),
  });
  globalThis.fetch = (async (
    url: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1],
  ) => {
    if (String(url) === "/api/worktrees" && options?.method === "POST")
      return Response.json(job("postBlocking", fail ? "failed" : "running"));
    if (String(url).includes("action=status")) {
      requested();
      await gate;
      return Response.json(job("postNonBlocking"));
    }
    return originalFetch(url, options);
  }) as typeof fetch;
  try {
    const view = render(React.createElement(AppShell, { appName: "Keylime" }));
    await waitFor(() =>
      assert.equal(
        JSON.parse(view.getByTestId("workspace-tabs").textContent!).cwd,
        "/repo",
      ),
    );
    fireEvent.click(view.getByRole("button", { name: "New workspace" }));
    await waitFor(() => assert.equal(typeof prepareWorkspace, "function"));
    let settled = false;
    let pending = Promise.resolve<unknown>(undefined);
    await act(async () => {
      pending = prepareWorkspace("prompt").then((value) => {
        settled = true;
        return value;
      });
    });
    await act(async () => statusRequested);
    assert.equal(settled, false);
    await act(async () => {
      release();
      assert.deepEqual(await pending, {
        cwd: "/repo/worktrees/feature",
        name: "Feature",
      });
    });
    cleanup();
    fail = true;
    sessionStorage.clear();
    const second = render(
      React.createElement(AppShell, { appName: "Keylime" }),
    );
    fireEvent.click(second.getByRole("button", { name: "/repo" }));
    await waitFor(() =>
      assert.equal(
        JSON.parse(second.getByTestId("workspace-tabs").textContent!).cwd,
        "/repo",
      ),
    );
    fireEvent.click(second.getByRole("button", { name: "New workspace" }));
    await waitFor(() => assert.equal(typeof prepareWorkspace, "function"));
    await act(async () => {
      await assert.rejects(prepareWorkspace("prompt"), /blocking failed/);
    });
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});
