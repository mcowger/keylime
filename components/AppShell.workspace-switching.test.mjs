import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import React from "react";
const { render, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react/pure.js");

const projects = ["/repo", "/repo/worktrees/B", "/other"].map((path) => ({
  path,
  hostId: "local",
  name: path,
}));
const empty = () => null;
mock.module("./SessionSidebar", () => ({
  SessionSidebar: (props) => {
    React.useEffect(() => {
      props.onWorkspaceOptionsChange(projects, null, "/repo", "local");
    }, []);
    React.useEffect(() => {
      if (props.selectedCwd)
        props.onCwdChange(props.selectedCwd, props.selectedCwd, "local", undefined, true);
    }, [props.selectedCwd]);
    return React.createElement(
      "nav",
      null,
      projects.map(({ path }) =>
        React.createElement(
          "button",
          { key: path, onClick: () => props.onCwdChange(path, path, "local") },
          path,
        ),
      ),
      React.createElement("button", {
        onClick: () => props.onNewWorkspace({ path: "/repo", hostId: "local", projectKind: "git" }),
      }, "New workspace"),
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
              name: "Saved",
            }),
        },
        "Open saved nested chat",
      ),
    );
  },
}));
mock.module("./ChatWindow", () => ({
  ChatWindow: (props) =>
    React.createElement(
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
            props.onSessionCreated({
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
    ),
}));
for (const [path, name] of [
  ["./SettingsConfig", "SettingsConfig"],
  ["./CommandPaletteMount", "CommandPaletteMount"],
  ["./LocalDaemonBanner", "LocalDaemonBanner"],
  ["./NotificationBell", "NotificationBell"],
]) {
  mock.module(path, () => ({ [name]: empty }));
}
let tabProps;
const streams = [];
mock.module("./WorkspaceTerminalTabs", () => ({
  WorkspaceTerminalTabs: (props) => {
    tabProps = props;
    return React.createElement("output", { "data-testid": "workspace-tabs" }, JSON.stringify({ cwd: props.cwd, tabs: props.chatTabs }));
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
  openEventStream: (channel) => {
    const stream = { channel, closed: false, close() { this.closed = true; }, addEventListener() {}, removeEventListener() {} };
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
document.fonts = new EventTarget();
globalThis.fetch = async (url) =>
  Response.json(String(url).includes("cwd/validate") ? { cwd: "/repo" } : {});
const { AppShell } = await import("./AppShell.tsx");

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
    fireEvent.click(view.getByRole("button", { name: path, exact: true }));
    await waitFor(() => assert.equal(main(), path));
  }
  fireEvent.click(view.getByRole("button", { name: "Open saved nested chat" }));
  await waitFor(() => assert.equal(main(), "/repo/worktrees/B"));
  fireEvent.click(view.getByRole("button", { name: "/repo", exact: true }));
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
  fireEvent.click(view.getByRole("button", { name: "/other", exact: true }));
  await waitFor(() => assert.equal(main(), "/other"));
  fireEvent.click(
    view.getByRole("button", { name: "/repo/worktrees/B", exact: true }),
  );
  await waitFor(() => assert.equal(main(), "/repo/worktrees/B"));
  cleanup();
});

test("a pending workspace does not own the parent workspace tabs or its restored selection", async () => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  const view = render(React.createElement(AppShell, { appName: "Keylime" }));
  const tabs = () => JSON.parse(view.getByTestId("workspace-tabs").textContent);
  await waitFor(() => assert.equal(tabs().cwd, "/repo"));
  const key = "keylime:workspace-chat-tabs:active:local:/repo";
  const parent = sessionStorage.getItem(key);
  assert.ok(parent);
  fireEvent.click(view.getByRole("button", { name: "New workspace", exact: true }));
  await waitFor(() => assert.equal(tabs().cwd, null));
  assert.deepEqual(tabs().tabs, []);
  assert.equal(sessionStorage.getItem(key), parent);
  fireEvent.click(view.getByRole("button", { name: "/repo", exact: true }));
  await waitFor(() => assert.equal(tabs().cwd, "/repo"));
  assert.equal(tabs().tabs.length, 1);
  assert.equal(sessionStorage.getItem(key), parent);
  cleanup();
});

test("creating a workspace from another workspace survives sidebar synchronization", async () => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/?cwd=%2Frepo");
  const view = render(React.createElement(AppShell, { appName: "Keylime" }));
  const tabs = () => JSON.parse(view.getByTestId("workspace-tabs").textContent);
  await waitFor(() => assert.equal(tabs().cwd, "/repo"));
  const parent = sessionStorage.getItem("keylime:workspace-chat-tabs:active:local:/repo");
  fireEvent.click(view.getByRole("button", { name: "/other", exact: true }));
  await waitFor(() => assert.equal(tabs().cwd, "/other"));
  fireEvent.click(view.getByRole("button", { name: "New workspace", exact: true }));
  await waitFor(() => assert.equal(tabs().cwd, null));
  assert.deepEqual(tabs().tabs, []);
  assert.equal(sessionStorage.getItem("keylime:workspace-chat-tabs:active:local:/repo"), parent);
  fireEvent.click(view.getByRole("button", { name: "/repo", exact: true }));
  await waitFor(() => assert.equal(tabs().cwd, "/repo"));
  assert.equal(tabs().tabs.length, 1);
  cleanup();
});

test("shared chats appear without local membership and can be selected or dismissed without archiving", async () => {
  sessionStorage.clear();
  streams.length = 0;
  const originalFetch = globalThis.fetch;
  const session = { id: "shared", cwd: "/repo", path: "/shared.jsonl", created: "2026-11-14", modified: "2026-11-14", messageCount: 1, firstMessage: "hello", name: "Shared" };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    if (String(url) === "/api/sessions") return Response.json({ sessions: [session] });
    return originalFetch(url, options);
  };
  try {
    window.history.replaceState(null, "", "/?cwd=%2Frepo");
    const view = render(React.createElement(AppShell, { appName: "Keylime" }));
    await waitFor(() => assert.equal(tabProps.cwd, "/repo"));
    const snapshot = streams.find((stream) => stream.channel.kind === "open-chats");
    await act(async () => snapshot.onmessage({ data: JSON.stringify({ sessionIds: ["shared"] }) }));
    await waitFor(() => assert.ok(tabProps.chatTabs.some((tab) => tab.title === "Shared")));
    assert.ok(tabProps.openSessionIds.includes("shared"));
    assert.equal(streams.filter((stream) => stream.channel.kind === "open-chat" && !stream.closed).length, 0);
    await act(async () => tabProps.onCloseChat("shared:shared"));
    assert.ok(!tabProps.chatTabs.some((tab) => tab.title === "Shared"));
    assert.ok(!requests.some((url) => url.includes("/archive")));
    await act(async () => snapshot.onmessage({ data: JSON.stringify({ sessionIds: [] }) }));
    await act(async () => snapshot.onmessage({ data: JSON.stringify({ sessionIds: ["shared"] }) }));
    await waitFor(() => assert.ok(tabProps.chatTabs.some((tab) => tab.title === "Shared")));
    act(() => tabProps.onSelectChat("shared:shared"));
    await waitFor(() => assert.equal(streams.filter((stream) => stream.channel.kind === "open-chat" && stream.channel.sessionId === "shared" && !stream.closed).length, 1));
    assert.equal(tabProps.chatTabs.filter((tab) => tab.sessionId === "shared").length, 1);
    await act(async () => snapshot.onmessage({ data: JSON.stringify({ sessionIds: [] }) }));
    assert.ok(tabProps.chatTabs.some((tab) => tab.sessionId === "shared"));
    assert.ok(view);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});
