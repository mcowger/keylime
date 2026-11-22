import { useMemo, useRef, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import {
  ChatLocationPicker,
  type ChatLocationChoice,
} from "./ChatLocationPicker";
import { HomeScreen, type HomeSessionInfo } from "./HomeScreen";
import { LiveChat, type ChatTarget } from "./LiveChat";
import { RepoFlows, type RepoFlow } from "./RepoFlows";
import { SidebarMenuIcon, WorkspacePanelIcon } from "./ShellIcons";
import { SettingsScreen } from "./SettingsScreen";
import { Sidebar } from "./Sidebar";
import { theme } from "./theme";
import { useHomeInventory } from "./useHomeInventory";
import { useKeylimeConnection } from "./useKeylimeConnection";
import { useNativePreferences } from "./useNativePreferences";
import { WorkspacePanel } from "./WorkspacePanel";
import {
  isInWorkspace,
  locationForPath,
  useWorkspaceInventory,
} from "./useWorkspaceInventory";
import { WorkspaceTabs, type WorkspaceTab } from "./WorkspaceTabs";

export type WorkspaceLocation = {
  hostId: string;
  path: string;
  title: string;
  effortId?: string;
  project?: string;
};
type OpenTab = WorkspaceTab & {
  location: WorkspaceLocation;
  sessionId?: string;
};

const sessionTitle = (session: HomeSessionInfo) =>
  session.name || session.firstMessage || "New chat";
const tabKey = (host: string, id: string) => JSON.stringify([host, id]);

export function NavigationShell({
  origin,
  onUnauthorized,
  onChangeServer,
}: {
  origin: string;
  onUnauthorized: () => void;
  onChangeServer: () => void;
}) {
  const { link, status } = useKeylimeConnection(origin, onUnauthorized);
  const { hosts, sessions, active, recent, error } = useHomeInventory(
    origin,
    link,
    onUnauthorized,
  );
  const { byHost, refresh: refreshWorkspace } = useWorkspaceInventory(
    origin,
    hosts,
    onUnauthorized,
  );
  const preferences = useNativePreferences();
  const [panel, setPanel] = useState(false);
  const [repoFlow, setRepoFlow] = useState<RepoFlow | null>(null);
  const [choosingRepo, setChoosingRepo] = useState(false);
  const [section, setSection] = useState<"home" | "workspace" | "settings">(
    "home",
  );
  const [settingsFrom, setSettingsFrom] = useState<"home" | "workspace">(
    "home",
  );
  const [sidebar, setSidebar] = useState(false);
  const [menu, setMenu] = useState(false);
  const [location, setLocation] = useState<WorkspaceLocation | null>(null);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeKey, setActiveKey] = useState<string>();
  const [picker, setPicker] = useState<"project" | "workspace" | null>(null);
  const draftSeq = useRef(0);
  const dark = useColorScheme() !== "light";
  const colors = dark
    ? theme
    : {
        background: "#FAF9F6",
        panel: "#F2F0EA",
        border: "#E2DDD2",
        text: "#2B2823",
        muted: "#69635A",
        accent: "#B03E22",
      };
  const selected = tabs.find((tab) => tab.key === activeKey);
  const target: ChatTarget | null = location
    ? {
        key:
          selected?.key ??
          JSON.stringify([location.hostId, location.path, "draft"]),
        hostId: location.hostId,
        path: location.path,
        workspace: location.title,
        project: location.project ?? location.title,
        sessionId: selected?.sessionId ?? selected?.session?.id ?? null,
      }
    : null;

  const hierarchyByHost = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(byHost).map(([host, value]) => [
          host,
          value.hierarchy ?? (value.hierarchyError ? null : undefined),
        ]),
      ),
    [byHost],
  );
  const systemsByHost = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(byHost).map(([host, value]) => [
          host,
          value.systems ?? (value.systemsError ? null : undefined),
        ]),
      ),
    [byHost],
  );
  const workspaceTabs = location
    ? tabs
        .filter(
          (tab) =>
            tab.location.hostId === location.hostId &&
            tab.location.path === location.path,
        )
        .map((tab) => {
          const session = sessions?.find(
            (item) =>
              (item.hostId ?? "local") === location.hostId &&
              item.id === tab.sessionId,
          );
          return session
            ? { ...tab, session, title: sessionTitle(session) }
            : tab;
        })
    : [];
  const savedSessions = location
    ? (sessions ?? []).filter((item) => {
        const host = item.hostId ?? "local";
        if (location.effortId) {
          const owner = locationForPath(byHost, host, item.cwd);
          return (
            owner.kind === "effort" &&
            host === location.hostId &&
            owner.effort.id === location.effortId
          );
        }
        return isInWorkspace(
          byHost,
          host,
          item.cwd,
          location.hostId,
          location.path,
        );
      })
    : [];

  function goWorkspace(next: WorkspaceLocation) {
    setLocation(next);
    setActiveKey(
      tabs.find(
        (tab) =>
          tab.location.hostId === next.hostId &&
          tab.location.path === next.path,
      )?.key,
    );
    setSection("workspace");
    setSidebar(false);
  }

  function newChat(at = location) {
    if (!at) {
      setPicker("project");
      return;
    }
    const key = JSON.stringify([
      at.hostId,
      at.path,
      "draft",
      ++draftSeq.current,
    ]);
    setTabs((old) => [...old, { key, title: "New chat", location: at }]);
    setLocation(at);
    setActiveKey(key);
    setSidebar(false);
    setSection("workspace");
  }

  function onCreated(
    key: string,
    sessionId: string,
    hostId: string,
    path: string,
  ) {
    if (!location) return;
    setTabs((old) => {
      const existing = old.find((tab) => tab.key === key);
      if (existing)
        return old.map((tab) =>
          tab.key === key ? { ...tab, sessionId } : tab,
        );
      return [
        ...old,
        {
          key,
          title: "New chat",
          sessionId,
          location: { ...location, hostId, path },
        },
      ];
    });
    setActiveKey((current) => (current === undefined ? key : current));
  }

  const choices: ChatLocationChoice[] = [];
  for (const host of hosts) {
    const inventory = byHost[host.id];
    if (!inventory || inventory.unavailable) continue;
    for (const project of inventory.hierarchy?.projects ?? []) {
      if (
        picker === "workspace" &&
        (host.id !== location?.hostId ||
          project.name !== (location.project ?? location.title))
      )
        continue;
      const available = project.workspaces.filter(
        (workspace) => !workspace.unavailable,
      );
      for (const workspace of picker === "workspace"
        ? available
        : [available.find((item) => item.isDefault) ?? available[0]]) {
        if (!workspace) continue;
        const next = {
          hostId: host.id,
          path: workspace.path,
          title: workspace.name,
          project: project.name,
        };
        choices.push({
          key: JSON.stringify([host.id, workspace.id]),
          title: picker === "workspace" ? workspace.name : project.name,
          subtitle: workspace.path,
          onSelect: () => newChat(next),
        });
      }
    }
  }

  function openSession(item: HomeSessionInfo) {
    const hostId = item.hostId ?? "local";
    const owner = locationForPath(byHost, hostId, item.cwd);
    const belonging: WorkspaceLocation =
      owner.kind === "effort" && owner.effort.root
        ? {
            hostId,
            path: owner.effort.root,
            title: owner.effort.name,
            effortId: owner.effort.id,
          }
        : owner.kind === "workspace"
          ? {
              hostId,
              path: owner.workspace.path,
              title: owner.workspace.name,
              project: owner.project.name,
            }
          : {
              hostId,
              path: item.cwd,
              title: item.cwd.split("/").pop() || item.cwd,
            };
    const key = tabKey(hostId, item.id);
    setTabs((old) =>
      old.some(
        (tab) =>
          tab.key === key ||
          (tab.location.hostId === hostId && tab.sessionId === item.id),
      )
        ? old
        : [
            ...old,
            {
              key,
              location: belonging,
              title: sessionTitle(item),
              session: item,
              sessionId: item.id,
            },
          ],
    );
    setLocation(belonging);
    setActiveKey(
      tabs.find(
        (tab) => tab.location.hostId === hostId && tab.sessionId === item.id,
      )?.key ?? key,
    );
    setSidebar(false);
    setSection("workspace");
  }

  function closeTab(tab: WorkspaceTab) {
    setTabs((old) => old.filter((entry) => entry.key !== tab.key));
    if (activeKey === tab.key)
      setActiveKey(workspaceTabs.find((entry) => entry.key !== tab.key)?.key);
  }

  function openSettings() {
    setSettingsFrom(section === "workspace" ? "workspace" : "home");
    setMenu(false);
    setSidebar(false);
    setSection("settings");
  }

  return (
    <SafeAreaView
      style={[
        styles.root,
        { backgroundColor: sidebar ? colors.panel : colors.background },
      ]}
    >
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
      <View style={styles.body}>
        <View
          style={styles.body}
          accessibilityElementsHidden={sidebar}
          importantForAccessibility={sidebar ? "no-hide-descendants" : "auto"}
        >
          {section === "settings" ? (
            <SettingsScreen
              preferences={preferences.preferences}
              onChangePreference={preferences.onChangePreference}
              origin={origin}
              hosts={hosts}
              onUnauthorized={onUnauthorized}
              onBack={() => setSection(settingsFrom)}
            />
          ) : (
            <>
              <View
                style={[
                  styles.header,
                  { backgroundColor: colors.panel, borderColor: colors.border },
                ]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open sidebar"
                  onPress={() => {
                    setMenu(false);
                    setSidebar(true);
                  }}
                  style={styles.headerButton}
                >
                  <SidebarMenuIcon color={colors.text} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="More actions"
                  onPress={() => setMenu((old) => !old)}
                  style={styles.headerButton}
                >
                  <Text style={[styles.menuIcon, { color: colors.text }]}>
                    ⋯
                  </Text>
                </Pressable>
                <View style={styles.headerCenter}>
                  {section === "workspace" && location && (
                    <WorkspaceTabs
                      openTabs={workspaceTabs}
                      activeTabKey={activeKey}
                      savedSessions={savedSessions}
                      savedState={
                        byHost[location.hostId]?.unavailable
                          ? "unavailable"
                          : sessions
                            ? "ready"
                            : "loading"
                      }
                      onSelectTab={(tab) => setActiveKey(tab.key)}
                      onCloseTab={closeTab}
                      onSelectSaved={openSession}
                      onNewChat={() => newChat()}
                    />
                  )}
                </View>
                {section === "workspace" && location && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      panel ? "Close workspace panel" : "Open workspace panel"
                    }
                    accessibilityState={{ expanded: panel }}
                    onPress={() => setPanel((open) => !open)}
                    style={styles.headerButton}
                  >
                    <WorkspacePanelIcon color={colors.text} />
                  </Pressable>
                )}
              </View>
              {menu && (
                <View
                  style={[
                    styles.menu,
                    {
                      backgroundColor: colors.panel,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Pressable
                    accessibilityRole="button"
                    onPress={openSettings}
                    style={styles.menuItem}
                  >
                    <Text style={{ color: colors.text }}>Settings</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={onChangeServer}
                    style={styles.menuItem}
                  >
                    <Text style={{ color: colors.text }}>Change server</Text>
                  </Pressable>
                </View>
              )}
              {status !== "open" && (
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.status, { color: colors.muted }]}
                >
                  {status === "connecting"
                    ? "Connecting…"
                    : "Connection lost. Reconnecting…"}
                </Text>
              )}
              {section === "home" ? (
                sessions ? (
                  <HomeScreen
                    active={active}
                    recent={recent}
                    onSelectSession={openSession}
                    onNewWorkspace={() => setChoosingRepo(true)}
                  />
                ) : (
                  <Text style={[styles.status, { color: colors.text }]}>
                    {error ? "Couldn't load chats." : "Loading…"}
                  </Text>
                )
              ) : null}
            </>
          )}
          <LiveChat
            origin={origin}
            link={link}
            target={target}
            visible={section === "workspace" && !panel}
            preferences={preferences.preferences}
            onUnauthorized={onUnauthorized}
            onCreated={onCreated}
            onChooseProject={() => setPicker("project")}
            onChooseWorkspace={() => setPicker("workspace")}
          />
          {section === "workspace" && panel && location && (
            <WorkspacePanel
              origin={origin}
              link={link}
              hostId={location.hostId}
              cwd={location.path}
              sessionId={target?.sessionId}
              onClose={() => setPanel(false)}
            />
          )}
          {preferences.error && section === "settings" && (
            <Text
              accessibilityRole="alert"
              style={[styles.status, { color: colors.accent }]}
            >
              {preferences.error}
            </Text>
          )}
          <ChatLocationPicker
            kind={picker}
            choices={choices}
            onClose={() => setPicker(null)}
          />
          <ChatLocationPicker
            kind={choosingRepo ? "project" : null}
            onClose={() => setChoosingRepo(false)}
            choices={hosts.flatMap((host) =>
              (byHost[host.id]?.unavailable
                ? []
                : (byHost[host.id]?.hierarchy?.projects ?? [])
              )
                .filter((repo) => repo.kind === "git")
                .map((repo) => ({
                  key: JSON.stringify([host.id, repo.id]),
                  title: repo.name,
                  subtitle: repo.path,
                  onSelect: () =>
                    setRepoFlow({ kind: "workspace", host, repo }),
                })),
            )}
          />
        </View>
        {sidebar && (
          <Sidebar
            hosts={hosts}
            hierarchyByHost={hierarchyByHost}
            systemsByHost={systemsByHost}
            selected={section === "workspace" ? location : null}
            onHome={() => {
              setSidebar(false);
              setSection("home");
            }}
            onSettings={openSettings}
            onDismiss={() => setSidebar(false)}
            onAddRepo={(hostId) => {
              const host = hosts.find((item) => item.id === hostId);
              if (host) setRepoFlow({ kind: "addRepo", host });
            }}
            onNewWorkspace={(hostId, repo) => {
              const host = hosts.find((item) => item.id === hostId);
              if (host) setRepoFlow({ kind: "workspace", host, repo });
            }}
            onNewSession={() => {
              setSidebar(false);
              newChat();
            }}
            onWorkspace={(hostId, workspace) => {
              const repo = byHost[hostId]?.hierarchy?.projects.find(
                (project) => project.id === workspace.projectId,
              );
              goWorkspace({
                hostId,
                path: workspace.path,
                title: workspace.name,
                project: repo?.name,
              });
            }}
            onEffort={(hostId, effort) => {
              if (effort.root)
                goWorkspace({
                  hostId,
                  path: effort.root,
                  title: effort.name,
                  effortId: effort.id,
                });
            }}
          />
        )}
        {repoFlow && (
          <RepoFlows
            origin={origin}
            flow={repoFlow}
            onDismiss={() => setRepoFlow(null)}
            onChanged={() => void refreshWorkspace(repoFlow.host.id)}
            onWorkspaceCreated={(hostId, path) => {
              goWorkspace({
                hostId,
                path,
                title: path.split("/").pop() || path,
                project:
                  repoFlow.kind === "workspace"
                    ? repoFlow.repo.name
                    : undefined,
              });
              setRepoFlow(null);
            }}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { flex: 1 },
  header: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  menuIcon: { fontSize: 20, fontWeight: "600" },
  status: { paddingVertical: 10, paddingHorizontal: 16 },
  menu: {
    position: "absolute",
    top: 60,
    left: 44,
    zIndex: 4,
    borderWidth: 1,
    borderRadius: 8,
    minWidth: 145,
  },
  menuItem: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
});
