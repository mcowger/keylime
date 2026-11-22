import { useState } from "react";
import {
  ActionSheetIOS,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import type { paths } from "./generated/web-http";
import { theme } from "./theme";

export type SidebarHost =
  paths["/api/hosts"]["get"]["responses"][200]["content"]["application/json"]["hosts"][number];
export type SidebarHierarchy =
  paths["/api/hierarchy"]["get"]["responses"][200]["content"]["application/json"];
export type SidebarSystems =
  paths["/api/systems"]["get"]["responses"][200]["content"]["application/json"];
export type SidebarRepo = SidebarHierarchy["projects"][number];
export type SidebarWorkspace = SidebarRepo["workspaces"][number];
export type SidebarSystem = SidebarSystems["systems"][number];
export type SidebarEffort = SidebarSystems["efforts"][number];

export interface SidebarProps {
  hosts: SidebarHost[];
  // Missing entries are loading; null means the host inventory could not be loaded.
  hierarchyByHost: Record<string, SidebarHierarchy | null | undefined>;
  systemsByHost: Record<string, SidebarSystems | null | undefined>;
  selected?: { hostId: string; path: string } | null;
  onHome: () => void;
  onDismiss: () => void;
  onSettings: () => void;
  onWorkspace: (hostId: string, workspace: SidebarWorkspace) => void;
  onEffort: (hostId: string, effort: SidebarEffort) => void;
  onNewSession?: () => void;
  search?: React.ReactNode;
  searchResults?: React.ReactNode;
  onArchive?: () => void;
  onAddRepo?: (hostId: string) => void;
  onAddSystem?: (hostId: string) => void;
  onNewWorkspace?: (hostId: string, repo: SidebarRepo) => void;
  onNewEffort?: (hostId: string, system: SidebarSystem) => void;
  onShipWorkspace?: (hostId: string, workspace: SidebarWorkspace) => void;
  onFinishShip?: (hostId: string, workspace: SidebarWorkspace) => void;
  shipStateByWorkspace?: Record<string, "ship" | "busy" | "finish" | undefined>;
  hasShipProgress?: (hostId: string, workspace: SidebarWorkspace) => boolean;
  onViewShipProgress?: (hostId: string, workspace: SidebarWorkspace) => void;
}

const statusLabels: Record<SidebarEffort["status"], string> = {
  creating: "Creating",
  failed: "Setup failed",
  ready: "Ready",
  cleaning: "Cleaning up",
  cleanup_failed: "Cleanup failed",
  cleaned: "Cleaned up",
};
const projectColors = [
  "#8b2635",
  "#905000",
  "#286047",
  "#205b85",
  "#574b94",
  "#8a376e",
];

function projectColor(name: string) {
  let hash = 2166136261;
  for (const character of name)
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return projectColors[(hash >>> 0) % projectColors.length];
}

function containsPath(root: string, path: string) {
  const normalized = root.replace(/\/+$/, "") || "/";
  return (
    path === normalized ||
    (normalized === "/"
      ? path.startsWith("/")
      : path.startsWith(`${normalized}/`))
  );
}

export function Sidebar({
  hosts,
  hierarchyByHost,
  systemsByHost,
  selected,
  onHome,
  onDismiss,
  onSettings,
  onWorkspace,
  onEffort,
  onNewSession,
  search,
  searchResults,
  onArchive,
  onAddRepo,
  onAddSystem,
  onNewWorkspace,
  onShipWorkspace,
  onFinishShip,
  shipStateByWorkspace,
  hasShipProgress,
  onViewShipProgress,
  onNewEffort,
}: SidebarProps) {
  const dark = useColorScheme() !== "light";
  const colors = dark
    ? {
        background: theme.panel,
        text: theme.text,
        muted: theme.muted,
        border: theme.border,
        hover: "#1a1a20",
        surface: theme.hover,
        accent: theme.accent,
      }
    : {
        background: "#FAF9F6",
        text: "#221A14",
        muted: "#625C57",
        border: "#D6CFC1",
        hover: "#E7E3DB",
        surface: "#F2F0EA",
        accent: "#A4246D",
      };
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const isOpen = (key: string, fallback: boolean) => expansion[key] ?? fallback;
  const toggle = (key: string, fallback: boolean) =>
    setExpansion((previous) => ({
      ...previous,
      [key]: !(previous[key] ?? fallback),
    }));

  const disclosure = (
    label: string,
    key: string,
    open: boolean,
    style?: object,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={() => toggle(key, open)}
      style={[styles.disclosure, style]}
    >
      <Text
        style={[
          styles.chevron,
          { color: colors.muted },
          open && styles.chevronOpen,
        ]}
      >
        ›
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.sectionLabel, { color: colors.muted }]}
      >
        {label}
      </Text>
    </Pressable>
  );
  const plus = (label: string, action: () => void, boxed = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={action}
      style={[
        styles.iconButton,
        boxed && styles.boxedButton,
        { borderColor: colors.border },
      ]}
    >
      <Text style={[styles.plus, { color: colors.muted }]}>+</Text>
    </Pressable>
  );

  return (
    <View
      style={[styles.overlay, { backgroundColor: colors.background }]}
      accessibilityViewIsModal
    >
      <View style={styles.topBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close sidebar"
          onPress={onDismiss}
          style={styles.topButton}
        >
          <Text style={[styles.close, { color: colors.text }]}>×</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Home"
          onPress={onHome}
          style={styles.brand}
        >
          <Image
            source={require("../public/icon-192.png")}
            style={styles.logo}
          />
          <Text style={[styles.brandText, { color: colors.accent }]}>
            key <Text style={{ color: colors.text }}>lime</Text>
          </Text>
        </Pressable>
        <View style={styles.spacer} />
        {onArchive && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Archived sessions"
            onPress={onArchive}
            style={styles.topButton}
          >
            <Text style={[styles.topSymbol, { color: colors.muted }]}>▣</Text>
          </Pressable>
        )}
      </View>
      {onNewSession && (
        <View style={[styles.newSessionWrap, { borderColor: colors.border }]}>
          <Pressable
            accessibilityRole="button"
            onPress={onNewSession}
            style={[
              styles.newSession,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.newSessionText, { color: colors.text }]}>
              <Text style={{ color: colors.accent, fontSize: 21 }}>＋ </Text>New
              Session
            </Text>
          </Pressable>
        </View>
      )}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {search}
        {searchResults ??
          hosts.map((host) => {
            const hostKey = JSON.stringify([host.id, "host"]);
            const hostOpen = isOpen(hostKey, true);
            const offline = host.status === "offline";
            const hierarchy = hierarchyByHost[host.id];
            const systems = systemsByHost[host.id];
            const systemsKey = JSON.stringify([host.id, "systems"]);
            const reposKey = JSON.stringify([host.id, "repos"]);
            const systemsOpen = isOpen(systemsKey, true);
            const reposOpen = isOpen(reposKey, true);
            const archivedKey = JSON.stringify([host.id, "archived-systems"]);
            const archivedOpen = isOpen(archivedKey, false);
            const archivedSystems =
              systems?.systems.filter((system) => system.archived) ?? [];
            return (
              <View key={host.id} style={styles.host}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    host.label ||
                    (host.id === "local" ? "This machine" : host.id)
                  }
                  accessibilityState={{ expanded: hostOpen }}
                  onPress={() => toggle(hostKey, true)}
                  style={styles.hostRow}
                >
                  <Text
                    style={[
                      styles.chevron,
                      { color: colors.muted },
                      hostOpen && styles.chevronOpen,
                    ]}
                  >
                    ›
                  </Text>
                  <Text style={[styles.hostIcon, { color: colors.muted }]}>
                    ▤
                  </Text>
                  <Text
                    style={[styles.hostName, { color: colors.muted }]}
                    numberOfLines={1}
                  >
                    {host.label ||
                      (host.id === "local" ? "This machine" : host.id)}
                  </Text>
                  {host.status !== "online" && (
                    <Text style={[styles.hostStatus, { color: colors.muted }]}>
                      {host.status === "offline"
                        ? "Offline"
                        : host.status === "needs-upgrade"
                          ? "Needs upgrade"
                          : "OMP missing"}
                    </Text>
                  )}
                </Pressable>
                {hostOpen && (
                  <View style={styles.hostChildren}>
                    <View style={styles.sectionRow}>
                      {disclosure("Systems", systemsKey, systemsOpen)}
                      {onAddSystem &&
                        !offline &&
                        plus("New System", () => onAddSystem(host.id))}
                    </View>
                    {systemsOpen && (
                      <View style={styles.sectionChildren}>
                        {offline ? (
                          <Text
                            style={[styles.mutedRow, { color: colors.muted }]}
                          >
                            Host unavailable.
                          </Text>
                        ) : systems === undefined ? (
                          <Text
                            style={[styles.mutedRow, { color: colors.muted }]}
                          >
                            Loading Systems…
                          </Text>
                        ) : systems === null ? (
                          <Text
                            style={[styles.mutedRow, { color: colors.muted }]}
                          >
                            Couldn't load Systems.
                          </Text>
                        ) : (
                          <>
                            {[
                              ...systems.systems.filter(
                                (system) => !system.archived,
                              ),
                              ...archivedSystems,
                            ].map((system) => {
                              const efforts = systems.efforts.filter(
                                (effort) => effort.systemId === system.id,
                              );
                              const key = JSON.stringify([
                                host.id,
                                "system",
                                system.id,
                              ]);
                              const selectedEffort =
                                selected?.hostId === host.id &&
                                efforts.some((effort) =>
                                  containsPath(effort.root, selected.path),
                                );
                              const allDefault = efforts.every((effort) =>
                                effort.members.every(
                                  (member) =>
                                    !!member.currentBranch &&
                                    !!member.defaultBranch &&
                                    member.currentBranch ===
                                      member.defaultBranch,
                                ),
                              );
                              const open = isOpen(
                                key,
                                !allDefault && !!selectedEffort,
                              );
                              return (
                                <View key={system.id}>
                                  {system.archived &&
                                    system.id === archivedSystems[0]?.id && (
                                      <Pressable
                                        accessibilityRole="button"
                                        accessibilityState={{
                                          expanded: archivedOpen,
                                        }}
                                        onPress={() =>
                                          toggle(archivedKey, false)
                                        }
                                        style={styles.archivedRow}
                                      >
                                        <Text
                                          style={[
                                            styles.chevron,
                                            { color: colors.muted },
                                            archivedOpen && styles.chevronOpen,
                                          ]}
                                        >
                                          ›
                                        </Text>
                                        <Text
                                          style={[
                                            styles.bodyText,
                                            { color: colors.muted },
                                          ]}
                                        >
                                          Archived Systems (
                                          {archivedSystems.length})
                                        </Text>
                                      </Pressable>
                                    )}
                                  {(!system.archived || archivedOpen) && (
                                    <>
                                      <View style={styles.itemRow}>
                                        <Pressable
                                          accessibilityRole="button"
                                          accessibilityLabel={system.name}
                                          accessibilityState={{
                                            expanded: open,
                                          }}
                                          onPress={() => toggle(key, open)}
                                          style={styles.itemToggle}
                                        >
                                          <Text
                                            style={[
                                              styles.chevron,
                                              { color: colors.text },
                                              open && styles.chevronOpen,
                                            ]}
                                          >
                                            ›
                                          </Text>
                                          <Text
                                            numberOfLines={1}
                                            style={[
                                              styles.itemName,
                                              { color: colors.text },
                                            ]}
                                          >
                                            {system.name}
                                          </Text>
                                        </Pressable>
                                        {!system.archived &&
                                          onNewEffort &&
                                          plus(
                                            `New Effort in ${system.name}`,
                                            () => onNewEffort(host.id, system),
                                            true,
                                          )}
                                      </View>
                                      {open && (
                                        <View style={styles.effortChildren}>
                                          {!efforts.length && (
                                            <Text
                                              style={[
                                                styles.mutedRow,
                                                { color: colors.muted },
                                              ]}
                                            >
                                              No Efforts.
                                            </Text>
                                          )}
                                          {efforts.map((effort) => {
                                            const active =
                                              selected?.hostId === host.id &&
                                              containsPath(
                                                effort.root,
                                                selected.path,
                                              );
                                            return (
                                              <Pressable
                                                key={effort.id}
                                                accessibilityRole="button"
                                                accessibilityState={{
                                                  selected: !!active,
                                                }}
                                                onPress={() =>
                                                  onEffort(host.id, effort)
                                                }
                                                style={[
                                                  styles.effort,
                                                  {
                                                    borderColor: colors.border,
                                                    backgroundColor: active
                                                      ? colors.hover
                                                      : colors.surface,
                                                  },
                                                ]}
                                              >
                                                <Text
                                                  style={[
                                                    styles.bodyText,
                                                    { color: colors.text },
                                                  ]}
                                                >
                                                  {effort.name}
                                                </Text>
                                                <Text
                                                  style={[
                                                    styles.bodyText,
                                                    { color: colors.muted },
                                                  ]}
                                                >
                                                  {statusLabels[effort.status]}
                                                </Text>
                                              </Pressable>
                                            );
                                          })}
                                        </View>
                                      )}
                                    </>
                                  )}
                                </View>
                              );
                            })}
                            {!systems.systems.length && (
                              <Text
                                style={[
                                  styles.mutedRow,
                                  { color: colors.muted },
                                ]}
                              >
                                No Systems on this host.
                              </Text>
                            )}
                          </>
                        )}
                      </View>
                    )}
                    <View style={styles.sectionRow}>
                      {disclosure("Repos", reposKey, reposOpen)}
                      {onAddRepo &&
                        !offline &&
                        plus("Add Repo", () => onAddRepo(host.id))}
                    </View>
                    {reposOpen && (
                      <View style={styles.sectionChildren}>
                        {offline ? (
                          <Text
                            style={[styles.mutedRow, { color: colors.muted }]}
                          >
                            Host unavailable.
                          </Text>
                        ) : hierarchy === undefined ? (
                          <Text
                            style={[styles.mutedRow, { color: colors.muted }]}
                          >
                            Loading Repos…
                          </Text>
                        ) : hierarchy === null ? (
                          <Text
                            style={[styles.mutedRow, { color: colors.muted }]}
                          >
                            Couldn't load Repos.
                          </Text>
                        ) : (
                          <>
                            {hierarchy.projects.map((repo) => {
                              const key = JSON.stringify([
                                host.id,
                                "repo",
                                repo.id,
                              ]);
                              const allDefault =
                                repo.workspaces.length === 0 ||
                                (repo.kind === "directory"
                                  ? repo.workspaces.length === 1 &&
                                    repo.workspaces[0].isDefault
                                  : !!repo.defaultBranch &&
                                    repo.workspaces.every(
                                      (workspace) =>
                                        workspace.branch === repo.defaultBranch,
                                    ));
                              const open = isOpen(key, !allDefault);
                              const name = repo.alias || repo.name;
                              return (
                                <View key={repo.id}>
                                  <View style={styles.itemRow}>
                                    <Pressable
                                      accessibilityRole="button"
                                      accessibilityLabel={name}
                                      accessibilityState={{ expanded: open }}
                                      onPress={() => toggle(key, open)}
                                      style={styles.itemToggle}
                                    >
                                      <Text
                                        style={[
                                          styles.chevron,
                                          { color: colors.text },
                                          open && styles.chevronOpen,
                                        ]}
                                      >
                                        ›
                                      </Text>
                                      {repo.icon &&
                                      !repo.icon.startsWith(
                                        "data:image/svg",
                                      ) ? (
                                        <Image
                                          source={{ uri: repo.icon }}
                                          style={styles.projectIcon}
                                        />
                                      ) : (
                                        <View
                                          style={[
                                            styles.projectIcon,
                                            {
                                              backgroundColor:
                                                projectColor(name),
                                            },
                                          ]}
                                        >
                                          <Text style={styles.projectInitial}>
                                            {Array.from(
                                              name.trim(),
                                            )[0]?.toLocaleUpperCase() ?? "?"}
                                          </Text>
                                        </View>
                                      )}
                                      <Text
                                        numberOfLines={1}
                                        style={[
                                          styles.itemName,
                                          { color: colors.text },
                                        ]}
                                      >
                                        {name}
                                      </Text>
                                    </Pressable>
                                    {onNewWorkspace &&
                                      plus(
                                        `New workspace in ${name}`,
                                        () => onNewWorkspace(host.id, repo),
                                        true,
                                      )}
                                  </View>
                                  {open && (
                                    <View style={styles.workspaceChildren}>
                                      {repo.workspaces.map((workspace) => {
                                        const active =
                                          selected?.hostId === host.id &&
                                          selected.path === workspace.path;
                                        const shipState =
                                          shipStateByWorkspace?.[
                                            JSON.stringify([
                                              host.id,
                                              workspace.id,
                                            ])
                                          ];
                                        const finish = shipState === "finish";
                                        const action = finish
                                          ? onFinishShip
                                          : onShipWorkspace;
                                        const viewProgress =
                                          hasShipProgress?.(
                                            host.id,
                                            workspace,
                                          ) && onViewShipProgress;
                                        const actions = [
                                          ...(viewProgress
                                            ? [
                                                {
                                                  label: "View Ship progress",
                                                  run: viewProgress,
                                                },
                                              ]
                                            : []),
                                          ...(shipState &&
                                          shipState !== "busy" &&
                                          action
                                            ? [
                                                {
                                                  label: finish
                                                    ? "Clean up merged workspace"
                                                    : "Ship",
                                                  run: action,
                                                },
                                              ]
                                            : []),
                                        ];
                                        return (
                                          <View
                                            key={workspace.id}
                                            style={{
                                              flexDirection: "row",
                                              alignItems: "center",
                                            }}
                                          >
                                            <Pressable
                                              accessibilityRole="button"
                                              accessibilityState={{
                                                selected: !!active,
                                                disabled:
                                                  !!workspace.unavailable,
                                              }}
                                              disabled={workspace.unavailable}
                                              onPress={() =>
                                                onWorkspace(host.id, workspace)
                                              }
                                              style={[
                                                styles.workspace,
                                                { flex: 1 },
                                                active && {
                                                  backgroundColor: colors.hover,
                                                },
                                              ]}
                                            >
                                              <Text
                                                numberOfLines={1}
                                                style={[
                                                  styles.bodyText,
                                                  {
                                                    color: workspace.unavailable
                                                      ? colors.muted
                                                      : colors.text,
                                                  },
                                                ]}
                                              >
                                                {workspace.name}
                                              </Text>
                                            </Pressable>
                                            {actions.length > 0 &&
                                              !workspace.unavailable && (
                                                <Pressable
                                                  accessibilityRole="button"
                                                  accessibilityLabel={`Actions for ${workspace.name}`}
                                                  style={{
                                                    minWidth: 44,
                                                    minHeight: 44,
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                  }}
                                                  onPress={() =>
                                                    ActionSheetIOS.showActionSheetWithOptions(
                                                      {
                                                        options: [
                                                          ...actions.map(
                                                            ({ label }) =>
                                                              label,
                                                          ),
                                                          "Cancel",
                                                        ],
                                                        cancelButtonIndex:
                                                          actions.length,
                                                      },
                                                      (index) =>
                                                        actions[index]?.run(
                                                          host.id,
                                                          workspace,
                                                        ),
                                                    )
                                                  }
                                                >
                                                  <Text
                                                    style={{
                                                      color: colors.muted,
                                                    }}
                                                  >
                                                    ⋯
                                                  </Text>
                                                </Pressable>
                                              )}
                                          </View>
                                        );
                                      })}
                                    </View>
                                  )}
                                </View>
                              );
                            })}
                            {!hierarchy.projects.length && (
                              <Text
                                style={[
                                  styles.mutedRow,
                                  { color: colors.muted },
                                ]}
                              >
                                No Repos on this host.
                              </Text>
                            )}
                          </>
                        )}
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        onPress={onSettings}
        style={[styles.settings, { borderColor: colors.border }]}
      >
        <Text style={[styles.settingsIcon, { color: colors.accent }]}>☷</Text>
        <Text style={[styles.bodyText, { color: colors.text }]}>Settings</Text>
        <View style={styles.spacer} />
        <Text style={[styles.settingsArrow, { color: colors.muted }]}>›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 100,
    flex: 1,
  },
  topBar: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
  },
  topButton: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  close: { fontSize: 25, lineHeight: 30, fontWeight: "300" },
  topSymbol: { fontSize: 21 },
  brand: { flexDirection: "row", alignItems: "center", gap: 8 },
  logo: { width: 21, height: 21, borderRadius: 5 },
  brandText: { fontSize: 16, fontFamily: "Menlo", fontWeight: "700" },
  spacer: { flex: 1 },
  newSessionWrap: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  newSession: {
    height: 44,
    borderWidth: 1,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  newSessionText: { fontSize: 13, fontWeight: "600" },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 8, paddingHorizontal: 10, paddingBottom: 16 },
  search: { height: 42, flexDirection: "row", alignItems: "center", gap: 8 },
  searchIcon: { fontSize: 27, width: 17, lineHeight: 30 },
  host: { marginBottom: 8 },
  hostRow: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  hostIcon: { fontSize: 20 },
  hostName: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  hostStatus: { fontSize: 11, marginLeft: "auto" },
  hostChildren: { paddingLeft: 14 },
  sectionRow: { minHeight: 44, flexDirection: "row", alignItems: "center" },
  disclosure: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  chevron: { width: 12, textAlign: "center", fontSize: 19, lineHeight: 22 },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  sectionLabel: {
    textTransform: "uppercase",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
  },
  sectionChildren: { paddingLeft: 17 },
  itemRow: { minHeight: 44, flexDirection: "row", alignItems: "center" },
  itemToggle: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  itemName: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  iconButton: {
    height: 36,
    minWidth: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  boxedButton: {
    height: 28,
    minWidth: 30,
    borderWidth: 1,
    borderRadius: 9,
    marginRight: 5,
  },
  plus: { fontSize: 22, fontWeight: "300", lineHeight: 26 },
  projectIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 5,
  },
  projectInitial: { color: "#fff", fontWeight: "600", fontSize: 13 },
  workspaceChildren: { paddingLeft: 1 },
  workspace: {
    minHeight: 30,
    justifyContent: "center",
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  archivedRow: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  effortChildren: { paddingLeft: 17, gap: 4, paddingBottom: 3 },
  effort: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 2,
  },
  bodyText: { fontSize: 12 },
  mutedRow: { fontSize: 12, paddingVertical: 6, paddingLeft: 12 },
  settings: {
    borderTopWidth: StyleSheet.hairlineWidth,
    minHeight: 55,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    gap: 10,
  },
  settingsIcon: { fontSize: 19 },
  settingsArrow: { fontSize: 22 },
});
