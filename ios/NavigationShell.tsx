import { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { ChatTranscript } from "./ChatTranscript";
import type { operations } from "./generated/web-http";
import { HomeScreen, type HomeSessionInfo } from "./HomeScreen";
import { requestJson } from "./keylime-http";
import { SettingsScreen } from "./SettingsScreen";
import { Sidebar } from "./Sidebar";
import { theme } from "./theme";
import { useHomeInventory } from "./useHomeInventory";
import { useKeylimeConnection } from "./useKeylimeConnection";
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
};
type OpenTab = WorkspaceTab & { location: WorkspaceLocation };
type SessionRead =
  operations["getSession"]["responses"][200]["content"]["application/json"];

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
  const { byHost } = useWorkspaceInventory(origin, hosts, onUnauthorized);
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
  const [history, setHistory] = useState<{
    key: string;
    context?: SessionRead["context"];
    error?: string;
  }>();
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
  const session = selected?.session;

  useEffect(() => {
    if (!selected?.session || section !== "workspace") return;
    let active = true;
    const { key, location, session } = selected;
    const params = `hostId=${encodeURIComponent(location.hostId)}&tail=40`;
    void requestJson<SessionRead>(
      origin,
      `/api/sessions/${encodeURIComponent(session.id)}?${params}`,
    ).then(
      ({ context }) => {
        if (active) setHistory({ key, context });
      },
      (cause: unknown) => {
        if (active)
          setHistory({
            key,
            error:
              cause instanceof Error ? cause.message : "Couldn't load chat.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [origin, section, selected]);

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
    ? tabs.filter(
        (tab) =>
          tab.location.hostId === location.hostId &&
          tab.location.path === location.path,
      )
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
          ? { hostId, path: owner.workspace.path, title: owner.workspace.name }
          : {
              hostId,
              path: item.cwd,
              title: item.cwd.split("/").pop() || item.cwd,
            };
    const key = tabKey(hostId, item.id);
    setTabs((old) =>
      old.some((tab) => tab.key === key)
        ? old
        : [
            ...old,
            {
              key,
              location: belonging,
              title: sessionTitle(item),
              session: item,
            },
          ],
    );
    setLocation(belonging);
    setActiveKey(key);
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
                  <Text style={[styles.menuIcon, { color: colors.text }]}>
                    ☰
                  </Text>
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
                  />
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
                  />
                ) : (
                  <Text style={[styles.status, { color: colors.text }]}>
                    {error ? "Couldn't load chats." : "Loading…"}
                  </Text>
                )
              ) : session &&
                history?.key === selected?.key &&
                history?.context ? (
                <ChatTranscript
                  messages={history.context.messages}
                  entryIds={history.context.entryIds}
                  mediaOrigin={origin}
                  sessionKey={selected?.key}
                />
              ) : (
                <Text style={[styles.status, { color: colors.muted }]}>
                  {session
                    ? (history?.key === selected?.key && history?.error) ||
                      "Loading…"
                    : location?.title}
                </Text>
              )}
            </>
          )}
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
            onWorkspace={(hostId, workspace) =>
              goWorkspace({
                hostId,
                path: workspace.path,
                title: workspace.name,
              })
            }
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
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
