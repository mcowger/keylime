import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
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
import { SessionActions } from "./ChatActions";
import { archiveChat, renameChat } from "./chat-mutations";
import type { ShipJob } from "../lib/workspace-ship-types";
import { LiveChat, type ChatTarget } from "./LiveChat";
import { ArchiveBrowser, SearchInput, useSidebarSearch } from "./SearchArchive";
import { SystemFlows, type SystemFlow } from "./SystemFlows";
import { EffortDetails } from "./EffortDetails";
import { RepoFlows, type RepoFlow } from "./RepoFlows";
import { SidebarMenuIcon, WorkspacePanelIcon } from "./ShellIcons";
import { SettingsScreen } from "./SettingsScreen";
import { FinishShipDialog, ShipDialog } from "./ShipDialog";
import type { BrowserChannel } from "./browser-link";
import { Sidebar } from "./Sidebar";
import { theme } from "./theme";
import { useHomeInventory } from "./useHomeInventory";
import { useKeylimeConnection } from "./useKeylimeConnection";
import { useShipSidebar } from "./useShipSidebar";
import { useNativePreferences } from "./useNativePreferences";
import { WorkspacePanel } from "./WorkspacePanel";
import {
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

type ChatLocation = Pick<
  HomeSessionInfo,
  "id" | "hostId" | "cwd" | "name" | "firstMessage"
>;
const sessionTitle = (session: Pick<ChatLocation, "name" | "firstMessage">) =>
  session.name || session.firstMessage || "New chat";
const tabKey = (host: string, id: string) => JSON.stringify([host, id]);

function sameWorkspace(a: WorkspaceLocation, b: WorkspaceLocation) {
  return (
    a.hostId === b.hostId &&
    (a.effortId || b.effortId ? a.effortId === b.effortId : a.path === b.path)
  );
}

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
  const sidebarShip = useShipSidebar(
    origin,
    link,
    hosts,
    sessions,
    active,
    onUnauthorized,
  );
  const preferences = useNativePreferences();
  const [panel, setPanel] = useState(false);
  const [repoFlow, setRepoFlow] = useState<RepoFlow | null>(null);
  const [choosingRepo, setChoosingRepo] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [systemFlow, setSystemFlow] = useState<SystemFlow | null>(null);
  const [choosingEffort, setChoosingEffort] = useState(false);
  type ShipTarget = {
    hostId: string;
    projectPath: string;
    path: string;
    sessionId: string;
    workspaceId: string;
  };
  const [visibleShipKey, setVisibleShipKey] = useState<string | null>(null);
  const [ships, setShips] = useState<
    Record<
      string,
      {
        target: ShipTarget;
        job?: Pick<ShipJob, "id" | "status">;
      }
    >
  >({});
  const shipGeneration = useRef(0);
  const admittedShips = Object.entries(ships).filter(([, flow]) => flow.job);
  const findAdmittedShip = (hostId: string, workspaceId: string) =>
    admittedShips.find(
      ([, { target }]) =>
        target.hostId === hostId && target.workspaceId === workspaceId,
    );

  function openShip(target: ShipTarget) {
    const admitted = findAdmittedShip(target.hostId, target.workspaceId);
    if (admitted?.[1].job?.status === "running") {
      setVisibleShipKey(admitted[0]);
      return;
    }
    const key = String(++shipGeneration.current);
    setShips((old) => ({ ...old, [key]: { target } }));
    setVisibleShipKey(key);
  }
  const [finishTarget, setFinishTarget] = useState<{
    hostId: string;
    projectPath: string;
    path: string;
  } | null>(null);
  const [section, setSection] = useState<"home" | "workspace" | "settings">(
    "home",
  );
  const [settingsFrom, setSettingsFrom] = useState<"home" | "workspace">(
    "home",
  );
  const [sidebar, setSidebar] = useState(false);
  const search = useSidebarSearch(origin, sessions, onUnauthorized, sidebar);
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
  const connectedHostIds = JSON.stringify(
    hosts
      .filter(
        (host) => host.status === "online" || host.status === "omp-missing",
      )
      .map((host) => host.id)
      .sort(),
  );
  useEffect(() => {
    const releases = (JSON.parse(connectedHostIds) as string[]).map((hostId) =>
      link.subscribe({ kind: "workspace-jobs", hostId } as BrowserChannel, {
        onOpen: () => void refreshWorkspace(hostId),
        onEvent: (event) => {
          if (
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "workspace_jobs_changed" &&
            "scope" in event &&
            event.scope === "effort"
          )
            void refreshWorkspace(hostId);
        },
      }),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [connectedHostIds, link, refreshWorkspace]);
  const selected = location
    ? tabs.find(
        (tab) => tab.key === activeKey && sameWorkspace(tab.location, location),
      )
    : undefined;
  const target: ChatTarget | null = location
    ? {
        key:
          selected?.key ??
          JSON.stringify([location.hostId, location.path, "draft"]),
        hostId: location.hostId,
        path: selected?.location.path ?? location.path,
        workspace: selected?.location.title ?? location.title,
        project:
          selected?.location.project ?? location.project ?? location.title,
        effort: !!location.effortId,
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
        .filter((tab) => sameWorkspace(tab.location, location))
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
  function sessionOwner(
    hostId: string,
    item: Pick<ChatLocation, "id" | "cwd">,
  ) {
    const host = byHost[hostId];
    const effort = host?.systems?.efforts.find(
      (entry) =>
        entry.status !== "cleaned" && entry.sessionIds.includes(item.id),
    );
    if (effort) return { kind: "effort" as const, effort };
    for (const project of host?.hierarchy?.projects ?? []) {
      const workspace = project.workspaces.find((entry) =>
        entry.sessionIds.includes(item.id),
      );
      if (workspace) return { kind: "workspace" as const, project, workspace };
    }
    return locationForPath(byHost, hostId, item.cwd);
  }
  const savedSessions = location
    ? (sessions ?? []).filter((item) => {
        const host = item.hostId ?? "local";
        if (host !== location.hostId) return false;
        const owner = sessionOwner(host, item);
        if (location.effortId)
          return (
            owner.kind === "effort" && owner.effort.id === location.effortId
          );
        return owner.kind === "workspace"
          ? owner.workspace.path === location.path
          : owner.kind === "path" && item.cwd === location.path;
      })
    : [];

  function goWorkspace(next: WorkspaceLocation) {
    setLocation(next);
    setActiveKey(tabs.find((tab) => sameWorkspace(tab.location, next))?.key);
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
  const selectedEffort = location?.effortId
    ? byHost[location.hostId]?.systems?.efforts.find(
        (effort) => effort.id === location.effortId,
      )
    : undefined;
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

  function openSession(item: ChatLocation) {
    const hostId = item.hostId ?? "local";
    const owner = sessionOwner(hostId, item);
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
    setTabs((old) => {
      const existing = old.find(
        (tab) =>
          tab.key === key ||
          (tab.location.hostId === hostId && tab.sessionId === item.id),
      );
      if (existing)
        return sameWorkspace(existing.location, belonging)
          ? old
          : old.map((tab) =>
              tab === existing ? { ...tab, location: belonging } : tab,
            );
      return [
        ...old,
        {
          key,
          location: belonging,
          title: sessionTitle(item),
          sessionId: item.id,
        },
      ];
    });
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
              {section === "workspace" && selectedEffort && location && (
                <EffortDetails
                  effort={selectedEffort}
                  unavailable={byHost[location.hostId]?.unavailable}
                  onStartMemberChat={(member) => {
                    if (member.status === "complete" && member.path)
                      newChat({
                        ...location,
                        path: member.path,
                        title: member.name,
                        project: selectedEffort.name,
                      });
                  }}
                />
              )}
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
                    for (const host of hosts) {
                      if (
                        byHost[host.id]?.systems?.efforts.some(
                          (effort) =>
                            effort.status === "creating" ||
                            effort.status === "cleaning",
                        )
                      )
                        void refreshWorkspace(host.id);
                    }
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
                {section === "workspace" && target?.sessionId && (
                  <SessionActions
                    session={{
                      origin,
                      hostId: target.hostId,
                      sessionId: target.sessionId,
                    }}
                    name={
                      workspaceTabs.find((item) => item.key === target.key)
                        ?.title ?? "New chat"
                    }
                    hasChildren={
                      sessions?.some(
                        (item) =>
                          (item.hostId ?? "local") === target.hostId &&
                          item.parentSessionId === target.sessionId,
                      ) ?? false
                    }
                    onRename={async (identity, name) => {
                      await renameChat(identity, name);
                      setTabs((old) =>
                        old.map((tab) =>
                          tab.key === target.key
                            ? { ...tab, title: name }
                            : tab,
                        ),
                      );
                    }}
                    onArchive={async (identity) => {
                      await archiveChat(identity);
                      if (selected) closeTab(selected);
                    }}
                  />
                )}
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
                  {admittedShips.length > 0 && (
                    <Pressable
                      accessibilityRole="button"
                      style={styles.menuItem}
                      onPress={() => {
                        setMenu(false);
                        ActionSheetIOS.showActionSheetWithOptions(
                          {
                            title: "Ship progress",
                            options: [
                              ...admittedShips.map(
                                ([, { target }]) =>
                                  `${target.path.split("/").pop() ?? target.path} · ${hosts.find((host) => host.id === target.hostId)?.label || target.hostId}`,
                              ),
                              "Cancel",
                            ],
                            cancelButtonIndex: admittedShips.length,
                          },
                          (index) => {
                            if (admittedShips[index])
                              setVisibleShipKey(admittedShips[index][0]);
                          },
                        );
                      }}
                    >
                      <Text style={{ color: colors.text }}>Ship progress</Text>
                    </Pressable>
                  )}
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
                    onNewEffort={() => setChoosingEffort(true)}
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
            onForked={(source, id) => {
              if (!location || source.key !== target?.key) return;
              const key = tabKey(source.hostId, id);
              setTabs((old) =>
                old.some((item) => item.key === key)
                  ? old
                  : [
                      ...old,
                      { key, sessionId: id, title: "New chat", location },
                    ],
              );
              setActiveKey(key);
              return key;
            }}
            onChooseProject={() => setPicker("project")}
            onChooseWorkspace={() => setPicker("workspace")}
          />
          {section === "workspace" && panel && location && (
            <WorkspacePanel
              origin={origin}
              link={link}
              linkStatus={status}
              hostId={location.hostId}
              cwd={location.path}
              sessionId={target?.sessionId}
              onShip={(() => {
                if (
                  !target?.sessionId ||
                  location.effortId ||
                  active.some(
                    (item) =>
                      (item.session.hostId ?? "local") === location.hostId &&
                      item.session.id === target.sessionId &&
                      item.status === "Running",
                  )
                )
                  return undefined;
                const project = byHost[
                  location.hostId
                ]?.hierarchy?.projects.find(
                  (item) =>
                    item.kind === "git" &&
                    item.workspaces.some(
                      (workspace) =>
                        workspace.path === location.path &&
                        !workspace.isDefault &&
                        !workspace.unavailable &&
                        sidebarShip.states[
                          JSON.stringify([location.hostId, workspace.id])
                        ] === "ship",
                    ),
                );
                const workspace = project?.workspaces.find(
                  (item) => item.path === location.path,
                );
                return project && workspace
                  ? () =>
                      openShip({
                        hostId: location.hostId,
                        projectPath: project.path,
                        path: location.path,
                        sessionId: target.sessionId!,
                        workspaceId: workspace.id,
                      })
                  : undefined;
              })()}
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
          <ChatLocationPicker
            kind={choosingEffort ? "project" : null}
            onClose={() => setChoosingEffort(false)}
            choices={hosts.flatMap((host) =>
              (byHost[host.id]?.unavailable
                ? []
                : (byHost[host.id]?.systems?.systems ?? [])
              )
                .filter((system) => !system.archived)
                .map((system) => ({
                  key: JSON.stringify([host.id, system.id]),
                  title: system.name,
                  onSelect: () =>
                    setSystemFlow({ kind: "effort", host, system }),
                })),
            )}
          />
        </View>
        {sidebar && (
          <Sidebar
            shipStateByWorkspace={sidebarShip.states}
            hasShipProgress={(hostId, workspace) =>
              !!findAdmittedShip(hostId, workspace.id)
            }
            onViewShipProgress={(hostId, workspace) => {
              const admitted = findAdmittedShip(hostId, workspace.id);
              if (!admitted) return;
              setSidebar(false);
              setVisibleShipKey(admitted[0]);
            }}
            onShipWorkspace={(hostId, workspace) => {
              const project = byHost[hostId]?.hierarchy?.projects.find(
                (item) => item.id === workspace.projectId,
              );
              const session =
                sidebarShip.latest[JSON.stringify([hostId, workspace.id])];
              if (project && session) {
                openSession(session);
                openShip({
                  hostId,
                  projectPath: project.path,
                  path: workspace.path,
                  sessionId: session.id,
                  workspaceId: workspace.id,
                });
              }
            }}
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
            search={<SearchInput {...search} />}
            searchResults={
              search.query.trim() ? (
                <>
                  {hosts.flatMap((host) => [
                    ...(byHost[host.id]?.systems?.systems ?? [])
                      .filter((system) =>
                        system.name
                          .toLowerCase()
                          .includes(search.query.trim().toLowerCase()),
                      )
                      .map((system) => (
                        <Text
                          key={`system:${host.id}:${system.id}`}
                          accessibilityRole="header"
                          style={[styles.status, { color: colors.text }]}
                        >
                          {system.name}
                        </Text>
                      )),
                    ...(byHost[host.id]?.hierarchy?.projects ?? []).flatMap(
                      (repo) =>
                        repo.workspaces
                          .filter(
                            (workspace) =>
                              !workspace.unavailable &&
                              `${repo.name} ${workspace.name}`
                                .toLowerCase()
                                .includes(search.query.trim().toLowerCase()),
                          )
                          .map((workspace) => (
                            <Pressable
                              key={`workspace:${host.id}:${workspace.id}`}
                              style={styles.menuItem}
                              accessibilityRole="button"
                              onPress={() => {
                                search.setQuery("");
                                goWorkspace({
                                  hostId: host.id,
                                  path: workspace.path,
                                  title: workspace.name,
                                  project: repo.name,
                                });
                              }}
                            >
                              <Text style={{ color: colors.text }}>
                                {repo.name} · {workspace.name}
                              </Text>
                            </Pressable>
                          )),
                    ),
                    ...(byHost[host.id]?.systems?.efforts ?? [])
                      .filter(
                        (effort) =>
                          effort.root &&
                          (effort.name
                            .toLowerCase()
                            .includes(search.query.trim().toLowerCase()) ||
                            byHost[host.id]?.systems?.systems.some(
                              (system) =>
                                system.id === effort.systemId &&
                                system.name
                                  .toLowerCase()
                                  .includes(search.query.trim().toLowerCase()),
                            )),
                      )
                      .map((effort) => (
                        <Pressable
                          key={`effort:${host.id}:${effort.id}`}
                          style={styles.menuItem}
                          accessibilityRole="button"
                          onPress={() => {
                            if (effort.root) {
                              search.setQuery("");
                              goWorkspace({
                                hostId: host.id,
                                path: effort.root,
                                title: effort.name,
                                effortId: effort.id,
                              });
                            }
                          }}
                        >
                          <Text style={{ color: colors.text }}>
                            {effort.name}
                          </Text>
                        </Pressable>
                      )),
                  ])}
                  {search.matches.map((item) => (
                    <Pressable
                      key={tabKey(item.hostId ?? "local", item.id)}
                      style={styles.menuItem}
                      accessibilityRole="button"
                      onPress={() => {
                        search.setQuery("");
                        openSession(item);
                      }}
                    >
                      <Text style={{ color: colors.text }}>
                        {sessionTitle(item)}
                      </Text>
                    </Pressable>
                  ))}
                </>
              ) : undefined
            }
            onArchive={() => setArchiveOpen(true)}
            onAddSystem={(hostId) => {
              const host = hosts.find((item) => item.id === hostId);
              if (host)
                setSystemFlow({
                  kind: "system",
                  host,
                  repos: byHost[hostId]?.hierarchy?.projects ?? [],
                });
            }}
            onNewEffort={(hostId, system) => {
              const host = hosts.find((item) => item.id === hostId);
              if (host) setSystemFlow({ kind: "effort", host, system });
            }}
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
            onFinishShip={(hostId, workspace) => {
              const project = byHost[hostId]?.hierarchy?.projects.find(
                (item) => item.id === workspace.projectId,
              );
              if (project)
                setFinishTarget({
                  hostId,
                  projectPath: project.path,
                  path: workspace.path,
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
            link={link}
            linkStatus={status}
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
        {archiveOpen && (
          <ArchiveBrowser
            origin={origin}
            hosts={hosts}
            onUnauthorized={onUnauthorized}
            onClose={() => setArchiveOpen(false)}
            onRestored={(id, hostId, archive) =>
              openSession({
                id,
                hostId,
                cwd: archive.cwd,
                name: archive.name,
                firstMessage: archive.firstMessage,
              })
            }
          />
        )}
        {Object.entries(ships).map(([key, { target, job }]) => (
          <ShipDialog
            key={key}
            visible={visibleShipKey === key}
            origin={origin}
            link={link}
            target={target}
            onJob={(next) =>
              setShips((old) => {
                const flow = old[key];
                if (
                  !flow ||
                  (flow.job?.id === next.id && flow.job.status === next.status)
                )
                  return old;
                const updated = {
                  ...old,
                  [key]: { ...flow, job: { id: next.id, status: next.status } },
                };
                if (!flow.job) {
                  for (const [previousKey, previous] of Object.entries(old)) {
                    if (
                      previous.job &&
                      previous.target.hostId === target.hostId &&
                      previous.target.workspaceId === target.workspaceId
                    )
                      delete updated[previousKey];
                  }
                }
                return updated;
              })
            }
            onClose={() => {
              setVisibleShipKey(null);
              if (!job)
                setShips((old) => {
                  if (old[key]?.job || !old[key]) return old;
                  const next = { ...old };
                  delete next[key];
                  return next;
                });
            }}
            onChanged={(removed) => {
              void refreshWorkspace(target.hostId);
              if (
                removed &&
                location?.hostId === target.hostId &&
                location.path === target.path &&
                byHost[target.hostId]?.hierarchy?.projects.some((project) =>
                  project.workspaces.some(
                    (workspace) => workspace.id === target.workspaceId,
                  ),
                )
              ) {
                setPanel(false);
                setLocation(null);
                setSection("home");
              }
            }}
          />
        ))}
        {finishTarget && (
          <FinishShipDialog
            origin={origin}
            link={link}
            target={finishTarget}
            onClose={() => setFinishTarget(null)}
            onChanged={(removed) => {
              void refreshWorkspace(finishTarget.hostId);
              if (
                removed &&
                location?.hostId === finishTarget.hostId &&
                location.path === finishTarget.path
              ) {
                setPanel(false);
                setLocation(null);
                setSection("home");
              }
            }}
          />
        )}
        {systemFlow && (
          <SystemFlows
            origin={origin}
            flow={systemFlow}
            onDismiss={() => setSystemFlow(null)}
            onChanged={refreshWorkspace}
            onEffortCreated={(hostId, effort) => {
              if (effort.root)
                goWorkspace({
                  hostId,
                  path: effort.root,
                  title: effort.name,
                  effortId: effort.id,
                });
              setSystemFlow(null);
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
