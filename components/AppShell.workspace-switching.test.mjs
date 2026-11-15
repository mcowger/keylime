import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import React from "react";
const { render, fireEvent, waitFor, cleanup } =
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
mock.module("./WorkspaceTerminalTabs", () => ({
  WorkspaceTerminalTabs: (props) => React.createElement("output", { "data-testid": "workspace-tabs" }, JSON.stringify({ cwd: props.cwd, tabs: props.chatTabs })),
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
  openEventStream: () => ({
    close() {},
    addEventListener() {},
    removeEventListener() {},
  }),
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
