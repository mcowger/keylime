import "../../tests/setup-dom";
import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import type * as ReactTypes from "react";
import type { ChatTarget } from "../LiveChat";
import { nativeToolTarget } from "../tool-targets";

const React = createRequire(new URL("../../package.json", import.meta.url))(
  "react",
) as typeof ReactTypes;
mock.module("../node_modules/react/index.js", () => React);
mock.module("../node_modules/react-native/index.js", () => ({
  View: ({ children }: { children?: ReactTypes.ReactNode }) =>
    React.createElement("div", null, children),
  SafeAreaView: ({ children }: { children?: ReactTypes.ReactNode }) =>
    React.createElement("div", null, children),
  Text: ({ children }: { children?: ReactTypes.ReactNode }) =>
    React.createElement("span", null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactTypes.ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) =>
    React.createElement(
      "button",
      { onClick: onPress, "aria-label": accessibilityLabel },
      children,
    ),
  StatusBar: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useColorScheme: () => "dark",
  ActionSheetIOS: { showActionSheetWithOptions: () => {} },
}));
const session = {
  id: "nested-session",
  hostId: "remote",
  cwd: "/repo/pkg",
  name: "Nested chat",
  firstMessage: "Nested chat",
  messageCount: 1,
};
const workspace = {
  id: "workspace",
  path: "/repo",
  name: "main",
  isDefault: true,
  sessionIds: [session.id],
};
const project = {
  id: "project",
  name: "repo",
  path: "/repo",
  kind: "directory",
  workspaces: [workspace],
};
const byHost = { remote: { hierarchy: { projects: [project] } } };
mock.module("../keylime-http", () => ({
  KeylimeHttpError: class extends Error {},
  requestJson: async () => ({}),
}));
mock.module("../chat-mutations", () => ({
  archiveChat: async () => {},
  renameChat: async () => {},
}));
mock.module("../useKeylimeConnection", () => ({
  useKeylimeConnection: () => ({
    link: { subscribe: () => () => {} },
    status: "open",
  }),
}));
mock.module("../useHomeInventory", () => ({
  useHomeInventory: () => ({
    hosts: [{ id: "remote", label: "Remote", status: "offline" }],
    sessions: [session],
    active: [],
    recent: [],
    error: null,
  }),
}));
mock.module("../useWorkspaceInventory", () => ({
  useWorkspaceInventory: () => ({ byHost, refresh: () => {} }),
  workspaceForPath: () => undefined,
  locationForPath: () => ({ kind: "path" }),
}));
mock.module("../useShipSidebar", () => ({
  useShipSidebar: () => ({ states: {}, latest: {} }),
}));
mock.module("../useNativePreferences", () => ({
  useNativePreferences: () => ({
    preferences: {},
    onChangePreference: () => {},
    error: null,
  }),
}));
mock.module("../SearchArchive", () => ({
  ArchiveBrowser: () => null,
  SearchInput: () => null,
  useSidebarSearch: () => ({ query: "", matches: [], setQuery: () => {} }),
}));
mock.module("../HomeScreen", () => ({
  HomeScreen: ({
    onSelectSession,
  }: {
    onSelectSession: (value: typeof session) => void;
  }) =>
    React.createElement(
      "button",
      { onClick: () => onSelectSession(session) },
      "Open saved chat",
    ),
}));
mock.module("../LiveChat", () => ({
  LiveChat: ({
    target,
    onOpenActivityTarget,
  }: {
    target: ChatTarget | null;
    onOpenActivityTarget: (owner: string, kind: "file", value: string) => void;
  }) =>
    target?.sessionId
      ? React.createElement(
          "div",
          null,
          React.createElement("span", null, `Workspace ${target.path}`),
          React.createElement(
            "button",
            {
              onClick: () => {
                const result = nativeToolTarget(
                  {
                    type: "toolCall",
                    toolCallId: "read",
                    toolName: "read",
                    input: { path: "ideas.md" },
                  },
                  target.sessionCwd,
                );
                if (result?.kind === "file")
                  onOpenActivityTarget(target.key, "file", result.value);
              },
            },
            "Open tool file",
          ),
        )
      : null,
}));
mock.module("../WorkspacePanel", () => ({
  WorkspacePanel: ({
    initialFile,
    hostId,
  }: {
    initialFile?: string;
    hostId: string;
  }) => React.createElement("div", null, `${hostId}:${initialFile}`),
}));
for (const [path, names] of [
  ["../ChatLocationPicker", ["ChatLocationPicker"]],
  ["../ChatHeaderContext", ["ChatHeaderContext"]],
  ["../ChatActions", ["SessionActions"]],
  ["../SystemFlows", ["SystemFlows"]],
  ["../EffortDetails", ["EffortDetails"]],
  ["../RepoFlows", ["RepoFlows"]],
  ["../ShellIcons", ["ShipIcon", "SidebarMenuIcon", "WorkspacePanelIcon"]],
  ["../SettingsScreen", ["SettingsScreen"]],
  ["../ShipDialog", ["FinishShipDialog", "ShipDialog"]],
  ["../Sidebar", ["Sidebar"]],
  ["../WorkspaceTabs", ["WorkspaceTabs"]],
] as const)
  mock.module(path, () =>
    Object.fromEntries(names.map((name) => [name, () => null])),
  );
// Load after the isolated DOM and native-module mocks are installed.
const { render, fireEvent } = await import("@testing-library/react");
const { NavigationShell } = await import("../NavigationShell");

test("an imported subdirectory chat opens relative tool files on its host and session cwd", () => {
  const ui = render(
    <NavigationShell
      origin="https://fixture.example"
      onUnauthorized={() => {}}
      onChangeServer={() => {}}
    />,
  );
  try {
    fireEvent.click(ui.getByRole("button", { name: "Open saved chat" }));
    expect(ui.getByText("Workspace /repo")).toBeTruthy();
    fireEvent.click(ui.getByRole("button", { name: "Open tool file" }));
    expect(ui.getByText("remote:/repo/pkg/ideas.md")).toBeTruthy();
  } finally {
    ui.unmount();
  }
});
