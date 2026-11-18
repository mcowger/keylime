"use client";

import { browserUUID } from "@/lib/browser-uuid";
import { temporarySessionTitle } from "@/lib/session-title";
import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import dynamic from "@/lib/dynamic";
import { useRouter, useSearchParams } from "@/lib/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSidebarHistory } from "@/hooks/useSidebarHistory";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useNavigationHistory } from "@/hooks/useNavigationHistory";
import {
  isMacPlatform,
  navigateShortcutHint,
  NAVIGATION_HISTORY_MAX_ENTRIES,
} from "@/lib/navigation-history";
import { useMobileSidebarGestures } from "@/hooks/useMobileSidebarGestures";
import { SessionSidebar } from "./SessionSidebar";
import type { SearchMatchTarget } from "./SessionSearchMatches";
import type { WorktreeContext } from "./SessionSidebar-helpers";
import type {
  WorkspaceBranches,
  WorkspaceCreationJob,
  WorkspacePrepareRequest,
} from "@/lib/workspace-creation-types";
import { ToastProvider } from "./ui/toast";
import { toast } from "./ui/toast";
import {
  notificationHistory,
  useUnreadNotificationCount,
} from "@/lib/notification-history";
import { ConfirmDialog } from "./ui/field";
import { ThemedSelect } from "./ui/primitives";
import { ChatWindow } from "./ChatWindow";
import {
  WorkspaceSourcePicker,
  selectedWorkspaceBase,
} from "./WorkspaceSourcePicker";
import { ShipDialog, type ShipTarget } from "./ShipDialog";
import { type Tab } from "./TabBar";
import { WorkspaceTerminalTabs } from "./WorkspaceTerminalTabs";
import { type FileExplorerHandle } from "./FileExplorer";
import type { RightPanelView } from "./RightPanel";
import { useConnectionDiagnosticsEnabled } from "@/lib/connection-diagnostics-prefs";
import { NotificationBell } from "./NotificationBell";
import { BranchNavigator } from "./BranchNavigator";
import { CommandPaletteMount } from "./CommandPaletteMount";
import {
  Check,
  ChevronDown,
  Command,
  Ellipsis,
  Folder,
  Menu,
  PanelRight,
  Server,
  Terminal,
  Wand2,
  Zap,
} from "lucide-react";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { formatGenerationSpeed } from "@/lib/generation-speed";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useIsCompactOverlay } from "@/hooks/useIsCompactOverlay";
import { copyText } from "@/lib/clipboard";
import {
  getFileApiUrl,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
} from "@/lib/file-paths";
import { normalizeLocalPath } from "@/lib/file-links";
import type { WorkspaceFileSource } from "@/lib/workspace-types";
import {
  buildAtMentionText,
  buildFileAtMentionsText,
  buildFileLineMentionText,
} from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import { comparableProjectPath } from "@/lib/comparable-path";
import {
  hostProjectKey,
  LOCAL_HOST_ID,
  newChatDraftKey,
  remoteHostId,
} from "@/lib/project-ordering";
import { isClusterTarget } from "@/lib/hosts/cluster";
import { useHostRows } from "@/hooks/useHostRows";
import { LocalDaemonBanner } from "./LocalDaemonBanner";
import { hostName } from "./host-status";
import { clearDraft, getDraftRevision, getDraftSummary } from "@/lib/draft-store";
import { useNotifications } from "@/hooks/useNotifications";
import {
  PanelLoadingFallback,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampRightPanelWidth,
  clampSidebarWidth,
  loadRightPanelWidth,
  loadSidebarWidth,
  projectLabel,
  WorkspaceState,
} from "./AppShell-layout";
import type {
  CrossSessionHostToolCall,
  ManagedProject,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import type { HierarchySnapshot } from "@/lib/project-hierarchy-types";
import { runHostTool } from "@/hooks/useAgentSession-stream";
import { getOutboxScope, sendAgentCommand } from "@/lib/agent-client";
import { addToOutbox, newOutboxId, openEventStream, type EventStream } from "@/lib/event-stream";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo, GenerationSpeedInfo } from "@/lib/pi-types";
import type { SettingsTab } from "./SettingsTabs";
import { SettingsConfig } from "./SettingsConfig";
import { ArchiveBrowser } from "./ArchiveBrowser";
import { publishSessionsChanged } from "@/lib/session-change-bus";
// The settings shell is part of the app bundle so opening it does not fetch or compile a modal chunk. The right panel (viewer included) is a separate chunk, preloaded on the first pointerdown or keydown and mounted on first open.
// No loading placeholder: it would take the panel's place in the layout (on
// phones, squeezing out the chat) for a frame even when the code is cached.
const RightPanel = dynamic(
  () => import("./RightPanel").then((m) => m.RightPanel),
  {
    loading: () => null,
  },
);

const TOOL_CALLS_COLLAPSED_STORAGE_KEY = "keylime:tool-calls-collapsed";
const HIDE_TOOL_ACTIVITY_STORAGE_KEY = "keylime:hide-tool-activity";
const NEVER_FOLD_ACTIVITY_STORAGE_KEY = "keylime:never-fold-activity";
const SHOW_TOOL_CALLS_UNFOLDED_STORAGE_KEY = "keylime:show-tool-calls-unfolded";
// Off by default, so the transcript keeps collapsing reasoning until asked.
const EXPAND_THINKING_STORAGE_KEY = "keylime:expand-thinking";
const PROVIDER_USAGE_VISIBLE_STORAGE_KEY = "keylime:provider-usage-visible";
const NATIVE_SELECT_ALL_STORAGE_KEY = "keylime:scope-native-select-all";
const OPEN_URL_AUTOMATICALLY_STORAGE_KEY = "keylime:open-url-automatically";

type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };
type TimerHandle = NodeJS.Timeout;
type ChatTab = {
  id: string;
  cwd: string;
  hostId?: string;
  session: SessionInfo | null;
  creation: { id?: string; initialization?: string };
  workspaceProject?: string;
  workspaceSource?: string;
  workspaceJob?: WorkspaceCreationJob;
  workspaceFixed?: boolean;
};

function tabInWorkspace(
  tab: ChatTab,
  cwd: string,
  hostId: string | undefined,
  projects: ManagedProject[],
) {
  if (tab.workspaceProject && !tab.session) return false;
  if (remoteHostId(tab.hostId) !== remoteHostId(hostId)) return false;
  const path = comparableProjectPath(tab.cwd);
  const roots = projects
    .filter((project) => remoteHostId(project.hostId) === remoteHostId(hostId))
    .map((project) => comparableProjectPath(project.path))
    .filter(
      (root) =>
        path === root || path.startsWith(root === "/" ? "/" : `${root}/`),
    );
  const owner = roots.sort((a, b) => b.length - a.length)[0] ?? path;
  return owner === comparableProjectPath(cwd);
}
const CHAT_TABS_STORAGE_KEY = "keylime:workspace-chat-tabs";
function loadChatTabs(): ChatTab[] {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(CHAT_TABS_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value
      .slice(0, 100)
      .filter(
        (tab): tab is ChatTab =>
          tab &&
          typeof tab.id === "string" &&
          typeof tab.cwd === "string" &&
          (tab.hostId === undefined || typeof tab.hostId === "string") &&
          tab.creation &&
          typeof tab.creation === "object" &&
          !Array.isArray(tab.creation) &&
          (tab.creation.id === undefined ||
            typeof tab.creation.id === "string") &&
          (tab.creation.initialization === undefined ||
            typeof tab.creation.initialization === "string") &&
          (tab.session === null ||
            (tab.session &&
              typeof tab.session.id === "string" &&
              typeof tab.session.cwd === "string" &&
              typeof tab.session.path === "string" &&
              typeof tab.session.created === "string" &&
              typeof tab.session.modified === "string" &&
              typeof tab.session.messageCount === "number" &&
              typeof tab.session.firstMessage === "string" &&
              (tab.session.name === undefined ||
                typeof tab.session.name === "string"))),
      );
  } catch {
    return [];
  }
}

export function AppShell({ appName }: { appName: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() =>
    getInitialNavigation(searchParams),
  );
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const isCompactOverlay = useIsCompactOverlay();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(
    null,
  );
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [shipFlows, setShipFlows] = useState<ShipTarget[]>([]);
  const openShip = useCallback((target: ShipTarget) => {
    setShipFlows((flows) => flows.some((flow) =>
      hostProjectKey(flow.host, flow.path) === hostProjectKey(target.host, target.path)
    ) ? flows : [...flows, target]);
  }, []);
  // The transient identity belongs to one intentional new chat, not one request attempt.
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  // Host of newSessionCwd; undefined is this machine. Every host-aware state
  // here uses that form (see remoteHostId).
  const [newSessionHostId, setNewSessionHostId] = useState<string | undefined>(
    undefined,
  );
  const [newSessionCreation, setNewSessionCreation] = useState<{
    id?: string;
    initialization?: string;
  }>({});
  const [chatTabs, setChatTabs] = useState<ChatTab[]>(loadChatTabs);
  const chatTabsRef = useRef(chatTabs);
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([]);
  const [sharedSessions, setSharedSessions] = useState<SessionInfo[]>([]);
  const [hiddenSharedIds, setHiddenSharedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const sharedDiscoveryComplete = useRef(false);
  const membershipStreams = useRef(new Map<string, EventStream>());
  useEffect(() => {
    const ids = new Set(
      chatTabs.flatMap((tab) => (tab.session ? [tab.session.id] : [])),
    );
    for (const [id, stream] of membershipStreams.current) {
      if (!ids.has(id)) {
        stream.close();
        membershipStreams.current.delete(id);
      }
    }
    for (const id of ids) {
      if (!membershipStreams.current.has(id))
        membershipStreams.current.set(
          id,
          openEventStream({ kind: "open-chat", sessionId: id }),
        );
    }
  }, [chatTabs]);
  useEffect(
    () => () => {
      for (const stream of membershipStreams.current.values()) stream.close();
      membershipStreams.current.clear();
    },
    [],
  );
  useEffect(() => {
    const source = openEventStream({ kind: "open-chats" });
    let version = 0;
    let closed = false;
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { sessionIds?: unknown };
        if (
          !Array.isArray(data.sessionIds) ||
          !data.sessionIds.every((id) => typeof id === "string")
        )
          return;
        const ids: string[] = data.sessionIds;
        setOpenSessionIds(ids);
        setHiddenSharedIds(
          (hidden) => new Set([...hidden].filter((id) => ids.includes(id))),
        );
        const current = ++version;
        sharedDiscoveryComplete.current = false;
        if (ids.length === 0) {
          sharedDiscoveryComplete.current = true;
          setSharedSessions([]);
          return;
        }
        void fetch("/api/sessions")
          .then(async (response) => {
            if (!response.ok) { if (!closed && current === version) sharedDiscoveryComplete.current = true; return; }
            const result = (await response.json()) as {
              sessions: SessionInfo[];
            };
            if (!closed && current === version) {
              sharedDiscoveryComplete.current = true;
              setSharedSessions(
                result.sessions.filter((session) => ids.includes(session.id)),
              );
            }
          })
          .catch(() => { if (!closed && current === version) sharedDiscoveryComplete.current = true; });
      } catch {
        // Ignore malformed event frames.
      }
    };
    return () => {
      closed = true;
      source.close();
    };
  }, []);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  const visitedWorkspaces = useRef(new Set<string>());
  const pendingSharedWorkspace = useRef<{ cwd: string; hostId: string; tabId: string } | null>(null);
  const pendingWorkspaceDraft = useRef<{ cwd: string; hostId: string; tabId: string; revision: number } | null>(null);
  const updateChatTabs = useCallback(
    (update: (tabs: ChatTab[]) => ChatTab[]) => {
      const next = update(chatTabsRef.current);
      chatTabsRef.current = next;
      setChatTabs(next);
      try {
        sessionStorage.setItem(
          CHAT_TABS_STORAGE_KEY,
          JSON.stringify(next.slice(-100)),
        );
      } catch {
        /* Storage may be unavailable or full. */
      }
    },
    [],
  );
  const activateChat = useCallback((tab: ChatTab | null) => {
    if (tab && activeChatIdRef.current === tab.id) {
      setActiveTerminalId(null);
      return;
    }
    activeChatIdRef.current = tab?.id ?? null;
    if (tab && !tab.workspaceProject) {
      try {
        sessionStorage.setItem(
          `${CHAT_TABS_STORAGE_KEY}:active:${tab.hostId ?? LOCAL_HOST_ID}:${tab.cwd}`,
          tab.id,
        );
      } catch {
        /* Storage may be unavailable. */
      }
    }
    setActiveChatId(tab?.id ?? null);
    setSelectedSession(tab?.session ?? null);
    setNewSessionCwd(tab && !tab.session ? tab.cwd : null);
    setNewSessionHostId(tab?.hostId);
    setNewSessionCreation(tab?.creation ?? {});
    setActiveTerminalId(null);
    setSessionKey((key) => key + 1);
  }, []);
  const newSessionCreationId = newSessionCreation.id;
  const handleNewSessionInitialization = useCallback(
    (initialization: string) => {
      const tabId = activeChatIdRef.current;
      updateChatTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === tabId &&
          tab.creation.id === newSessionCreationId &&
          tab.creation.initialization === undefined
            ? { ...tab, creation: { ...tab.creation, initialization } }
            : tab,
        ),
      );
      setNewSessionCreation((current) =>
        current.id === newSessionCreationId &&
        current.initialization === undefined
          ? { ...current, initialization }
          : current,
      );
    },
    [newSessionCreationId, updateChatTabs],
  );
  const [workspaceOptions, setWorkspaceOptions] = useState<{
    projects: ManagedProject[];
    selectedProject: string | null;
    cwd: string | null;
    hostId: string;
  }>({ projects: [], selectedProject: null, cwd: null, hostId: LOCAL_HOST_ID });
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectHostId, setAddProjectHostId] =
    useState<string>(LOCAL_HOST_ID);
  const openAddProject = useCallback(
    (open: boolean, hostId: string = LOCAL_HOST_ID) => {
      setAddProjectHostId(hostId);
      setAddProjectOpen(open);
    },
    [],
  );
  const { hosts, pools } = useHostRows();
  const handleWorkspaceOptionsChange = useCallback(
    (
      projects: ManagedProject[],
      selectedProject: string | null,
      cwd: string | null,
      hostId: string,
    ) => {
      setWorkspaceOptions({ projects, selectedProject, cwd, hostId });
    },
    [],
  );
  const [initialCwdStatus, setInitialCwdStatus] = useState<
    "idle" | "validating" | "ready" | "error"
  >(() => (initialNavigation.requestedCwd ? "validating" : "idle"));
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [explorerRefreshing, setExplorerRefreshing] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    SIDEBAR_DEFAULT_WIDTH,
  );
  const [toolCallsDefaultCollapsed, setToolCallsDefaultCollapsed] =
    useState(true);
  const [hideToolActivity, setHideToolActivity] = useState(true);
  const [neverFoldActivity, setNeverFoldActivity] = useState(false);
  const [showToolCallsUnfolded, setShowToolCallsUnfolded] = useState(false);
  // UI-only behavior, stored locally rather than in omp's config.
  const [expandThinkingByDefault, setExpandThinkingByDefault] = useState<
    "off" | "latest" | "always"
  >("off");
  const [hideThinkingBlock, setHideThinkingBlock] = useState(false);
  useEffect(() => {
    // omp's own setting, so the transcript hides thinking when the TUI does.
    // Re-read on focus: the TUI or another tab may have changed it.
    const load = () => {
      fetch("/api/omp-settings")
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { settings?: { hideThinkingBlock?: boolean } } | null) => {
          if (data)
            setHideThinkingBlock(data.settings?.hideThinkingBlock === true);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);
  const [providerUsageVisible, setProviderUsageVisible] = useState(true);
  const [scopeNativeSelectAll, setScopeNativeSelectAll] = useState(false);
  const [openUrlAutomatically, setOpenUrlAutomatically] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  // Active drag handlers so an unmount mid-drag can detach them.
  const sidebarResizeHandlersRef = useRef<{
    onMove: (ev: MouseEvent) => void;
    onUp: () => void;
  } | null>(null);
  // DOM element + live width during a drag (see handleSidebarResizeStart).
  const sidebarContainerRef = useModalDialog<HTMLElement>({
    onClose: () => setSidebarOpen(false),
    active: isMobile && mobileSidebarReady && sidebarOpen && !settingsTab,
  });
  const pendingSidebarWidthRef = useRef<number>(SIDEBAR_DEFAULT_WIDTH);
  useEffect(() => {
    setSidebarWidth(loadSidebarWidth());
    try {
      setToolCallsDefaultCollapsed(
        window.localStorage.getItem(TOOL_CALLS_COLLAPSED_STORAGE_KEY) !==
          "false",
      );
      setHideToolActivity(
        window.localStorage.getItem(HIDE_TOOL_ACTIVITY_STORAGE_KEY) !== "false",
      );
      setNeverFoldActivity(
        window.localStorage.getItem(NEVER_FOLD_ACTIVITY_STORAGE_KEY) === "true",
      );
      setShowToolCallsUnfolded(
        window.localStorage.getItem(SHOW_TOOL_CALLS_UNFOLDED_STORAGE_KEY) ===
          "true",
      );
      const expandThinking = window.localStorage.getItem(
        EXPAND_THINKING_STORAGE_KEY,
      );
      setExpandThinkingByDefault(
        expandThinking === "true" || expandThinking === "always"
          ? "always"
          : expandThinking === "latest"
            ? "latest"
            : "off",
      );
      setProviderUsageVisible(
        window.localStorage.getItem(PROVIDER_USAGE_VISIBLE_STORAGE_KEY) !==
          "false",
      );
      setScopeNativeSelectAll(
        window.localStorage.getItem(NATIVE_SELECT_ALL_STORAGE_KEY) === "true",
      );
      setOpenUrlAutomatically(
        window.localStorage.getItem(OPEN_URL_AUTOMATICALLY_STORAGE_KEY) ===
          "true",
      );
    } catch {
      // Keep the compact default when storage is unavailable.
    }
  }, []);
  const handleToolCallsDefaultCollapsedChange = useCallback(
    (collapsed: boolean) => {
      setToolCallsDefaultCollapsed(collapsed);
      try {
        window.localStorage.setItem(
          TOOL_CALLS_COLLAPSED_STORAGE_KEY,
          String(collapsed),
        );
      } catch {
        // The preference still applies for this page load.
      }
    },
    [],
  );
  const handleHideToolActivityChange = useCallback((hide: boolean) => {
    setHideToolActivity(hide);
    try {
      window.localStorage.setItem(HIDE_TOOL_ACTIVITY_STORAGE_KEY, String(hide));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleNeverFoldActivityChange = useCallback((never: boolean) => {
    setNeverFoldActivity(never);
    try {
      window.localStorage.setItem(
        NEVER_FOLD_ACTIVITY_STORAGE_KEY,
        String(never),
      );
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleShowToolCallsUnfoldedChange = useCallback((show: boolean) => {
    setShowToolCallsUnfolded(show);
    try {
      window.localStorage.setItem(
        SHOW_TOOL_CALLS_UNFOLDED_STORAGE_KEY,
        String(show),
      );
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleExpandThinkingByDefaultChange = useCallback(
    (expand: "off" | "latest" | "always") => {
      setExpandThinkingByDefault(expand);
      try {
        window.localStorage.setItem(EXPAND_THINKING_STORAGE_KEY, expand);
      } catch {
        // The preference still applies for this page load.
      }
    },
    [],
  );
  const handleProviderUsageVisibleChange = useCallback((visible: boolean) => {
    setProviderUsageVisible(visible);
    try {
      window.localStorage.setItem(
        PROVIDER_USAGE_VISIBLE_STORAGE_KEY,
        String(visible),
      );
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleScopeNativeSelectAllChange = useCallback((enabled: boolean) => {
    setScopeNativeSelectAll(enabled);
    try {
      window.localStorage.setItem(
        NATIVE_SELECT_ALL_STORAGE_KEY,
        String(enabled),
      );
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleOpenUrlAutomaticallyChange = useCallback((enabled: boolean) => {
    setOpenUrlAutomatically(enabled);
    try {
      window.localStorage.setItem(
        OPEN_URL_AUTOMATICALLY_STORAGE_KEY,
        String(enabled),
      );
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  // Persist the committed width (after each change; skipped mid-drag, then
  // written once the drag ends). The first run is skipped so the mount-time
  // default cannot overwrite the stored width before it is loaded.
  const sidebarWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!sidebarWidthMountedRef.current) {
      sidebarWidthMountedRef.current = true;
      return;
    }
    if (sidebarResizing) return;
    try {
      window.localStorage.setItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
        String(sidebarWidth),
      );
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [sidebarWidth, sidebarResizing]);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  // Chrome does not blur a focused descendant when a subtree becomes
  // aria-hidden + inert (e.g. tapping a session button closes the mobile
  // drawer), which leaves focus trapped where assistive tech cannot see it.
  // Blur synchronously in the same commit so the AX tree never observes a
  // focused element inside the hidden sidebar.
  useLayoutEffect(() => {
    if (sidebarOpen || !mobileSidebarReady) return;
    const container = sidebarContainerRef.current;
    const active = document.activeElement;
    if (
      container &&
      active instanceof HTMLElement &&
      container.contains(active)
    ) {
      active.blur();
    }
  }, [sidebarOpen, mobileSidebarReady]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const [workspaceSwitcherTarget, setWorkspaceSwitcherTarget] =
    useState<HTMLDivElement | null>(null);
  const [sessionInfoContainer, setSessionInfoContainer] =
    useState<HTMLDivElement | null>(null);
  const [shipButtonContainer, setShipButtonContainer] =
    useState<HTMLDivElement | null>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(
    null,
  );
  const branchLeafChangeFnRef = useRef<
    ((leafId: string | null) => void) | null
  >(null);

  const handleBranchDataChange = useCallback(
    (
      tree: SessionTreeNode[],
      activeLeafId: string | null,
      onLeafChange: (leafId: string | null) => void,
    ) => {
      setBranchTree(tree);
      setBranchActiveLeafId(activeLeafId);
      branchLeafChangeFnRef.current = onLeafChange;
    },
    [],
  );

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);


  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(
    null,
  );
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({
    kind: "idle",
  });
  const autoNameTimerRef = useRef<TimerHandle | undefined>(undefined);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  const activeSettingsTabRef = useRef(settingsTab);
  const archiveRetryTimerRef = useRef<TimerHandle | undefined>(undefined);
  useEffect(() => () => clearTimeout(archiveRetryTimerRef.current), []);
  useLayoutEffect(() => {
    activeSessionIdRef.current = selectedSession?.id ?? null;
    activeSettingsTabRef.current = settingsTab;
  }, [selectedSession?.id, settingsTab]);
  const handleSessionStatsChange = useCallback(
    (stats: SessionStatsInfo | null) => {
      setSessionStats(stats);
    },
    [],
  );

  useEffect(() => {
    return () => {
      clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | null>(null);
  const mobileToolsRef = useRef<HTMLDetailsElement>(null);
  const mobileToolsContentRef = useRef<HTMLDivElement>(null);
  const restoreToolsFocusRef = useRef(false);
  const [compactTopbar, setCompactTopbar] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    if (compactTopbar && restoreToolsFocusRef.current) {
      mobileToolsRef.current?.querySelector("summary")?.focus();
      restoreToolsFocusRef.current = false;
    }
  }, [compactTopbar]);
  useEffect(() => {
    if (!compactTopbar) return;
    const closeOnOutside = (event: PointerEvent) => {
      const tools = mobileToolsRef.current;
      if (tools?.open && !tools.contains(event.target as Node)) {
        tools.open = false;
        setActiveTopPanel(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const tools = mobileToolsRef.current;
      // Nested pickers and session panels handle their own Escape first.
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        activeTopPanel ||
        !tools?.open
      )
        return;
      event.stopPropagation();
      tools.open = false;
      tools.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [compactTopbar, activeTopPanel]);
  const toggleTopPanel = useCallback(
    (panel: "branches") => {
      if (isMobile) setSidebarOpen(false);
      setActiveTopPanel((cur) => (cur === panel ? null : panel));
    },
    [isMobile],
  );

  // Generation speed — current live t/s and the session average.
  const [generationSpeed, setGenerationSpeed] =
    useState<GenerationSpeedInfo | null>(null);
  const handleGenerationSpeedChange = useCallback(
    (speed: GenerationSpeedInfo | null) => {
      setGenerationSpeed(speed);
    },
    [],
  );

  // /session opens the same information panel as the top-bar control.
  const openSessionStatsPanel = useCallback(() => {
    chatInputRef.current?.openContextPanel();
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
      if (mobileToolsRef.current) mobileToolsRef.current.open = false;
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, []);

  const changeSidebarWidth = useCallback((delta: number) => {
    setSidebarWidth((prev) => clampSidebarWidth(prev + delta));
  }, []);

  const handleSidebarResizeKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        changeSidebarWidth(-10);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        changeSidebarWidth(10);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        resetSidebarWidth();
      }
    },
    [changeSidebarWidth, resetSidebarWidth],
  );

  const handleSidebarResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (isMobile) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      // Interface Scale (html[data-ui-scale] zoom) leaves clientX in viewport
      // pixels while the sidebar width is zoomed layout pixels: scale the drag
      // delta so the edge tracks the pointer at any zoom (same --ui-scale
      // ground truth as the zoom-aware menus in SessionSidebar-chrome).
      let uiScale = 1;
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(
          "--ui-scale",
        );
        const value = parseFloat(raw);
        if (Number.isFinite(value) && value > 0) uiScale = value;
      } catch {
        // SSR/unavailable: fall back to unscaled math.
      }
      setSidebarResizing(true);
      const onMove = (ev: MouseEvent) => {
        const next = clampSidebarWidth(
          startWidth + (ev.clientX - startX) / uiScale,
        );
        // Write the CSS variable straight to the DOM: the flex row follows the
        // pointer without re-rendering the whole AppShell on every mousemove.
        sidebarContainerRef.current?.style.setProperty(
          "--sidebar-width",
          `${next}px`,
        );
        pendingSidebarWidthRef.current = next;
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        sidebarResizeHandlersRef.current = null;
        setSidebarResizing(false);
        // Commit the final width so state and the persisted value agree with
        // what the user actually dragged to.
        setSidebarWidth(pendingSidebarWidthRef.current);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      pendingSidebarWidthRef.current = startWidth;
      sidebarResizeHandlersRef.current = { onMove, onUp };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [isMobile, sidebarWidth],
  );

  // If the app unmounts mid-drag, remove the window listeners and restore the
  // body cursor; otherwise the handlers leak and body stays cursor:col-resize.
  useEffect(
    () => () => {
      const handlers = sidebarResizeHandlersRef.current;
      if (!handlers) return;
      window.removeEventListener("mousemove", handlers.onMove);
      window.removeEventListener("mouseup", handlers.onUp);
      sidebarResizeHandlersRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );

  const resetRightPanelWidth = useCallback(() => {
    rightPanelRef.current?.style.removeProperty("--right-panel-width");
    setRightPanelWidth(null);
  }, []);

  const changeRightPanelWidth = useCallback((delta: number) => {
    setRightPanelWidth((prev) => {
      // Keyboard steps from the fluid default start at the panel's live
      // width so the first press doesn't jump to the clamp minimum.
      const base =
        prev ??
        rightPanelRef.current?.getBoundingClientRect().width ??
        RIGHT_PANEL_MIN_WIDTH;
      const next = clampRightPanelWidth(base + delta);
      rightPanelRef.current?.style.setProperty(
        "--right-panel-width",
        `${next}px`,
      );
      return next;
    });
  }, []);

  const handleRightPanelResizeKey = useCallback(
    (e: React.KeyboardEvent) => {
      // The handle sits on the panel's left edge: left widens, right narrows.
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        changeRightPanelWidth(10);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        changeRightPanelWidth(-10);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        resetRightPanelWidth();
      }
    },
    [changeRightPanelWidth, resetRightPanelWidth],
  );

  const handleRightPanelResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (isMobile) return;
      e.preventDefault();
      const startX = e.clientX;
      // Live rect, not state: it always reflects the committed width (custom or
      // fluid default), and keeps this callback above the state declarations
      // without a TDZ cycle. The handle only exists while the panel is open.
      const measuredWidth =
        rightPanelRef.current?.getBoundingClientRect().width;
      // Same --ui-scale ground truth as the left sidebar handle: clientX is in
      // viewport pixels while the panel width is zoomed layout pixels.
      let uiScale = 1;
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(
          "--ui-scale",
        );
        const value = parseFloat(raw);
        if (Number.isFinite(value) && value > 0) uiScale = value;
      } catch {
        // SSR/unavailable: fall back to unscaled math.
      }
      // The rect is in viewport pixels; persisted panel widths are unscaled.
      const startWidth =
        measuredWidth === undefined
          ? RIGHT_PANEL_MIN_WIDTH
          : measuredWidth / uiScale;
      setRightPanelResizing(true);
      // Coalesce pointer writes per frame, but retain the latest width for mouseup.
      let frame: number | null = null;
      const cancelFrame = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      };
      const applyWidth = () => {
        frame = null;
        rightPanelRef.current?.style.setProperty(
          "--right-panel-width",
          `${pendingRightPanelWidthRef.current}px`,
        );
      };
      const onMove = (ev: MouseEvent) => {
        // Dragging the left edge left grows the panel: inverse of the sidebar.
        pendingRightPanelWidthRef.current = clampRightPanelWidth(
          startWidth - (ev.clientX - startX) / uiScale,
        );
        if (frame === null) frame = requestAnimationFrame(applyWidth);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        cancelFrame();
        applyWidth();
        rightResizeHandlersRef.current = null;
        setRightPanelResizing(false);
        // Commit the final width so state and the persisted value agree with
        // what the user actually dragged to.
        setRightPanelWidth(pendingRightPanelWidthRef.current);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      pendingRightPanelWidthRef.current = startWidth;
      rightResizeHandlersRef.current = { onMove, onUp, cancelFrame };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [isMobile],
  );

  // If the app unmounts mid-drag, remove the window listeners and restore the
  // body cursor; otherwise the handlers leak and body stays cursor:col-resize.
  useEffect(
    () => () => {
      const handlers = rightResizeHandlersRef.current;
      if (!handlers) return;
      window.removeEventListener("mousemove", handlers.onMove);
      window.removeEventListener("mouseup", handlers.onUp);
      handlers.cancelFrame();
      rightResizeHandlersRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );


  // Right panel tabs: Explorer | Git changes | open files (Tauri parity).
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const closeRightPanel = useCallback(() => {
    setRightPanelOpen(false);
    if (!isCompactOverlay) {
      topBarRef.current
        ?.querySelector<HTMLButtonElement>(".shell-panel-opener")
        ?.focus();
    }
  }, [isCompactOverlay]);
  const [rightPanelHasOpened, setRightPanelHasOpened] = useState(false);
  const [rightView, setRightView] = useState<RightPanelView>("explorer");
  const [activityContainer, setActivityContainer] =
    useState<HTMLDivElement | null>(null);
  const [sidebarActivityContainer, setSidebarActivityContainer] =
    useState<HTMLDivElement | null>(null);
  const connectionDiagnosticsOn = useConnectionDiagnosticsEnabled();
  // The Connection tab exists only while its setting is on; a selected one falls back to Explorer.
  useEffect(() => {
    if (!connectionDiagnosticsOn)
      setRightView((view) => (view === "connection" ? "explorer" : view));
  }, [connectionDiagnosticsOn]);
  const unreadNotifications = useUnreadNotificationCount();
  // Desktop shows the history in the top-bar bell's popover; mobile in the right panel's tab.
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  useEffect(() => {
    if (!isMobile)
      setRightView((view) => (view === "notifications" ? "explorer" : view));
  }, [isMobile]);
  // Settings replaces the top bar; the popover must not reopen on the way back.
  useEffect(() => {
    if (isMobile || settingsTab) setNotificationsOpen(false);
  }, [isMobile, settingsTab]);
  // Unread entries stay highlighted while the notifications are shown and
  // become read once the user leaves them (switches tab, closes the panel or popover).
  const viewingNotifications =
    (notificationsOpen || (rightPanelOpen && rightView === "notifications")) &&
    !settingsTab;
  const wasViewingNotificationsRef = useRef(false);
  // Layout effect: marks read before a notification arriving after the close can join the list.
  useLayoutEffect(() => {
    if (wasViewingNotificationsRef.current && !viewingNotifications)
      notificationHistory.markAllRead();
    wasViewingNotificationsRef.current = viewingNotifications;
  }, [viewingNotifications]);
  const opensNotifications =
    isMobile && unreadNotifications > 0 && !viewingNotifications;
  const panelOpenerLabel = opensNotifications
    ? t("appShell.showNotifications", { count: unreadNotifications })
    : rightPanelOpen
      ? t("appShell.hideFilePanel")
      : t("appShell.showFilePanel");
  // User-chosen pixel width (null = fluid 42% default), persisted.
  const [rightPanelWidth, setRightPanelWidth] = useState<number | null>(null);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  // The panel is code-split and mounts a render after its first open, so the
  // dialog behavior (focus, Escape, Tab wrap) waits until the element exists.
  // The rest of the page goes inert at the same moment: made inert earlier,
  // it would drop focus from the opener (e.g. a file link in the chat) before
  // the dialog records it, and closing could not return focus there.
  const [rightPanelMounted, setRightPanelMounted] = useState(false);
  const rightPanelIsModal =
    isCompactOverlay && rightPanelMounted && rightPanelOpen && !settingsTab;
  const rightPanelRef = useModalDialog<HTMLDivElement>({
    onClose: closeRightPanel,
    active: rightPanelIsModal,
  });
  const attachRightPanel = useCallback(
    (element: HTMLDivElement | null) => {
      rightPanelRef.current = element;
      setRightPanelMounted(element !== null);
    },
    [rightPanelRef],
  );
  useMobileSidebarGestures({
    enabled: isMobile && mobileSidebarReady && !settingsTab,
    leftOpen: sidebarOpen,
    rightOpen: rightPanelOpen,
    onLeftOpenChange: setSidebarOpen,
    onRightOpenChange: setRightPanelOpen,
  });
  const pendingRightPanelWidthRef = useRef<number | null>(null);
  const rightResizeHandlersRef = useRef<{
    onMove: (ev: MouseEvent) => void;
    onUp: () => void;
    cancelFrame: () => void;
  } | null>(null);
  useEffect(() => {
    setRightPanelWidth(loadRightPanelWidth());
  }, []);
  useEffect(() => {
    if (rightPanelOpen) setRightPanelHasOpened(true);
  }, [rightPanelOpen]);
  // Fetch the panel's code on the first interaction, so the first open rarely
  // waits for a download while pages nobody touches never fetch it. A failed
  // preload is retried by the first open.
  useEffect(() => {
    const preload = () => {
      window.removeEventListener("pointerdown", preload, true);
      window.removeEventListener("keydown", preload, true);
      import("./RightPanel").catch(() => {});
    };
    window.addEventListener("pointerdown", preload, true);
    window.addEventListener("keydown", preload, true);
    return () => {
      window.removeEventListener("pointerdown", preload, true);
      window.removeEventListener("keydown", preload, true);
    };
  }, []);
  // One-shot request asking the explorer tab to expand + scroll to a file.
  const [revealTarget, setRevealTarget] = useState<{
    path: string;
    hostId: string;
  } | null>(null);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [explorerGitCount, setExplorerGitCount] = useState(0);
  const [explorerIsRepo, setExplorerIsRepo] = useState(false);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const handleExplorerGitStatus = useCallback(
    (changedCount: number, isRepo: boolean) => {
      setExplorerGitCount(changedCount);
      setExplorerIsRepo(isRepo);
    },
    [],
  );
  // Same guard as the left sidebar: skip the mount run and mid-drag writes. A
  // reset (null) removes the key so the fluid default returns.
  const rightPanelWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!rightPanelWidthMountedRef.current) {
      rightPanelWidthMountedRef.current = true;
      return;
    }
    if (rightPanelResizing) return;
    try {
      if (rightPanelWidth === null)
        window.localStorage.removeItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
      else
        window.localStorage.setItem(
          RIGHT_PANEL_WIDTH_STORAGE_KEY,
          String(rightPanelWidth),
        );
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [rightPanelWidth, rightPanelResizing]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback(
    (relativePath: string, isDir: boolean) => {
      chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    },
    [],
  );

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback(
    (relativePath: string, startLine: number, endLine: number) => {
      chatInputRef.current?.insertText(
        buildFileLineMentionText(relativePath, startLine, endLine),
      );
    },
    [],
  );

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [activeHostId, setActiveHostId] = useState<string | undefined>(
    undefined,
  );
  // Owned by the sidebar; rendered by the file panel's Worktrees tab.
  const [worktreeCtx, setWorktreeCtx] = useState<WorktreeContext | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(
    () => !initialSessionId,
  );

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: requestedCwd,
        hostId: initialNavigation.hostId,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as {
          cwd?: string;
          error?: string;
          code?: string;
        };
        if (controller.signal.aborted) return;
        if (!response.ok || !data.cwd) {
          throw new Error(
            data.error || data.code
              ? formatApiError(data)
              : `HTTP ${response.status}`,
          );
        }

        visitedWorkspaces.current.add(
          `${remoteHostId(initialNavigation.hostId) ?? LOCAL_HOST_ID}:${data.cwd}`,
        );
        const existing = chatTabsRef.current.find((tab) =>
          tabInWorkspace(
            tab,
            data.cwd!,
            initialNavigation.hostId,
            workspaceOptions.projects,
          ),
        );
        const tab: ChatTab = existing ?? {
          id: browserUUID(),
          cwd: data.cwd,
          hostId: remoteHostId(initialNavigation.hostId),
          session: null,
          creation: { id: browserUUID() },
        };
        if (!existing) updateChatTabs((tabs) => [...tabs, tab]);
        activateChat(tab);
        setActiveCwd(data.cwd);
        setActiveHostId(remoteHostId(initialNavigation.hostId));
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(
          error instanceof Error ? error.message : String(error),
        );
        setInitialCwdStatus("error");
      });
    return () => controller.abort();
  }, [initialNavigation, activateChat, updateChatTabs]);

  const handleCwdChange = useCallback(
    (
      cwd: string | null,
      _projectRoot: string | null,
      hostId: string,
      _project?: ManagedProject,
      synchronized = false,
      latestSession?: SessionInfo,
      discovery?: "pending" | "resolved",
    ) => {
      if (discovery === "resolved") {
        const pending = pendingWorkspaceDraft.current;
        pendingWorkspaceDraft.current = null;
        if (!pending || pending.cwd !== cwd || pending.hostId !== hostId || activeChatIdRef.current !== pending.tabId || !latestSession || activeTerminalId || chatTabsRef.current.find((item) => item.id === pending.tabId)?.session) return;
        const key = newChatDraftKey(pending.cwd, remoteHostId(hostId));
        const draft = getDraftSummary(key);
        if (getDraftRevision(key) !== pending.revision || draft.text || draft.hasAttachments) return;
        const tab: ChatTab = { id: browserUUID(), cwd: latestSession.cwd, hostId: remoteHostId(latestSession.hostId), session: latestSession, creation: {} };
        updateChatTabs((tabs) => [...tabs.filter((item) => item.id !== pending.tabId), tab]);
        activateChat(tab);
        router.replace(`?session=${encodeURIComponent(latestSession.id)}`);
        return;
      }
      if (!synchronized && !(discovery === "pending" && pendingWorkspaceDraft.current?.cwd === cwd && pendingWorkspaceDraft.current.hostId === hostId)) pendingWorkspaceDraft.current = null;
      setActiveTerminalId(null);
      setActiveCwd(cwd);
      setActiveHostId(remoteHostId(hostId));
      if (initialSessionId && !initialSessionRestored) return;
      if (
        synchronized &&
        chatTabsRef.current.find((tab) => tab.id === activeChatIdRef.current)
          ?.workspaceProject
      )
        return;
      if (!cwd) return;
      const workspaceKey = `${remoteHostId(hostId) ?? LOCAL_HOST_ID}:${cwd}`;
      const currentTab = chatTabsRef.current.find(
        (tab) => tab.id === activeChatIdRef.current,
      );
      if (
        synchronized &&
        currentTab &&
        tabInWorkspace(currentTab, cwd, hostId, workspaceOptions.projects)
      )
        return;
      pendingSharedWorkspace.current = null;
      const alreadyVisited = visitedWorkspaces.current.has(workspaceKey);
      visitedWorkspaces.current.add(workspaceKey);
      let preferredId: string | null = null;
      try {
        preferredId = sessionStorage.getItem(
          `${CHAT_TABS_STORAGE_KEY}:active:${remoteHostId(hostId) ?? LOCAL_HOST_ID}:${cwd}`,
        );
      } catch {
        /* Storage may be unavailable. */
      }
      const candidates = chatTabsRef.current.filter((tab) =>
        tabInWorkspace(tab, cwd, hostId, workspaceOptions.projects),
      );
      const shared = sharedSessions.find((session) =>
        openSessionIds.includes(session.id) && !hiddenSharedIds.has(session.id) &&
        tabInWorkspace({ id: session.id, cwd: session.cwd, hostId: remoteHostId(session.hostId), session, creation: {} }, cwd, hostId, workspaceOptions.projects),
      );
      const existing = shared
        ? candidates.find((tab) => tab.session?.id === shared.id) ?? {
            id: browserUUID(), cwd: shared.cwd, hostId: remoteHostId(shared.hostId), session: shared, creation: {},
          }
        : preferredId === ""
          ? undefined
          : (candidates.find((tab) => tab.id === preferredId) ?? candidates[0] ?? (latestSession && !hiddenSharedIds.has(latestSession.id) ? {
              id: browserUUID(), cwd: latestSession.cwd, hostId: remoteHostId(latestSession.hostId), session: latestSession, creation: {},
            } : undefined));
      if (existing) {
        if (!shared && !sharedDiscoveryComplete.current) {
          pendingSharedWorkspace.current = { cwd, hostId, tabId: existing.id };
        }
        if (!candidates.includes(existing)) updateChatTabs((tabs) => [...tabs, existing]);
        activateChat(existing);
      } else if (!alreadyVisited && preferredId !== "") {
        const tab: ChatTab = {
          id: browserUUID(),
          cwd,
          hostId: remoteHostId(hostId),
          session: null,
          creation: { id: browserUUID() },
        };
        if (discovery === "pending") {
          const key = newChatDraftKey(cwd, remoteHostId(hostId));
          const draft = getDraftSummary(key);
          if (!draft.text && !draft.hasAttachments)
            pendingWorkspaceDraft.current = { cwd, hostId, tabId: tab.id, revision: getDraftRevision(key) };
        }
        updateChatTabs((tabs) => [...tabs, tab]);
        if (!sharedDiscoveryComplete.current) pendingSharedWorkspace.current = { cwd, hostId, tabId: tab.id };
        activateChat(tab);
      } else {
        activateChat(null);
      }
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setActiveTopPanel(null);
      router.replace(
        existing?.session
          ? `?session=${encodeURIComponent(existing.session.id)}`
          : "/",
      );
    },
    [
      router,
      activeTerminalId,
      activateChat,
      updateChatTabs,
      sharedSessions,
      openSessionIds,
      hiddenSharedIds,
      workspaceOptions.projects,
      initialSessionId,
      initialSessionRestored,
    ],
  );

  useEffect(() => {
    const pending = pendingSharedWorkspace.current;
    if (!pending || activeChatIdRef.current !== pending.tabId) return;
    const session = sharedSessions.find((item) =>
      openSessionIds.includes(item.id) && !hiddenSharedIds.has(item.id) &&
      tabInWorkspace({ id: item.id, cwd: item.cwd, hostId: remoteHostId(item.hostId), session: item, creation: {} }, pending.cwd, pending.hostId, workspaceOptions.projects),
    );
    if (!session) {
      if (sharedDiscoveryComplete.current) pendingSharedWorkspace.current = null;
      return;
    }
    pendingSharedWorkspace.current = null;
    const existing = chatTabsRef.current.find((item) => item.session?.id === session.id && remoteHostId(item.hostId) === remoteHostId(session.hostId));
    const tab: ChatTab = existing ?? { id: browserUUID(), cwd: session.cwd, hostId: remoteHostId(session.hostId), session, creation: {} };
    if (!existing) updateChatTabs((tabs) => [...tabs, tab]);
    activateChat(tab);
    router.replace(`?session=${encodeURIComponent(session.id)}`);
  }, [sharedSessions, openSessionIds, hiddenSharedIds, workspaceOptions.projects, updateChatTabs, activateChat, router]);

  const sessionLookupVersion = useRef(0);
  const handleSelectSession = useCallback(
    (session: SessionInfo, isRestore = false) => {
      setActiveTerminalId(null);
      sessionLookupVersion.current += 1;
      // Re-picking the already-open session (sidebar double-click, palette
      // re-select, notification click) must not bump sessionKey: that remounts
      // ChatWindow, reconnects SSE, and drops the mid-run streaming view.
      setSettingsTab(null);
      // Re-picking the current conversation still closes/rearms the drawer,
      // without remounting the chat or disturbing its draft.
      if (isMobile && !isRestore) {
        setSidebarOpen(false);
        requestAnimationFrame(() => chatInputRef.current?.focus());
      }
      const existing = chatTabsRef.current.find(
        (tab) =>
          tab.session?.id === session.id &&
          remoteHostId(tab.hostId) === remoteHostId(session.hostId),
      );
      const tab: ChatTab = existing
        ? {
            ...existing,
            session,
            cwd: session.cwd,
            hostId: remoteHostId(session.hostId),
          }
        : {
            id: browserUUID(),
            cwd: session.cwd,
            hostId: remoteHostId(session.hostId),
            session,
            creation: {},
          };
      updateChatTabs((tabs) =>
        existing
          ? tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...tabs, tab],
      );
      if (
        !isRestore &&
        activeChatIdRef.current === tab.id &&
        session.id === selectedSession?.id
      )
        return;
      activateChat(tab);
      setInitialSessionRestored(true);
      // Skip router.replace when restoring from the URL: the param is already correct.
      if (!isRestore) {
        router.replace(`?session=${encodeURIComponent(session.id)}`);
      }
    },
    [router, isMobile, selectedSession?.id, activateChat, updateChatTabs],
  );

  const handleNewSession = useCallback(
    (
      creationId: string,
      cwd: string | null,
      hostId?: string,
      _project?: ManagedProject,
      initialization?: string,
      keepSidebarOpen = false,
      workspaceFixed = false,
    ) => {
      setActiveTerminalId(null);
      sessionLookupVersion.current += 1;
      setSettingsTab(null);
      if (!cwd) return;
      const existing = creationId
        ? chatTabsRef.current.find(
            (item) => item.creation.id === creationId && !item.session,
          )
        : undefined;
      const tab: ChatTab = existing ?? {
        id: browserUUID(),
        cwd,
        hostId: remoteHostId(hostId),
        session: null,
        creation: { id: creationId || browserUUID(), initialization },
        workspaceFixed,
      };
      if (!existing) updateChatTabs((tabs) => [...tabs, tab]);
      activateChat(tab);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setActiveTopPanel(null);
      if (isMobile && !keepSidebarOpen) {
        setSidebarOpen(false);
        requestAnimationFrame(() => chatInputRef.current?.focus());
      }
      router.replace("/");
    },
    [router, isMobile, activateChat, updateChatTabs],
  );

  const handleNewWorkspace = useCallback(
    (project: ManagedProject) => {
      if (project.projectKind !== "git") {
        handleNewSession(
          browserUUID(),
          project.path,
          project.hostId,
          project,
          undefined,
          false,
        );
        return;
      }
      const tab: ChatTab = {
        id: browserUUID(),
        cwd: project.path,
        hostId: remoteHostId(project.hostId),
        session: null,
        creation: { id: browserUUID() },
        workspaceProject: project.projectPath ?? project.path,
      };
      updateChatTabs((tabs) => [...tabs, tab]);
      activateChat(tab);
      setSettingsTab(null);
      router.replace("/");
      if (isMobile) setSidebarOpen(false);
      else requestAnimationFrame(() => chatInputRef.current?.focus());
    },
    [handleNewSession, updateChatTabs, activateChat, router, isMobile],
  );

  const workspaceDraft = chatTabs.find(
    (tab) => tab.id === activeChatId && !tab.session && tab.workspaceProject,
  );
  const pendingWorkspace = workspaceDraft?.workspaceProject;
  const sourceTabId = workspaceDraft?.workspaceJob
    ? undefined
    : workspaceDraft?.id;
  const sourceHost = workspaceDraft?.hostId ?? "local";
  const [workspaceSourceResult, setWorkspaceSourceResult] = useState<{
    tabId: string;
    branches?: WorkspaceBranches;
    error?: string;
  }>();
  useEffect(() => {
    if (!sourceTabId || !pendingWorkspace) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      action: "branches",
      hostId: sourceHost,
      projectPath: pendingWorkspace,
    });
    void (async () => {
      try {
        const response = await fetch(`/api/worktrees?${params}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? "Couldn't load workspace sources");
        if (!controller.signal.aborted)
          setWorkspaceSourceResult({ tabId: sourceTabId, branches: data });
      } catch (error) {
        if (!controller.signal.aborted)
          setWorkspaceSourceResult({
            tabId: sourceTabId,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => controller.abort();
  }, [sourceTabId, sourceHost, pendingWorkspace]);
  const workspaceSources =
    workspaceSourceResult?.tabId === sourceTabId
      ? workspaceSourceResult
      : undefined;
  const workspaceBaseRef = selectedWorkspaceBase(
    workspaceSources?.branches,
    workspaceDraft?.workspaceSource,
  );
  const prepareNewWorkspace = useMemo(() => {
    if (!pendingWorkspace) return undefined;
    let pending: Promise<{ cwd: string; name: string }> | undefined;
    return (prompt: string) => {
      if (pending) return pending;
      pending = (async () => {
        const tab = chatTabsRef.current.find(
          (item) => item.id === activeChatId,
        );
        if (!tab) throw new Error("Workspace draft is closed");
        const save = (job: WorkspaceCreationJob) => {
          tab.workspaceJob = job;
          updateChatTabs((tabs) =>
            tabs.map((item) =>
              item.id === tab.id ? { ...item, workspaceJob: job } : item,
            ),
          );
        };
        let job = tab.workspaceJob;
        if (!job) {
          if (!workspaceBaseRef) throw new Error("Choose a base branch first");
          const response = await fetch("/api/worktrees", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "prepare",
              hostId: tab.hostId ?? "local",
              input: {
                projectPath: pendingWorkspace,
                prompt,
                baseRef: workspaceBaseRef,
              } satisfies WorkspacePrepareRequest,
            }),
          });
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error ?? "Workspace creation failed");
          job = data as WorkspaceCreationJob;
          save(job);
        }
        while (job.status === "running" && job.stage !== "postNonBlocking") {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const response = await fetch(
            `/api/worktrees?${new URLSearchParams({ action: "status", hostId: tab.hostId ?? "local", id: job.id })}`,
          );
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error ?? "Workspace status unavailable");
          job = data as WorkspaceCreationJob;
          save(job);
        }
        if (
          !job.workspaceId ||
          !job.workspacePath ||
          job.stage !== "postNonBlocking"
        )
          throw new Error(
            job.error ??
              "Workspace setup did not complete. Check Manage workspaces for logs.",
          );
        return { cwd: job.workspacePath, name: job.input.name };
      })().catch((error) => {
        pending = undefined;
        throw error;
      });
      return pending;
    };
  }, [activeChatId, pendingWorkspace, workspaceBaseRef, updateChatTabs]);

  // ---- In-app Navigate back / forward over visited chat views ----

  const [pendingSessionImport, setPendingSessionImport] = useState<{
    session: SessionInfo;
    hostId: string;
    workspaceId: string;
    workspacePath: string;
  } | null>(null);
  const [importingSession, setImportingSession] = useState(false);
  const openLinkedSession = useCallback(
    async (id: string, restore = false) => {
      const version = ++sessionLookupVersion.current;
      setPendingSessionImport(null);
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(id)}?deferThinking&deferMedia&tail=1`,
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const detail = (await response.json()) as {
          info: SessionInfo;
          hostId: string;
        };
        if (!detail.info?.cwd || !detail.hostId)
          throw new Error("Session location is unavailable");
        const hierarchyResponse = await fetch(
          `/api/hierarchy?host=${encodeURIComponent(detail.hostId)}`,
        );
        if (!hierarchyResponse.ok)
          throw new Error(`HTTP ${hierarchyResponse.status}`);
        const hierarchy = (await hierarchyResponse.json()) as HierarchySnapshot;
        if (version !== sessionLookupVersion.current) return;
        const cwd = comparableProjectPath(detail.info.cwd);
        const workspaces = hierarchy.projects.flatMap(
          (project) => project.workspaces,
        );
        const workspace = workspaces
          .filter((item) => {
            const path = comparableProjectPath(item.path);
            return (
              cwd === path || cwd.startsWith(path === "/" ? "/" : `${path}/`)
            );
          })
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (!workspace)
          throw new Error("No registered workspace contains this session");
        const session = { ...detail.info, hostId: detail.hostId };
        if (workspace.sessionIds.includes(id))
          handleSelectSession(session, restore);
        else
          setPendingSessionImport({
            session,
            hostId: detail.hostId,
            workspaceId: workspace.id,
            workspacePath: workspace.path,
          });
      } catch (error) {
        if (version === sessionLookupVersion.current)
          toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        if (version === sessionLookupVersion.current && restore)
          setInitialSessionRestored(true);
      }
    },
    [handleSelectSession],
  );
  const restoredLinkedSession = useRef<string | null>(null);
  useEffect(() => {
    if (
      initialSessionId &&
      restoredLinkedSession.current !== initialSessionId
    ) {
      restoredLinkedSession.current = initialSessionId;
      void openLinkedSession(initialSessionId, true);
    }
  }, [initialSessionId, openLinkedSession]);

  const importLinkedSession = useCallback(async () => {
    if (!pendingSessionImport || importingSession) return;
    setImportingSession(true);
    try {
      const response = await fetch("/api/hierarchy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: pendingSessionImport.hostId,
          input: {
            action: "importSessions",
            workspaceId: pendingSessionImport.workspaceId,
            sessionIds: [pendingSessionImport.session.id],
          },
        }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(error.error ?? `HTTP ${response.status}`);
      }
      const session = pendingSessionImport.session;
      setPendingSessionImport(null);
      setRefreshKey((key) => key + 1);
      publishSessionsChanged([session.id]);
      handleSelectSession(session);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingSession(false);
    }
  }, [pendingSessionImport, importingSession, handleSelectSession]);
  // Own stack, not the browser History API (that one belongs to the mobile
  // back-gesture/exit-guard machinery — see lib/navigation-history.ts).
  const navigationHistory = useNavigationHistory();
  const {
    record: recordNavigationView,
    peekBack: peekNavigationBack,
    peekForward: peekNavigationForward,
  } = navigationHistory;
  // Bumped by the recording effect on every view change. navigateInHistory
  // captures it across its await and bails if the user moved on meanwhile,
  // so a slow session-list fetch can never yank the chat out from under a
  // view the user just switched to.
  const navViewVersionRef = useRef(0);
  const navSessionId = selectedSession?.id ?? null;
  const navSessionCwd = selectedSession?.cwd ?? null;
  useEffect(() => {
    navViewVersionRef.current += 1;
    recordNavigationView({
      sessionId: navSessionId,
      cwd: navSessionId ? navSessionCwd : newSessionCwd,
      ...(!navSessionId && newSessionHostId
        ? { hostId: newSessionHostId }
        : {}),
      ...(!navSessionId ? { creationId: newSessionCreationId } : {}),
      ...(!navSessionId && newSessionCreation.initialization
        ? { initialization: newSessionCreation.initialization }
        : {}),
    });
  }, [
    navSessionId,
    navSessionCwd,
    newSessionCwd,
    newSessionHostId,
    newSessionCreation,
    newSessionCreationId,
    recordNavigationView,
  ]);

  // Resolves a history entry's session id against the live list. `null`
  // means the id is gone (entry should be dropped); "unavailable" means the
  // list itself could not be fetched (keep the entry, abort this navigation).
  const fetchSessionForNavigation = useCallback(
    async (sessionId: string): Promise<SessionInfo | null | "unavailable"> => {
      try {
        const res = await fetch(
          `/api/sessions?id=${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok) return "unavailable";
        const data = (await res.json()) as { sessions?: SessionInfo[] };
        return data.sessions?.find((s) => s.id === sessionId) ?? null;
      } catch {
        return "unavailable";
      }
    },
    [],
  );

  const navigateInHistory = useCallback(
    async (direction: -1 | 1): Promise<void> => {
      // Dead entries (deleted sessions) are skipped, like browser history
      // skipping a dead slot; bound the loop by the stack's own cap.
      for (
        let attempt = 0;
        attempt <= NAVIGATION_HISTORY_MAX_ENTRIES;
        attempt++
      ) {
        const entry =
          direction === -1 ? peekNavigationBack() : peekNavigationForward();
        // Nothing that way: stay put. An exhausted stack never falls through to
        // the browser's own back/forward — the keystroke is swallowed by the
        // keyboard layer, so the app can never be backed out of by accident.
        if (!entry) return;
        if (entry.sessionId === null) {
          if (direction === -1) navigationHistory.commitBack();
          else navigationHistory.commitForward();
          handleNewSession(
            entry.creationId ?? browserUUID(),
            entry.cwd,
            entry.hostId,
            undefined,
            entry.initialization,
          );
          return;
        }
        const versionAtPress = navViewVersionRef.current;
        const session = await fetchSessionForNavigation(entry.sessionId);
        if (navViewVersionRef.current !== versionAtPress) return; // user moved on: do nothing
        if (session === "unavailable") return; // list fetch failed: keep the entry, try again next press
        if (session) {
          if (direction === -1) navigationHistory.commitBack();
          else navigationHistory.commitForward();
          handleSelectSession(session, false);
          return;
        }
        if (direction === -1) navigationHistory.dropPeekedBack();
        else navigationHistory.dropPeekedForward();
      }
    },
    [
      navigationHistory,
      peekNavigationBack,
      peekNavigationForward,
      fetchSessionForNavigation,
      handleNewSession,
      handleSelectSession,
      workspaceOptions.projects,
    ],
  );

  // Shared by the sidebar buttons and the global shortcuts. The keyboard
  // layer always swallows the keystroke, so both directions stop dead at the
  // ends of the stack instead of continuing into browser history.
  const handleNavigateBack = useCallback(() => {
    void navigateInHistory(-1);
  }, [navigateInHistory]);
  const handleNavigateForward = useCallback(() => {
    void navigateInHistory(1);
  }, [navigateInHistory]);

  // Tooltip shortcut labels follow the platform (⌘[ vs Alt+←). Computed from
  // navigator after mount state to keep SSR markup stable.
  const [navIsMac] = useState(() => isMacPlatform());
  const sidebarNavigation = useMemo(
    () => ({
      canBack: navigationHistory.canBack,
      canForward: navigationHistory.canForward,
      onBack: handleNavigateBack,
      onForward: handleNavigateForward,
      backShortcut: navigateShortcutHint(-1, navIsMac),
      forwardShortcut: navigateShortcutHint(1, navIsMac),
    }),
    [
      navigationHistory.canBack,
      navigationHistory.canForward,
      handleNavigateBack,
      handleNavigateForward,
      navIsMac,
    ],
  );

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) =>
      handleNewSession(browserUUID(), cwd, activeHostId),
    onNavigateBack: handleNavigateBack,
    onNavigateForward: handleNavigateForward,
    activeCwd,
    scopeNativeSelectAll,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback(
    (sessionId: string) => {
      void fetch("/api/sessions")
        .then((r) =>
          r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null,
        )
        .then((d) => {
          const full = d?.sessions.find((s) => s.id === sessionId);
          if (!full) return;
          updateChatTabs((tabs) =>
            tabs.map((tab) =>
              tab.session?.id === sessionId
                ? {
                    ...tab,
                    session: { ...full, name: tab.session.name || full.name },
                    cwd: full.cwd,
                    hostId: remoteHostId(full.hostId),
                  }
                : tab,
            ),
          );
          setSelectedSession((prev) =>
            prev &&
            prev.id === sessionId &&
            (!prev.projectRoot || prev.path === "")
              ? { ...full, name: prev.name || full.name }
              : prev,
          );
        })
        .catch(() => {});
    },
    [updateChatTabs],
  );
  // Open chat tabs outlive the sidebar's session list. Refresh their titles
  // when the running channel reports a list change, including auto-naming.
  useEffect(() => {
    const source = openEventStream({ kind: "running" });
    let closed = false;
    let loading = false;
    let pending = false;
    const refresh = async () => {
      if (loading) {
        pending = true;
        return;
      }
      loading = true;
      do {
        pending = false;
        try {
          const response = await fetch("/api/sessions");
          if (!response.ok) continue;
          const data = (await response.json()) as { sessions: SessionInfo[] };
          if (closed) return;
          const names = new Map(
            data.sessions.map((session) => [session.id, session.name]),
          );
          updateChatTabs((tabs) =>
            tabs.map((tab) => {
              const name = tab.session && names.get(tab.session.id);
              return name && name !== tab.session?.name
                ? { ...tab, session: { ...tab.session!, name } }
                : tab;
            }),
          );
          setSharedSessions((sessions) =>
            sessions.map((session) => {
              const name = names.get(session.id);
              return name && name !== session.name ? { ...session, name } : session;
            }),
          );
          setSelectedSession((current) => {
            const name = current && names.get(current.id);
            return current && name && name !== current.name
              ? { ...current, name }
              : current;
          });
        } catch {
          // The next list change or reconnect retries.
        }
      } while (pending && !closed);
      loading = false;
    };
    source.onopen = () => void refresh();
    source.onmessage = (event) => {
      try {
        if (JSON.parse(event.data).refreshSessionList) void refresh();
      } catch {
        // Ignore malformed frames.
      }
    };
    return () => {
      closed = true;
      source.close();
    };
  }, [updateChatTabs]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback(
    (tabId: string | null, session: SessionInfo) => {
      const tab = chatTabsRef.current.find((item) => item.id === tabId);
      if (!tab) return;
      updateChatTabs((tabs) =>
        tabs.map((item) =>
          item.id === tabId
            ? {
                ...item,
                workspaceProject: undefined,
                workspaceJob: undefined,
                session,
                cwd: session.cwd,
                hostId: remoteHostId(session.hostId),
              }
            : item,
        ),
      );
      if (activeChatIdRef.current === tabId) {
        setActiveCwd(session.cwd);
        setActiveHostId(remoteHostId(session.hostId));
        setNewSessionCwd(null);
        setSelectedSession(session);
        hydrateSelectedSession(session.id);
        router.replace(`?session=${encodeURIComponent(session.id)}`);
      }
      setRefreshKey((k) => k + 1);
    },
    [router, hydrateSelectedSession, updateChatTabs],
  );

  const handleSessionMoved = useCallback(
    (oldId: string, newId: string) => {
      updateChatTabs((tabs) =>
        tabs.map((tab) =>
          tab.session?.id === oldId
            ? { ...tab, session: { ...tab.session, id: newId, path: "" } }
            : tab,
        ),
      );
      if (activeSessionIdRef.current !== oldId) return;
      activeSessionIdRef.current = newId;
      setSelectedSession((current) =>
        current?.id === oldId ? { ...current, id: newId, path: "" } : current,
      );
      setRefreshKey((key) => key + 1);
      hydrateSelectedSession(newId);
      // This is the same conversation. Preserve ChatWindow's run/edit fences
      // and its mounted composer, including unfinished attachments and audio.
      router.replace(`?session=${encodeURIComponent(newId)}`);
    },
    [router, hydrateSelectedSession, updateChatTabs],
  );

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const openSessionById = useCallback(
    (sessionId: string) => {
      window.focus();
      // On narrow screens the file panel covers the chat it is about to show.
      if (isCompactOverlay) setRightPanelOpen(false);
      void openLinkedSession(sessionId);
    },
    [openLinkedSession, isCompactOverlay],
  );

  // Full-page Settings hides the chat, so its session counts as not viewed.
  useNotifications({
    sessionId: settingsTab ? null : (selectedSession?.id ?? null),
    onOpenSession: openSessionById,
  });

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/auto-name`,
        {
          method: "POST",
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        title?: string;
        error?: string;
        code?: string;
      };
      if (!response.ok || !body.title) {
        throw new Error(
          body.error || body.code
            ? formatApiError(body)
            : `HTTP ${response.status}`,
        );
      }

      const title = body.title.trim();
      if (activeSessionIdRef.current !== sessionId) return;
      setRefreshKey((key) => key + 1);
      updateChatTabs((tabs) =>
        tabs.map((tab) =>
          tab.session?.id === sessionId
            ? { ...tab, session: { ...tab.session, name: title } }
            : tab,
        ),
      );
      setSelectedSession((current) =>
        current?.id === sessionId ? { ...current, name: title } : current,
      );
      setSessionStats((current) =>
        current?.sessionId === sessionId
          ? { ...current, sessionName: title }
          : current,
      );
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(
        () => setAutoNameStatus({ kind: "idle" }),
        1800,
      );
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(
        () => setAutoNameStatus({ kind: "idle" }),
        5000,
      );
    }
  }, [autoNameStatus.kind, selectedSession?.id, updateChatTabs]);
  const handleRenameSession = useCallback(
    async (name: string) => {
      const sessionId = selectedSession?.id;
      if (!sessionId) return;
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim() }),
          },
        );
        if (!response.ok) throw new Error("Session rename failed");
        const title = name.trim();
        updateChatTabs((tabs) =>
          tabs.map((tab) =>
            tab.session?.id === sessionId
              ? { ...tab, session: { ...tab.session, name: title } }
              : tab,
          ),
        );
        setSelectedSession((current) =>
          current?.id === sessionId ? { ...current, name: title } : current,
        );
        setSessionStats((current) =>
          current?.sessionId === sessionId
            ? { ...current, sessionName: title }
            : current,
        );
        publishSessionsChanged([sessionId]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [selectedSession?.id, updateChatTabs],
  );

  useEffect(() => {
    clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshing(true);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleExplorerRefreshDone = useCallback(() => {
    setExplorerRefreshing(false);
  }, []);

  const handleSessionForked = useCallback(
    (newSessionId: string) => {
      setRefreshKey((k) => k + 1);
      const source = chatTabsRef.current.find(
        (tab) => tab.id === activeChatIdRef.current,
      );
      if (!source?.session) return;
      const tab: ChatTab = {
        ...source,
        id: browserUUID(),
        session: { ...source.session, id: newSessionId, path: "" },
        creation: {},
      };
      updateChatTabs((tabs) => [...tabs, tab]);
      activateChat(tab);
      hydrateSelectedSession(newSessionId);
      router.replace(`?session=${encodeURIComponent(newSessionId)}`);
    },
    [router, hydrateSelectedSession, updateChatTabs, activateChat],
  );

  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      // The composer for this session can never be reopened, so its draft would
      // otherwise keep the exit guard armed for unreachable content.
      clearDraft(sessionId);
      setRefreshKey((k) => k + 1);
      const removed = chatTabsRef.current.find(
        (tab) => tab.session?.id === sessionId,
      );
      updateChatTabs((tabs) =>
        tabs.filter((tab) => tab.session?.id !== sessionId),
      );
      if (
        (removed && activeChatIdRef.current === removed.id) ||
        activeSessionIdRef.current === sessionId
      ) {
        const next = chatTabsRef.current.find((tab) =>
          tabInWorkspace(
            tab,
            activeCwd ?? removed?.cwd ?? "",
            removed?.hostId,
            workspaceOptions.projects,
          ),
        );
        activateChat(next ?? null);
        router.replace(
          next?.session
            ? `?session=${encodeURIComponent(next.session.id)}`
            : "/",
        );
      }
    },
    [
      router,
      activeCwd,
      activateChat,
      updateChatTabs,
      workspaceOptions.projects,
    ],
  );
  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleArchiveRestored = useCallback(
    async (sessionId: string) => {
      setArchiveBrowserOpen(false);
      publishSessionsChanged([sessionId]);
      setRefreshKey((k) => k + 1);

      // The poll must not yank the UI back to the restored session if the user
      // picks another one while we wait, and an untracked setTimeout chain would
      // keep retrying after unmount — so freeze the selection at start, bail out
      // of every attempt + the fallback when it changed, and track the timer.
      const sessionAtRestoreStart = activeSessionIdRef.current;
      const selectRestoredSession = async (attemptsLeft = 5): Promise<void> => {
        if (activeSessionIdRef.current !== sessionAtRestoreStart) return;
        try {
          const res = await fetch("/api/sessions");
          if (res.ok) {
            const data = (await res.json()) as { sessions?: SessionInfo[] };
            const found = data.sessions?.find((s) => s.id === sessionId);
            if (found) {
              if (activeSessionIdRef.current !== sessionAtRestoreStart) return;
              handleSelectSession(found, false);
              return;
            }
          }
        } catch {
          // network error / abort
        }

        if (attemptsLeft > 0) {
          archiveRetryTimerRef.current = setTimeout(
            () => void selectRestoredSession(attemptsLeft - 1),
            300,
          );
        } else if (activeSessionIdRef.current === sessionAtRestoreStart) {
          router.replace(`?session=${encodeURIComponent(sessionId)}`);
        }
      };

      void selectRestoredSession();
    },
    [handleSelectSession, router],
  );

  const handleCloseFileTab = useCallback(
    (tabId: string) => {
      // Compute everything from the current list outside the updaters: no side
      // effect inside a state updater, and no stale-closure read (the callback
      // is recreated whenever fileTabs changes, but a batched double-close
      // would still have read the pre-close list from the closure).
      const next = fileTabs.filter((t) => t.id !== tabId);
      setFileTabs(next);
      // The panel now hosts the Explorer tab, so it stays open: closing the
      // last file falls back to the explorer instead of hiding the panel.
      if (next.length === 0) setRightView("explorer");
      setActiveFileTabId((cur) => {
        if (cur !== tabId) return cur;
        return next.length > 0 ? next[next.length - 1].id : null;
      });
    },
    [fileTabs],
  );

  const handleOpenFile = useCallback(
    (filePath: string, fileName: string, source: WorkspaceFileSource) => {
      const absolute = filePath.startsWith("/") || filePath.startsWith("~/");
      const rooted =
        !absolute && source.cwd ? joinFilePath(source.cwd, filePath) : filePath;
      const target = filePath.startsWith("~/")
        ? filePath
        : normalizeLocalPath(rooted);
      const tabId = `file:${source.sessionId ?? hostProjectKey(source.hostId, source.cwd ?? "")}:${target}`;
      setFileTabs((prev) =>
        prev.some((tab) => tab.id === tabId)
          ? prev
          : [
              ...prev,
              {
                id: tabId,
                label: fileName,
                filePath: target,
                hostId: source.hostId,
                sourceCwd: source.cwd,
                sourceSessionId: source.sessionId,
              },
            ],
      );
      setActiveFileTabId(tabId);
      setRightView("file");
      setRightPanelOpen(true);
      // On mobile the file panel is full-screen; close the drawer so it shows.
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile],
  );

  // Agent open requests that wait for the user. URLs always ask unless the
  // user opted into opening links from the viewed session automatically; URLs
  // and files from a session this tab is not viewing always ask, so they cannot
  // take over the current view. The click is also the user gesture that lets
  // the new tab through pop-up blockers.
  const [pendingOpens, setPendingOpens] = useState<
    Array<
      {
        target: string;
        name: string;
        sessionId: string;
        crossSession: boolean;
      } & ({ kind: "url" } | { kind: "file"; source: WorkspaceFileSource })
    >
  >([]);
  const pendingOpen = pendingOpens[0] ?? null;
  // Keep the last request on screen while the dialog animates closed.
  const shownOpenRef = useRef(pendingOpen);
  if (pendingOpen) shownOpenRef.current = pendingOpen;
  const shownOpen = pendingOpen ?? shownOpenRef.current;
  const dismissPendingOpen = useCallback(
    () => setPendingOpens((queue) => queue.slice(1)),
    [],
  );
  const requestOpenUrl = useCallback(
    (url: string, sessionId: string, crossSession: boolean): string => {
      if (!crossSession && openUrlAutomatically) {
        window.open(url, "_blank", "noopener,noreferrer")?.focus?.();
        return `Opened ${url}`;
      }
      setPendingOpens((queue) => [
        ...queue,
        { kind: "url", target: url, name: url, sessionId, crossSession },
      ]);
      return crossSession
        ? `Asked the user to confirm opening ${url}; they are viewing another key lime session.`
        : `Asked the user to confirm opening ${url}.`;
    },
    [openUrlAutomatically],
  );
  const handleSessionOpenUrl = useCallback(
    (url: string) => requestOpenUrl(url, selectedSession?.id ?? "", false),
    [requestOpenUrl, selectedSession?.id],
  );
  const pendingCrossHostToolsRef = useRef(new Map<string, AbortController>());
  const handleCrossSessionHostTool = useCallback(
    async (call: CrossSessionHostToolCall) => {
      const key = JSON.stringify([call.sessionId, call.id]);
      if (pendingCrossHostToolsRef.current.has(key)) return;
      const controller = new AbortController();
      pendingCrossHostToolsRef.current.set(key, controller);
      // Full-page Settings hides the chat, so its session counts as not viewed.
      const viewing = () =>
        call.sessionId === activeSessionIdRef.current &&
        !activeSettingsTabRef.current;

      try {
        const { text, isError } = await runHostTool(
          call.toolName,
          call.arguments,
          {
            openUrl: (url) => requestOpenUrl(url, call.sessionId, !viewing()),
            openFile: (path, name, owner) => {
              const source = owner ? { ...call, sessionId: owner } : call;
              if (viewing()) return handleOpenFile(path, name, source);
              setPendingOpens((queue) => [
                ...queue,
                {
                  kind: "file",
                  target: path,
                  name,
                  sessionId: call.sessionId,
                  source,
                  crossSession: true,
                },
              ]);
              return `Asked the user to confirm opening ${path}; they are viewing another key lime session.`;
            },
          },
          call.sessionId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        await sendAgentCommand(call.sessionId, {
          type: "host_tool_result",
          id: call.id,
          isError,
          result: { content: [{ type: "text", text }] },
        });
      } catch (e) {
        console.error("Failed to send host tool result:", e);
      } finally {
        pendingCrossHostToolsRef.current.delete(key);
      }
    },
    [handleOpenFile, requestOpenUrl],
  );
  const crossSessionHostToolRef = useRef(handleCrossSessionHostTool);
  useEffect(() => {
    crossSessionHostToolRef.current = handleCrossSessionHostTool;
  }, [handleCrossSessionHostTool]);
  useEffect(() => {
    // Mounted with the shell (not the sidebar) so it keeps listening on the
    // full-page Settings view too.
    const pending = pendingCrossHostToolsRef.current;
    const source = openEventStream({ kind: "host-tools" });
    source.onmessage = (e) => {
      try {
        const call = JSON.parse(e.data);
        if (
          call.type === "host_tool_cancel" &&
          typeof call.sessionId === "string" &&
          typeof call.targetId === "string"
        ) {
          pending.get(JSON.stringify([call.sessionId, call.targetId]))?.abort();
        } else if (
          call.type === "host_tool_call" &&
          call.sessionId &&
          call.id &&
          call.toolName &&
          typeof call.hostId === "string" &&
          typeof call.cwd === "string"
        ) {
          void crossSessionHostToolRef.current(call);
        }
      } catch {
        // ignore malformed frames
      }
    };
    // A drop loses the server-side subscription, and with it the calls routed to this tab (rejectCrossSessionHostTools).
    source.onerror = () => {
      for (const controller of pending.values()) controller.abort();
    };
    return () => {
      for (const controller of pending.values()) controller.abort();
      source.close();
    };
  }, []);

  const activeFileTab =
    fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  // Explorer, Git, and the file viewers follow the open session's folder, then
  // the sidebar's live cwd, then the new-session cwd. Relative paths (mention,
  // copy path) resolve against the same folder so they match the Explorer.
  // A session whose worktree was removed (its repo's worktree list no longer
  // contains its folder) falls back to the sidebar's cwd, the repo root.
  const sessionCwd = selectedSession?.cwd ?? null;
  const sessionWorktreeRemoved =
    sessionCwd !== null &&
    worktreeCtx !== null &&
    (selectedSession?.hostId ?? LOCAL_HOST_ID) === worktreeCtx.hostId &&
    comparableProjectPath(selectedSession?.projectRoot ?? sessionCwd) ===
      comparableProjectPath(worktreeCtx.projectRoot) &&
    !worktreeCtx.worktrees.some((wt) => {
      const root = comparableProjectPath(wt.path);
      const cwd = comparableProjectPath(sessionCwd);
      return cwd === root || cwd.startsWith(`${root}/`);
    });
  // Host of what the user is looking at: the open session's, else the new
  // chat's, else the sidebar's selection. Undefined is this machine.
  const currentHostId = selectedSession
    ? remoteHostId(selectedSession.hostId)
    : newSessionCwd !== null
      ? newSessionHostId
      : activeHostId;
  const remoteHost = currentHostId !== undefined;
  const workspaceHostId = currentHostId ?? LOCAL_HOST_ID;
  const sidebarCwd =
    (activeHostId ?? LOCAL_HOST_ID) === workspaceHostId ? activeCwd : null;
  const explorerCwd = pendingWorkspace
    ? pendingWorkspace
    : selectedSession
      ? sessionWorktreeRemoved
        ? sidebarCwd
        : sessionCwd
      : (newSessionCwd ?? sidebarCwd);

  // File-panel integrations: every action works on the active tab so the right
  // panel behaves like an editor toolbar, not just a tab strip.
  const handleMentionActiveFile = useCallback(() => {
    if (
      !activeFileTab ||
      activeFileTab.sourceSessionId !== (selectedSession?.id ?? null)
    )
      return;
    if (activeFileTab.hostId !== workspaceHostId) {
      toast.info(t("hosts.fileOtherHost"));
      return;
    }
    handleAtMention(
      getRelativeFilePath(
        activeFileTab.filePath,
        activeFileTab.sourceCwd ?? undefined,
      ),
      false,
    );
  }, [activeFileTab, selectedSession?.id, handleAtMention, workspaceHostId, t]);

  const handleCopyActiveFilePath = useCallback(() => {
    if (!activeFileTab) return;
    const relative = getRelativeFilePath(
      activeFileTab.filePath,
      activeFileTab.sourceCwd ?? undefined,
    );
    copyText(relative).then(
      () => toast.success(t("appShell.copied")),
      () => toast.error(t("appShell.commandCopyFailed")),
    );
  }, [activeFileTab, t]);

  const handleDownloadActiveFile = useCallback(() => {
    if (!activeFileTab) return;
    const link = document.createElement("a");
    link.href = getFileApiUrl(
      activeFileTab.filePath,
      "download",
      activeFileTab.hostId,
      activeFileTab.sourceSessionId,
    );
    link.download = activeFileTab.label;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [activeFileTab]);
  const handleRevealActiveFile = useCallback(() => {
    if (!activeFileTab) return;
    if (activeFileTab.sourceSessionId !== (selectedSession?.id ?? null)) {
      toast.info(t("appShell.revealSourceSession"));
      return;
    }
    if (activeFileTab.hostId !== workspaceHostId) {
      toast.info(t("hosts.fileOtherHost"));
      return;
    }
    setRevealTarget({
      path: activeFileTab.filePath,
      hostId: activeFileTab.hostId,
    });
    setRightView("explorer");
    setRightPanelOpen(true);
  }, [activeFileTab, selectedSession?.id, workspaceHostId, t]);

  const handleSelectFileTab = useCallback((tabId: string) => {
    setActiveFileTabId(tabId);
    setRightView("file");
  }, []);
  // Stable selectors for the memoized RightPanel: inline arrows here would be
  // new identities every render and defeat the memo boundary.
  const handleSelectRightView = useCallback((view: RightPanelView) => {
    setRightView(view);
  }, []);

  const handleRevealDone = useCallback(() => {
    setRevealTarget((current) => (current === revealTarget ? null : current));
  }, [revealTarget]);

  const handleToggleFileSearch = useCallback(() => {
    setFileSearchOpen((open) => !open);
  }, []);

  const handleCloseOtherFileTabs = useCallback(() => {
    if (!activeFileTab) return;
    setFileTabs([activeFileTab]);
  }, [activeFileTab]);

  const handleCloseAllFileTabs = useCallback(() => {
    setFileTabs([]);
    setActiveFileTabId(null);
    setRightView("explorer");
  }, []);


  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const candidateCwd = newSessionCwd;
  const newSessionHost =
    newSessionCwd !== null ? newSessionHostId : activeHostId;
  const newSessionHostKey = newSessionHost ?? LOCAL_HOST_ID;
  const effectiveNewSessionCwd = workspaceOptions.projects.some(
    (workspace) =>
      (workspace.hostId ?? LOCAL_HOST_ID) === newSessionHostKey &&
      comparableProjectPath(workspace.path) ===
        comparableProjectPath(candidateCwd ?? ""),
  )
    ? candidateCwd
    : null;
  const terminalWorkspace = workspaceOptions.projects
    .filter((workspace) => {
      if (
        pendingWorkspace ||
        (workspace.hostId ?? LOCAL_HOST_ID) !== workspaceHostId ||
        !explorerCwd
      )
        return false;
      const root = comparableProjectPath(workspace.path);
      const path = comparableProjectPath(explorerCwd);
      return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
  const visibleShipKey = !settingsTab && terminalWorkspace
    ? hostProjectKey(workspaceHostId, terminalWorkspace.path)
    : null;
  const shipVisible = shipFlows.some((flow) => hostProjectKey(flow.host, flow.path) === visibleShipKey);
  const shipSelectionRef = useRef({ visibleShipKey, projects: workspaceOptions.projects, explorerCwd, workspaceHostId, settingsTab });
  shipSelectionRef.current = { visibleShipKey, projects: workspaceOptions.projects, explorerCwd, workspaceHostId, settingsTab };
  useEffect(() => {
    if (shipVisible && rightPanelIsModal) closeRightPanel();
  }, [shipVisible, rightPanelIsModal, closeRightPanel]);
  const newSessionGroupKey = newSessionHostKey;
  const hostProjects = workspaceOptions.projects.filter(
    (project) => (project.hostId ?? LOCAL_HOST_ID) === newSessionGroupKey,
  );
  const selectedNewWorkspace = hostProjects.find(
    (workspace) => workspace.path === effectiveNewSessionCwd,
  );
  const selectedNewProjectId = selectedNewWorkspace?.projectId ?? "";
  const newSessionProjects = hostProjects.filter(
    (workspace, index, all) =>
      all.findIndex(
        (candidate) => candidate.projectId === workspace.projectId,
      ) === index,
  );
  const projectWorkspaces = hostProjects.filter(
    (workspace) => workspace.projectId === selectedNewProjectId,
  );
  const newSessionWorkspaceValue = effectiveNewSessionCwd
    ? hostProjectKey(newSessionHost, effectiveNewSessionCwd)
    : "";
  const creationTargets = (hosts ?? []).map((host) => ({
    id: host.id,
    label: hostName(t, host),
  }));
  const chatHost = remoteHost
    ? hosts?.find((host) => host.id === currentHostId)
    : undefined;
  const settingsHostId = activeCwd ? activeHostId : currentHostId;
  const settingsTarget = activeCwd
    ? { hostId: activeHostId }
    : (selectedSession ??
      (newSessionCwd !== null ? { hostId: newSessionHostId } : null));
  const clusterSettings = isClusterTarget(
    settingsTarget,
    settingsHostId,
    pools,
  );
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const currentRate = generationSpeed?.current;
  const rate = currentRate ?? generationSpeed?.average;
  const speed = showChat ? formatGenerationSpeed(rate) : null;
  const hasGenerationSpeed = speed !== null;
  useLayoutEffect(() => {
    const header = topBarRef.current;
    const details = mobileToolsRef.current;
    const content = mobileToolsContentRef.current;
    const right = header?.querySelector<HTMLElement>(
      "[data-topbar-right-group]",
    );
    const tools = header?.querySelector<HTMLElement>(".shell-topbar-tools");
    if (!header || !details || !content || !right || !tools) return;
    const update = () => {
      const hadControlsFocus = content.contains(document.activeElement);
      // Measure the real controls even while their disclosure is closed.
      const closed = !details.open;
      const display = content.style.display;
      const visibility = content.style.visibility;
      content.style.visibility = "hidden";
      content.style.display = "flex";
      details.open = true;
      const children = Array.from(content.children).filter(
        (child) =>
          !["absolute", "fixed"].includes(getComputedStyle(child).position),
      );
      const contentStyle = getComputedStyle(content);
      const headerStyle = getComputedStyle(header);
      const controlsWidth =
        children.reduce((width, child) => {
          const style = getComputedStyle(child);
          return (
            width +
            child.getBoundingClientRect().width +
            parseFloat(style.marginLeft) +
            parseFloat(style.marginRight)
          );
        }, 0) +
        Math.max(0, children.length - 1) * parseFloat(contentStyle.columnGap);
      const leftNeed =
        controlsWidth +
        (tools.firstElementChild?.getBoundingClientRect().width ?? 0) +
        parseFloat(getComputedStyle(tools).columnGap) +
        parseFloat(headerStyle.paddingLeft);
      const rightNeed =
        parseFloat(headerStyle.paddingRight) + right.offsetWidth;
      const required = leftNeed + parseFloat(headerStyle.columnGap) + rightNeed;
      if (closed) details.open = false;
      content.style.display = display;
      content.style.visibility = visibility;
      // Title pill: same inset on both sides = widest real cluster (+8px gap), so it
      // is truly centered and never under a control. Expand the tools only if the
      // pill still keeps >= 200px (the container-query hide threshold) with them.
      header.style.setProperty(
        "--topbar-side",
        `${Math.ceil(Math.max(tools.offsetLeft + tools.offsetWidth, header.clientWidth - right.offsetLeft)) + 8}px`,
      );
      const titleFits =
        header.querySelector(".shell-topbar-center") === null ||
        2 * Math.max(leftNeed, rightNeed) + 216 <= header.clientWidth;
      const compact = required > header.clientWidth || !titleFits;
      if (compact && details.dataset.compact !== "true" && hadControlsFocus) {
        restoreToolsFocusRef.current = true;
      }
      setCompactTopbar(compact);
    };
    const observer = new ResizeObserver(update);
    observer.observe(header);
    observer.observe(right);
    observer.observe(tools);
    observer.observe(content);
    for (const child of content.children) observer.observe(child);
    document.fonts.addEventListener("loadingdone", update);
    update();
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", update);
    };
  }, [isMobile, locale, settingsTab, showChat]);
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const sidebarHistory = useSidebarHistory({
    active: isMobile && (showChat || Boolean(initialSessionId)),
    ready: mobileSidebarReady,
    sidebarOpen,
    setSidebarOpen,
    panelOpen: rightPanelIsModal,
    closePanel: closeRightPanel,
    url: searchParams.toString(),
  });
  useEffect(() => {
    if (sidebarHistory.exitNeedsNativeBack) {
      toast.info(
        t("appShell.exitNativeBackTitle"),
        t("appShell.exitNativeBackDescription"),
      );
    }
  }, [sidebarHistory.exitNeedsNativeBack, t]);

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - ${appName}` : appName;

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [windowTitle]);

  // The sidebar search drives the chat's find-in-page highlights.
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  // One jump per click: dropped once the chat used it, so reopening that session later starts at the bottom.
  const [searchMatchTarget, setSearchMatchTarget] =
    useState<SearchMatchTarget | null>(null);
  const clearSearchMatchTarget = useCallback(
    () => setSearchMatchTarget(null),
    [],
  );
  // The sidebar reports only changes: a pending target belongs to the query it was picked under.
  const handleSearchQueryChange = useCallback((query: string) => {
    setChatSearchQuery(query);
    setSearchMatchTarget(null);
  }, []);
  // A target still pending when another session opens must not jump when its own session reopens.
  useEffect(() => {
    setSearchMatchTarget((target) =>
      target && target.sessionId !== selectedSession?.id ? null : target,
    );
  }, [selectedSession?.id]);

  const sidebarContent = (
    <SessionSidebar
      selectedSessionId={selectedSession?.id ?? null}
      optimisticSession={selectedSession?.path === "" ? selectedSession : null}
      onSelectSession={handleSelectSession}
      onNewSession={handleNewSession}
      onNewWorkspace={handleNewWorkspace}
      onShip={openShip}
      initialSessionId={null}
      skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
      onInitialRestoreDone={handleInitialRestoreDone}
      refreshKey={refreshKey}
      onSessionDeleted={handleSessionDeleted}
      onWorkspaceRemoved={(path, host) => {
        const removed = chatTabsRef.current.filter((tab) =>
          tabInWorkspace(tab, path, host, workspaceOptions.projects),
        );
        updateChatTabs((tabs) => tabs.filter((tab) => !removed.includes(tab)));
        if (
          removed.some((tab) => tab.id === activeChatIdRef.current) ||
          (activeCwd === path &&
            (remoteHostId(activeHostId) ?? LOCAL_HOST_ID) === host)
        ) {
          setActiveCwd(null);
          setActiveHostId(undefined);
          activateChat(null);
          router.replace("/");
        }
      }}
      selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
      pendingWorkspace={Boolean(pendingWorkspace)}
      selectedHostId={
        selectedSession
          ? (selectedSession.hostId ?? LOCAL_HOST_ID)
          : (newSessionHostId ?? LOCAL_HOST_ID)
      }
      selectedLogicalProjectKey={null}
      onCwdChange={handleCwdChange}
      onWorkspaceOptionsChange={handleWorkspaceOptionsChange}
      onWorktreeContextChange={setWorktreeCtx}
      addProjectOpen={addProjectOpen}
      addProjectHostId={addProjectHostId}
      setAddProjectOpen={openAddProject}
      usageVisible={providerUsageVisible}
      activityTargetRef={isMobile ? undefined : setSidebarActivityContainer}
      settingsOpen={Boolean(settingsTab)}
      onOpenSettings={() => setSettingsTab((prev) => (prev ? null : "general"))}
      onOpenArchive={() => setArchiveBrowserOpen(true)}
      navigation={sidebarNavigation}
      onClose={isMobile ? () => setSidebarOpen(false) : undefined}
      onSearchQueryChange={handleSearchQueryChange}
      onOpenSearchMatch={setSearchMatchTarget}
    />
  );

  return (
    <>
      <ToastProvider>
        <ConfirmDialog
          open={sidebarHistory.exitConfirmationOpen}
          onOpenChange={(open) => {
            if (!open) sidebarHistory.cancelExit();
          }}
          title={t("appShell.exitTitle")}
          description={t("appShell.exitDescription")}
          confirmLabel={t("appShell.exitLeave")}
          cancelLabel={t("appShell.exitStay")}
          danger
          onConfirm={sidebarHistory.leave}
        />
        <ConfirmDialog
          open={pendingOpen !== null}
          onOpenChange={(open) => {
            if (!open) dismissPendingOpen();
          }}
          title={t(
            shownOpen?.kind === "file"
              ? "appShell.openFileTitle"
              : shownOpen?.crossSession
                ? "appShell.openUrlTitle"
                : "appShell.openUrlSameSessionTitle",
          )}
          description={t(
            shownOpen?.crossSession
              ? "appShell.openUrlDescription"
              : "appShell.openUrlSameSessionDescription",
            { url: shownOpen?.target ?? "" },
          )}
          confirmLabel={t("appShell.openUrlConfirm")}
          cancelLabel={t("appShell.openUrlCancel")}
          onConfirm={() => {
            if (pendingOpen?.kind === "url")
              window.open(pendingOpen.target, "_blank", "noopener,noreferrer");
            else if (pendingOpen) {
              // The file panel is hidden behind full-page Settings.
              setSettingsTab(null);
              handleOpenFile(
                pendingOpen.target,
                pendingOpen.name,
                pendingOpen.source,
              );
            }
            dismissPendingOpen();
          }}
        />
        <ConfirmDialog
          open={pendingSessionImport !== null}
          onOpenChange={(open) => {
            if (!open && !importingSession) setPendingSessionImport(null);
          }}
          title="Import session?"
          description={`This session is not registered. Import it into ${pendingSessionImport?.workspacePath ?? ""} to open it.`}
          confirmLabel="Import session"
          cancelLabel="Cancel"
          busy={importingSession}
          onConfirm={() => void importLinkedSession()}
        />
        <CommandPaletteMount
          onSelectSession={handleSelectSession}
          onNewSession={() => {
            if (activeCwd)
              handleNewSession(browserUUID(), activeCwd, activeHostId);
            else openAddProject(true, currentHostId ?? LOCAL_HOST_ID);
          }}
          currentModel={null}
        />
        <style>
          {`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: visible;
        transform-origin: top right;
        animation: session-info-pop var(--dur-slow) var(--ease-out-warm) both;
        will-change: transform, opacity;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash var(--dur-slow) var(--ease-out-warm) both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
        }
      }
    `}
        </style>
        <a href="#main-content" className="skip-link">
          {t("appShell.skipToContent")}
        </a>
        <div
          style={{
            display: "flex",
            height: "100%",
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            overflow: "hidden",
            background: "var(--bg)",
          }}
        >
          {/* Left sidebar: hidden on full-page Settings */}
          {!settingsTab && (
            <>
              <nav
                id="workspace-sidebar"
                role={isMobile ? "dialog" : undefined}
                aria-modal={isMobile ? true : undefined}
                tabIndex={-1}
                ref={sidebarContainerRef}
                className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizing ? " sidebar-resizing" : ""}`}
                aria-label={t("projects.heading")}
                aria-hidden={
                  mobileSidebarReady && (!sidebarOpen || rightPanelIsModal)
                    ? true
                    : undefined
                }
                inert={
                  mobileSidebarReady && (!sidebarOpen || rightPanelIsModal)
                    ? true
                    : undefined
                }
                style={{
                  background: "var(--bg-panel)",
                  borderRight: isMobile ? "none" : "1px solid var(--border)",
                  display: "flex",
                  flexDirection: "column",
                  flexShrink: 0,
                  zIndex: 200,
                  // Desktop-only: the width is user-adjustable via the resize handle.
                  ...(!isMobile
                    ? { "--sidebar-width": `${sidebarWidth}px` }
                    : {}),
                }}
              >
                {sidebarContent}
              </nav>

              {/* Resize handle — desktop only, hidden while the sidebar is closed */}
              {!isMobile && sidebarOpen && (
                <div
                  className="sidebar-resize-handle"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("appShell.resizeSidebar")}
                  tabIndex={0}
                  onMouseDown={handleSidebarResizeStart}
                  onDoubleClick={resetSidebarWidth}
                  onKeyDown={handleSidebarResizeKey}
                  title={t("appShell.resizeSidebarTitle")}
                  style={{
                    width: 5,
                    flexShrink: 0,
                    marginLeft: -5,
                    cursor: "col-resize",
                    background: "transparent",
                    zIndex: 205,
                    outline: "none",
                    transition:
                      "background var(--dur-fast) var(--ease-out-warm)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background =
                      "color-mix(in srgb, var(--accent) 35%, transparent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.background =
                      "color-mix(in srgb, var(--accent) 35%, transparent)";
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                />
              )}
            </>
          )}

          {/* Center: chat */}
          <main
            id="main-content"
            tabIndex={-1}
            inert={rightPanelIsModal ? true : undefined}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            <WorkspaceTerminalTabs
              contentInert={shipVisible}
              hostId={workspaceHostId}
              cwd={terminalWorkspace?.path ?? null}
              activeId={activeTerminalId}
              onSelect={setActiveTerminalId}
              enabled={!settingsTab}
              mobile={isMobile}
              headerTarget={workspaceSwitcherTarget}
              onSelectSaved={handleSelectSession}
              onGenerateTitle={() => void handleAutoName()}
              openSessionIds={[
                ...new Set([
                  ...openSessionIds,
                  ...chatTabs.flatMap((tab) =>
                    tab.session ? [tab.session.id] : [],
                  ),
                ]),
              ]}
              onRename={handleRenameSession}
              activeSessionName={selectedSession?.name ?? ""}
              canRename={Boolean(selectedSession)}
              canGenerateTitle={Boolean(
                selectedSession &&
                (sessionStats?.userMessages ?? selectedSession.messageCount) >
                  0 &&
                autoNameStatus.kind !== "naming",
              )}
              chatTabs={[
                ...chatTabs,
                ...sharedSessions
                  .filter(
                    (session) =>
                      openSessionIds.includes(session.id) &&
                      !hiddenSharedIds.has(session.id) &&
                      !chatTabs.some((tab) => tab.session?.id === session.id),
                  )
                  .map((session): ChatTab => ({
                    id: `shared:${session.id}`,
                    cwd: session.cwd,
                    hostId: remoteHostId(session.hostId),
                    session,
                    creation: {},
                  })),
              ]
                .filter(
                  (tab) =>
                    terminalWorkspace &&
                    tabInWorkspace(
                      tab,
                      terminalWorkspace.path,
                      workspaceHostId,
                      workspaceOptions.projects,
                    ),
                )
                .map((tab, index, tabs) => ({
                  id: tab.id,
                  sessionId: tab.session?.id,
                  title:
                    tab.session?.name ||
                    (tab.session?.messageCount ? temporarySessionTitle(tab.session.firstMessage) : null) ||
                    (tabs.filter((item) => !item.session).length > 1
                      ? `New chat ${tabs.slice(0, index + 1).filter((item) => !item.session).length}`
                      : "New chat"),
                }))}
              activeChatId={activeChatId}
              onSelectChat={(id) => {
                const tab = chatTabsRef.current.find((item) => item.id === id);
                if (!tab && id.startsWith("shared:")) {
                  const session = sharedSessions.find(
                    (item) => item.id === id.slice(7),
                  );
                  if (session) handleSelectSession(session);
                  return;
                }
                if (!tab) return;
                activateChat(tab);
                router.replace(
                  tab.session
                    ? `?session=${encodeURIComponent(tab.session.id)}`
                    : "/",
                );
              }}
              onCloseChat={async (id) => {
                const closing = chatTabsRef.current.find(
                  (tab) => tab.id === id,
                );
                if (!closing && id.startsWith("shared:")) {
                  setHiddenSharedIds((hidden) =>
                    new Set(hidden).add(id.slice(7)),
                  );
                  return;
                }
                if (!closing) return;
                if (closing.session) {
                  setHiddenSharedIds((hidden) =>
                    new Set(hidden).add(closing.session!.id),
                  );
                }
                const visible = chatTabsRef.current.filter(
                  (tab) =>
                    terminalWorkspace &&
                    tabInWorkspace(
                      tab,
                      terminalWorkspace.path,
                      workspaceHostId,
                      workspaceOptions.projects,
                    ),
                );
                const index = visible.findIndex((tab) => tab.id === id);
                updateChatTabs((tabs) => tabs.filter((tab) => tab.id !== id));
                if (
                  activeChatIdRef.current === id ||
                  (closing.session &&
                    activeSessionIdRef.current === closing.session.id)
                ) {
                  const next = visible[index + 1] ?? visible[index - 1] ?? null;
                  if (!next && terminalWorkspace) {
                    try {
                      sessionStorage.setItem(
                        `${CHAT_TABS_STORAGE_KEY}:active:${remoteHostId(workspaceHostId) ?? LOCAL_HOST_ID}:${terminalWorkspace.path}`,
                        "",
                      );
                    } catch {
                      /* Storage may be unavailable. */
                    }
                  }
                  activateChat(next);
                  router.replace(
                    next?.session
                      ? `?session=${encodeURIComponent(next.session.id)}`
                      : "/",
                  );
                }
              }}
              onNewChat={() =>
                handleNewSession(
                  browserUUID(),
                  terminalWorkspace?.path ?? null,
                  workspaceHostId,
                  undefined,
                  undefined,
                  false,
                  true,
                )
              }
            />
            <div style={{ flex: !settingsTab && activeTerminalId?.startsWith("browser:") ? "0 0 auto" : 1, minHeight: 0, minWidth: 0, position: "relative", display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {settingsTab ? (
              <SettingsConfig
                activeTab={settingsTab}
                toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
                onToolCallsDefaultCollapsedChange={
                  handleToolCallsDefaultCollapsedChange
                }
                hideToolActivity={hideToolActivity}
                onHideToolActivityChange={handleHideToolActivityChange}
                neverFoldActivity={neverFoldActivity}
                onNeverFoldActivityChange={handleNeverFoldActivityChange}
                showToolCallsUnfolded={showToolCallsUnfolded}
                onShowToolCallsUnfoldedChange={
                  handleShowToolCallsUnfoldedChange
                }
                expandThinkingByDefault={expandThinkingByDefault}
                onExpandThinkingByDefaultChange={
                  handleExpandThinkingByDefaultChange
                }
                onHideThinkingBlockChange={setHideThinkingBlock}
                providerUsageVisible={providerUsageVisible}
                onProviderUsageVisibleChange={handleProviderUsageVisibleChange}
                scopeNativeSelectAll={scopeNativeSelectAll}
                onScopeNativeSelectAllChange={handleScopeNativeSelectAllChange}
                openUrlAutomatically={openUrlAutomatically}
                onOpenUrlAutomaticallyChange={handleOpenUrlAutomaticallyChange}
                cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd}
                remoteHost={settingsHostId !== undefined}
                cluster={clusterSettings}
                sessionId={selectedSession?.id ?? null}
                onModelsSaved={() => setModelsRefreshKey((k) => k + 1)}
                onPluginsReloaded={() => setSessionKey((k) => k + 1)}
                onSelectTab={setSettingsTab}
                onClose={() => setSettingsTab(null)}
              />
            ) : (
              <>
                {/* Top bar: 3-zone segmented control bar */}
                <div
                  ref={topBarRef}
                  className="shell-topbar"
                  style={{
                    position: "relative",
                    alignItems: "center",
                    flexShrink: 0,
                    borderBottom: "1px solid var(--border)",
                    minHeight: "var(--shell-topbar-height)",
                    background: "var(--bg-panel)",
                    padding: isMobile
                      ? "var(--shell-topbar-inset) max(4px, env(safe-area-inset-right, 0px)) 0 max(4px, env(safe-area-inset-left, 0px))"
                      : "0 8px",
                    gap: "0 8px",
                    minWidth: 0,
                  }}
                >
                  {/* Left Zone: Utility group (sidebar, theme, language) & session controls (history, branches, system) */}
                  <div
                    className="shell-topbar-tools"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      height: isMobile ? 43 : 35,
                      minWidth: 0,
                      flexShrink: 0,
                    }}
                  >
                    <button
                      onClick={handleSidebarToggle}
                      aria-expanded={sidebarOpen}
                      aria-controls="workspace-sidebar"
                      title={
                        sidebarOpen
                          ? t("appShell.hideSidebar")
                          : t("appShell.showSidebar")
                      }
                      aria-label={
                        sidebarOpen
                          ? t("appShell.hideSidebar")
                          : t("appShell.showSidebar")
                      }
                      className="shell-toolbar-btn ui-focus-ring"
                    >
                      <Menu size={16} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                    <details
                      ref={mobileToolsRef}
                      className="shell-topbar-overflow"
                      data-compact={
                        isMobile
                          ? "true"
                          : compactTopbar === null
                            ? "pending"
                            : compactTopbar
                      }
                      open={
                        isMobile ? undefined : compactTopbar ? undefined : true
                      }
                      onToggle={(event) => {
                        if (!event.currentTarget.open) setActiveTopPanel(null);
                      }}
                    >
                      <summary
                        className="shell-toolbar-btn ui-focus-ring"
                        title={t("chatInput.moreControls")}
                        aria-label={t("chatInput.moreControls")}
                      >
                        <Ellipsis
                          size={16}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      </summary>
                      <div
                        ref={mobileToolsContentRef}
                        className="shell-topbar-overflow-content"
                      >
                        <ThemeSwitcher />
                        <button
                          type="button"
                          onClick={() => {
                            if (isMobile && mobileToolsRef.current) {
                              mobileToolsRef.current.open = false;
                              setActiveTopPanel(null);
                            }
                            window.dispatchEvent(
                              new Event("omp:open-command-palette"),
                            );
                          }}
                          title={`${t("commandPalette.label")} (Ctrl/⌘ K)`}
                          aria-label={t("commandPalette.label")}
                          aria-keyshortcuts="Control+K Meta+K"
                          className="shell-toolbar-btn ui-focus-ring"
                        >
                          <Command
                            size={16}
                            strokeWidth={1.8}
                            aria-hidden="true"
                          />
                        </button>
                        {showChat && (
                          <>
                            <div
                              className="shell-toolbar-divider"
                              aria-hidden="true"
                            />
                            <BranchNavigator
                              tree={branchTree}
                              activeLeafId={branchActiveLeafId}
                              onLeafChange={handleBranchLeafChange}
                              inline
                              containerRef={
                                compactTopbar
                                  ? mobileToolsContentRef
                                  : topBarRef
                              }
                              open={activeTopPanel === "branches"}
                              onToggle={() => toggleTopPanel("branches")}
                              hasSession
                            />
                          </>
                        )}
                      </div>
                    </details>
                  </div>
                  {isMobile && (
                    <div
                      ref={setWorkspaceSwitcherTarget}
                      className="workspace-switcher-header"
                    />
                  )}

                  {/* Center Zone: Workspace & Session Breadcrumb + Auto-name action */}
                  {!isMobile &&
                    showChat &&
                    (() => {
                      const effectiveProject =
                        selectedSession?.projectRoot ??
                        selectedSession?.cwd ??
                        activeCwd ??
                        "";
                      const sessionTitle =
                        selectedSession?.name ||
                        (selectedSession?.messageCount ? temporarySessionTitle(selectedSession.firstMessage) : null) ||
                        t("appShell.newSession");
                      const hasMessages = Boolean(
                        selectedSession &&
                        (sessionStats?.userMessages ??
                          selectedSession.messageCount) > 0,
                      );
                      const wandDisabled =
                        !selectedSession ||
                        !hasMessages ||
                        autoNameStatus.kind === "naming";
                      const wandIsSuccess = autoNameStatus.kind === "success";
                      const wandIsError = autoNameStatus.kind === "error";
                      const wandLabel =
                        autoNameStatus.kind === "naming"
                          ? t("appShell.generating")
                          : wandIsSuccess
                            ? t("appShell.titleUpdated")
                            : wandIsError
                              ? t("appShell.generationFailed")
                              : t("appShell.generateTitle");
                      const wandTooltip = !selectedSession
                        ? t("appShell.titleGenUnavailable")
                        : !hasMessages
                          ? t("appShell.titleGenNeedsMessage")
                          : wandIsError
                            ? autoNameStatus.message
                            : t("appShell.generateSessionTitle");

                      return (
                        <div
                          className="shell-topbar-center"
                          style={{
                            minWidth: 0,
                            containerType: "inline-size",
                            containerName: "breadcrumb",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <div
                            className="shell-topbar-breadcrumb"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                              height: 26,
                              padding: "0 8px",
                              borderRadius: "var(--radius-control)",
                              background: "var(--bg-subtle)",
                              border: "1px solid var(--border)",
                              fontSize: 11,
                              color: "var(--text-muted)",
                              whiteSpace: "nowrap",
                              minWidth: 0,
                              width: "fit-content",
                              justifyContent: "center",
                              flexShrink: 1,
                            }}
                          >
                            {effectiveProject ? (
                              <span
                                className="shell-topbar-project-context"
                                style={{ display: "contents" }}
                              >
                                <Folder
                                  size={12}
                                  strokeWidth={1.8}
                                  style={{ opacity: 0.6, flexShrink: 0 }}
                                  aria-hidden="true"
                                />
                                <span
                                  style={{
                                    fontWeight: 600,
                                    color: "var(--text)",
                                    flexShrink: 0,
                                    maxWidth: 120,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={effectiveProject}
                                >
                                  {projectLabel(effectiveProject)}
                                </span>
                                <span
                                  style={{
                                    color: "var(--text-dim)",
                                    flexShrink: 0,
                                    opacity: 0.5,
                                  }}
                                >
                                  /
                                </span>
                              </span>
                            ) : null}
                            <span
                              style={{
                                color: "var(--text)",
                                fontWeight: 500,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                minWidth: 0,
                              }}
                              title={sessionTitle}
                            >
                              {sessionTitle}
                            </span>
                            {selectedSession && (
                              <button
                                type="button"
                                onClick={() => void handleAutoName()}
                                disabled={wandDisabled}
                                title={wandTooltip}
                                aria-label={wandLabel}
                                className="ui-focus-ring"
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  width: 18,
                                  height: 18,
                                  padding: 0,
                                  marginLeft: 2,
                                  border: "none",
                                  borderRadius: 4,
                                  background: "transparent",
                                  color: wandIsSuccess
                                    ? "var(--accent)"
                                    : wandIsError
                                      ? "var(--status-error)"
                                      : "var(--text-dim)",
                                  cursor: wandDisabled ? "default" : "pointer",
                                  flexShrink: 0,
                                  opacity:
                                    autoNameStatus.kind === "naming"
                                      ? 1
                                      : wandDisabled
                                        ? 0.35
                                        : 0.75,
                                  transition:
                                    "color var(--dur-fast), opacity var(--dur-fast)",
                                }}
                              >
                                {autoNameStatus.kind === "naming" ? (
                                  <svg
                                    className="animate-spin"
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    aria-hidden="true"
                                  >
                                    <circle
                                      cx="12"
                                      cy="12"
                                      r="9"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      opacity="0.25"
                                    />
                                    <path
                                      d="M21 12a9 9 0 0 0-9-9"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                ) : wandIsSuccess ? (
                                  <Check
                                    size={12}
                                    strokeWidth={2}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Wand2
                                    size={12}
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                  />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                  {/* Right zone: speed, mobile session information, and the file-panel opener. */}
                  <div
                    data-topbar-right-group
                    style={{
                      marginLeft: "auto",
                      display: "flex",
                      alignItems: "center",
                      gap: isMobile ? 2 : 6,
                      height: isMobile
                        ? 43
                        : "calc(var(--shell-topbar-height) - 1px)",
                      flexShrink: 1,
                      minWidth: 0,
                    }}
                  >
                    {hasGenerationSpeed && (
                      <div
                        className="shell-topbar-metrics"
                        style={{
                          flex: "0 1 calc(10ch + 33px)",
                          minWidth: 0,
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          containerType: "inline-size",
                          containerName: "topbar-speed",
                        }}
                      >
                        {/* Generation speed pill */}
                        {showChat &&
                          (() => {
                            if (!speed || rate == null) return null;
                            const isLive = currentRate != null;
                            const speedTitle = t(
                              isLive
                                ? "appShell.tooltipCurrentSpeed"
                                : "appShell.tooltipAverageSpeed",
                              {
                                value: `${rate.toFixed(1)} t/s`,
                              },
                            );

                            return (
                              <div
                                title={speedTitle}
                                role="img"
                                aria-label={speedTitle}
                                className="shell-metric-pill shell-pill-extra"
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                  height: 26,
                                  padding: "0 8px",
                                  borderRadius: "var(--radius-control)",
                                  border: "1px solid var(--border)",
                                  background: "var(--bg-subtle)",
                                  color: isLive
                                    ? "var(--accent)"
                                    : "var(--text-muted)",
                                  fontSize: 11,
                                  fontFamily: "var(--font-mono)",
                                  fontVariantNumeric: "tabular-nums",
                                  whiteSpace: "nowrap",
                                  cursor: "default",
                                  width: "calc(10ch + 33px)",
                                  flexShrink: 0,
                                }}
                              >
                                {isLive ? (
                                  <Zap
                                    size={11}
                                    strokeWidth={2}
                                    aria-hidden="true"
                                    style={{
                                      flexShrink: 0,
                                      color: "var(--accent)",
                                    }}
                                  />
                                ) : (
                                  <span
                                    aria-hidden="true"
                                    style={{
                                      width: 11,
                                      lineHeight: "11px",
                                      textAlign: "center",
                                      flexShrink: 0,
                                      color: "var(--text-dim)",
                                    }}
                                  >
                                    ~
                                  </span>
                                )}
                                <span
                                  style={{
                                    display: "inline-flex",
                                    gap: "1ch",
                                    fontWeight: isLive ? 600 : 400,
                                  }}
                                >
                                  <span
                                    style={{ width: "5ch", textAlign: "right" }}
                                  >
                                    {speed.value}
                                  </span>
                                  <span style={{ width: "4ch" }}>
                                    {speed.unit}
                                  </span>
                                </span>
                              </div>
                            );
                          })()}
                      </div>
                    )}
                    {isMobile && showChat && (
                      <div
                        ref={setSessionInfoContainer}
                        className="shell-session-info"
                        style={{
                          display: "flex",
                          height: 44,
                          flexShrink: 0,
                          alignSelf: "flex-start",
                        }}
                      />
                    )}
                    <div
                      ref={setShipButtonContainer}
                      style={{ flexShrink: 0 }}
                    />
                    {!isMobile && (
                      <NotificationBell
                        open={notificationsOpen}
                        onOpenChange={setNotificationsOpen}
                      />
                    )}
                    <button
                      type="button"
                      className="shell-toolbar-btn shell-panel-opener ui-focus-ring"
                      onClick={() => {
                        // Unread notifications turn the panel toggle into their shortcut.
                        if (opensNotifications) {
                          setRightView("notifications");
                          setRightPanelOpen(true);
                        } else {
                          setRightPanelOpen((open) => !open);
                        }
                      }}
                      aria-expanded={rightPanelOpen}
                      aria-controls="workspace-file-panel"
                      aria-pressed={rightPanelOpen}
                      title={panelOpenerLabel}
                      aria-label={panelOpenerLabel}
                    >
                      <PanelRight
                        size={16}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                      {isMobile && unreadNotifications > 0 && (
                        <span aria-hidden="true" className="panel-opener-badge">
                          {unreadNotifications > 99
                            ? "99+"
                            : unreadNotifications}
                        </span>
                      )}
                    </button>
                  </div>
                </div>

                {/* Chat content */}
                <div
                  inert={shipVisible ? true : undefined}
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    position: "relative",
                    display: activeTerminalId ? "none" : undefined,
                  }}
                >
                  {showChat ? (
                    <ChatWindow
                      key={sessionKey}
                      session={selectedSession}
                      shipButtonContainer={
                        activeTerminalId ? null : shipButtonContainer
                      }
                      shipWorkspace={(() => {
                        if (!selectedSession) return undefined;
                        const host = selectedSession.hostId ?? LOCAL_HOST_ID;
                        const cwd = comparableProjectPath(selectedSession.cwd);
                        const workspace = workspaceOptions.projects
                          .filter(
                            (item) =>
                              (item.hostId ?? LOCAL_HOST_ID) === host &&
                              (cwd === comparableProjectPath(item.path) ||
                                cwd.startsWith(
                                  `${comparableProjectPath(item.path)}/`,
                                )),
                          )
                          .sort((a, b) => b.path.length - a.path.length)[0];
                        if (
                          !workspace ||
                          workspace.projectKind !== "git" ||
                          workspace.isDefaultWorkspace ||
                          !workspace.projectPath
                        )
                          return undefined;
                        return {
                          host,
                          projectPath: workspace.projectPath,
                          path: workspace.path,
                          sessionId: selectedSession.id,
                        };
                      })()}
                      onShip={openShip}
                      activityContainer={activityContainer}
                      sidebarActivityContainer={
                        isMobile ? null : sidebarActivityContainer
                      }
                      newSessionCwd={effectiveNewSessionCwd}
                      newSessionHostId={newSessionHost}
                      prepareNewWorkspace={prepareNewWorkspace}
                      workspaceSourceRequired={
                        !!workspaceDraft &&
                        !workspaceDraft.workspaceJob &&
                        !workspaceBaseRef
                      }
                      newSessionCreationId={undefined}
                      newSessionDraftKey={
                        activeChatId ? `new:tab:${activeChatId}` : undefined
                      }
                      newSessionInitialization={
                        newSessionCreation.initialization
                      }
                      onNewSessionInitialization={
                        handleNewSessionInitialization
                      }
                      hostStatus={chatHost?.status}
                      hostLabel={chatHost ? hostName(t, chatHost) : undefined}
                      newSessionWorkspace={
                        pendingWorkspace ? (
                          <div
                            className="new-session-workspace"
                            title={pendingWorkspace}
                            style={{
                              color: "var(--text-muted)",
                              overflowWrap: "anywhere",
                            }}
                          >
                            New workspace in{" "}
                            {hostProjects.find(
                              (project) =>
                                (project.projectPath ?? project.path) ===
                                pendingWorkspace,
                            )?.projectName ?? projectLabel(pendingWorkspace)}
                            {sourceTabId && (
                              <WorkspaceSourcePicker
                                key={sourceTabId}
                                branches={workspaceSources?.branches}
                                error={workspaceSources?.error}
                                selection={workspaceDraft?.workspaceSource}
                                onChange={(workspaceSource) =>
                                  updateChatTabs((tabs) =>
                                    tabs.map((tab) =>
                                      tab.id === sourceTabId
                                        ? { ...tab, workspaceSource }
                                        : tab,
                                    ),
                                  )
                                }
                              />
                            )}
                          </div>
                        ) : !chatTabs.find((tab) => tab.id === activeChatId)?.workspaceFixed && (
                          effectiveNewSessionCwd && (
                            <div className="new-session-workspace">
                              {creationTargets.length > 1 && (
                                <>
                                  <label
                                    htmlFor="new-session-host"
                                    className="new-session-workspace-label"
                                  >
                                    {t("hosts.pickerLabel")}
                                  </label>
                                  <div className="new-session-workspace-control">
                                    <span
                                      className="new-session-workspace-icon"
                                      aria-hidden="true"
                                    >
                                      <Server size={17} strokeWidth={1.8} />
                                    </span>
                                    <ThemedSelect
                                      className="workspace-select-trigger"
                                      id="new-session-host"
                                      value={newSessionGroupKey}
                                      onChange={(key) => {
                                        const first =
                                          workspaceOptions.projects.find(
                                            (project) =>
                                              (project.hostId ??
                                                LOCAL_HOST_ID) === key,
                                          );
                                        if (
                                          !first ||
                                          key === newSessionGroupKey
                                        )
                                          return;
                                        setActiveCwd(first.path);
                                        setActiveHostId(
                                          remoteHostId(first.hostId),
                                        );
                                        handleNewSession(
                                          browserUUID(),
                                          first.path,
                                          first.hostId,
                                          first,
                                        );
                                      }}
                                      options={creationTargets.map(
                                        (target) => ({
                                          value: target.id,
                                          label: target.label,
                                          disabled:
                                            !workspaceOptions.projects.some(
                                              (project) =>
                                                (project.hostId ??
                                                  LOCAL_HOST_ID) === target.id,
                                            ),
                                        }),
                                      )}
                                    />
                                    <ChevronDown
                                      className="new-session-workspace-chevron"
                                      size={16}
                                      strokeWidth={1.8}
                                      aria-hidden="true"
                                    />
                                  </div>
                                </>
                              )}
                              <div className="new-session-workspace-fields">
                                <div className="new-session-workspace-field">
                                  <label
                                    htmlFor="new-session-project"
                                    className="new-session-workspace-label"
                                  >
                                    Project
                                  </label>
                                  <div className="new-session-workspace-control">
                                    <span
                                      className="new-session-workspace-icon"
                                      aria-hidden="true"
                                    >
                                      <Folder size={17} strokeWidth={1.8} />
                                    </span>
                                    <ThemedSelect
                                      className="workspace-select-trigger"
                                      id="new-session-project"
                                      value={selectedNewProjectId}
                                      onChange={(key) => {
                                        if (!key) {
                                          openAddProject(
                                            true,
                                            newSessionGroupKey,
                                          );
                                          return;
                                        }
                                        const workspace =
                                          hostProjects.find(
                                            (candidate) =>
                                              candidate.projectId === key &&
                                              candidate.isDefaultWorkspace,
                                          ) ??
                                          hostProjects.find(
                                            (candidate) =>
                                              candidate.projectId === key,
                                          );
                                        if (!workspace) return;
                                        setActiveCwd(workspace.path);
                                        setActiveHostId(
                                          remoteHostId(workspace.hostId),
                                        );
                                        handleNewSession(
                                          browserUUID(),
                                          workspace.path,
                                          workspace.hostId,
                                          workspace,
                                        );
                                      }}
                                      options={[
                                        ...newSessionProjects.map((project) => {
                                          const label =
                                            project.projectName ??
                                            projectLabel(
                                              project.projectPath ??
                                                project.path,
                                            );
                                          // Native option values fall back to their text when value is undefined.
                                          return {
                                            value: project.projectId ?? label,
                                            label,
                                          };
                                        }),
                                        {
                                          value: "",
                                          label: t("projects.add"),
                                          action: true,
                                        },
                                      ]}
                                    />
                                    <ChevronDown
                                      className="new-session-workspace-chevron"
                                      size={16}
                                      strokeWidth={1.8}
                                      aria-hidden="true"
                                    />
                                  </div>
                                </div>
                                <div className="new-session-workspace-field">
                                  <label
                                    id="new-session-workspace-label"
                                    htmlFor="new-session-workspace"
                                    className="new-session-workspace-label"
                                  >
                                    {t("settingsConfig.chipWorkspace")}
                                  </label>
                                  <div className="new-session-workspace-control">
                                    <span
                                      className="new-session-workspace-icon"
                                      aria-hidden="true"
                                    >
                                      <Folder size={17} strokeWidth={1.8} />
                                    </span>
                                    <ThemedSelect
                                      className="workspace-select-trigger"
                                      id="new-session-workspace"
                                      aria-describedby="new-session-workspace-path"
                                      value={newSessionWorkspaceValue}
                                      onChange={(key) => {
                                        if (key === "__add_workspace__") {
                                          if (selectedNewWorkspace)
                                            handleNewWorkspace(
                                              selectedNewWorkspace,
                                            );
                                          return;
                                        }
                                        const project = projectWorkspaces.find(
                                          (candidate) =>
                                            hostProjectKey(
                                              candidate.hostId,
                                              candidate.path,
                                            ) === key,
                                        );
                                        if (!project) return;
                                        setActiveCwd(project.path);
                                        setActiveHostId(
                                          remoteHostId(project.hostId),
                                        );
                                        handleNewSession(
                                          browserUUID(),
                                          project.path,
                                          project.hostId,
                                          project,
                                        );
                                      }}
                                      options={[
                                        // Keylime creates a workspace for the selected project rather than an upstream worktree selection.
                                        ...projectWorkspaces.map((project) => ({
                                          value: hostProjectKey(
                                            project.hostId,
                                            project.path,
                                          ),
                                          label:
                                            project.alias ??
                                            project.name ??
                                            projectLabel(project.path),
                                        })),
                                        ...(selectedNewWorkspace?.projectKind ===
                                        "git"
                                          ? [
                                              {
                                                value: "__add_workspace__",
                                                label: "Add workspace",
                                                action: true,
                                              },
                                            ]
                                          : []),
                                      ]}
                                    />
                                    <ChevronDown
                                      className="new-session-workspace-chevron"
                                      size={16}
                                      strokeWidth={1.8}
                                      aria-hidden="true"
                                    />
                                  </div>
                                </div>
                              </div>
                              <div
                                id="new-session-workspace-path"
                                className="new-session-workspace-path"
                                title={effectiveNewSessionCwd ?? undefined}
                              >
                                {effectiveNewSessionCwd}
                              </div>
                            </div>
                          )
                        )
                      }
                      onAgentEnd={handleAgentEnd}
                      onSessionCreated={(session) =>
                        handleSessionCreated(activeChatId, session)
                      }
                      onBackgroundSessionCreated={(session) =>
                        handleSessionCreated(activeChatId, session)
                      }
                      onSessionForked={handleSessionForked}
                      onSessionMoved={handleSessionMoved}
                      modelsRefreshKey={modelsRefreshKey}
                      chatInputRef={chatInputRef}
                      onOpenFile={handleOpenFile}
                      onOpenUrl={handleSessionOpenUrl}
                      onBranchDataChange={handleBranchDataChange}
                      onSessionStatsChange={handleSessionStatsChange}
                      onSessionStatsPanelOpen={openSessionStatsPanel}
                      sessionInfoContainer={sessionInfoContainer}
                      onGenerationSpeedChange={handleGenerationSpeedChange}
                      toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
                      hideToolActivity={hideToolActivity}
                      neverFoldActivity={neverFoldActivity}
                      showToolCallsUnfolded={showToolCallsUnfolded}
                      expandThinkingByDefault={expandThinkingByDefault}
                      hideThinkingBlock={hideThinkingBlock}
                      searchQuery={chatSearchQuery}
                      searchTarget={
                        searchMatchTarget &&
                        searchMatchTarget.sessionId === selectedSession?.id
                          ? searchMatchTarget
                          : null
                      }
                      onSearchTargetHandled={clearSearchMatchTarget}
                    />
                  ) : initialCwdStatus === "validating" ? (
                    <WorkspaceState
                      kind="loading"
                      title={t("appShell.openingWorkspace")}
                      detail={
                        <span className="workspace-state-path">
                          {initialNavigation.requestedCwd}
                        </span>
                      }
                    />
                  ) : initialCwdStatus === "error" ? (
                    <WorkspaceState
                      kind="error"
                      title={t("appShell.unableToOpenWorkspace")}
                      detail={
                        <>
                          <span className="workspace-state-path">
                            {initialNavigation.requestedCwd}
                          </span>
                          <span>{initialCwdError}</span>
                        </>
                      }
                    />
                  ) : !showPlaceholder ? (
                    <PanelLoadingFallback />
                  ) : activeCwd ? (
                    <WorkspaceState
                      kind="empty"
                      title={t("appShell.selectSessionHint")}
                    />
                  ) : (
                    <div
                      style={{
                        position: "absolute",
                        top: 12,
                        left: 12,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        userSelect: "none",
                      }}
                    >
                      <svg
                        width="44"
                        height="44"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ opacity: 0.7, flexShrink: 0 }}
                      >
                        <line x1="20" y1="12" x2="4" y2="12" />
                        <polyline points="10 6 4 12 10 18" />
                      </svg>
                      <div>
                        <div
                          className="display-heading"
                          style={{
                            fontSize: 20,
                            color: "var(--text)",
                            marginBottom: 8,
                          }}
                        >
                          {t("appShell.getStarted")}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--text-muted)",
                            lineHeight: 1.8,
                          }}
                        >
                          <span
                            style={{ color: "var(--text-dim)", marginRight: 6 }}
                          >
                            1.
                          </span>
                          {t("appShell.getStartedStep1")}
                          <br />
                          <span
                            style={{ color: "var(--text-dim)", marginRight: 6 }}
                          >
                            2.
                          </span>
                          {(() => {
                            // One translatable sentence; the {models} slot is rendered
                            // as the emphasized button name so word order stays free.
                            const [before, after] = t(
                              "appShell.getStartedStep2",
                            ).split("{models}");
                            return (
                              <>
                                {before}
                                <strong style={{ color: "var(--text)" }}>
                                  {t("appShell.models")}
                                </strong>
                                {after}
                              </>
                            );
                          })()}
                          <button
                            type="button"
                            onClick={() => {
                              setSidebarOpen(true);
                              openAddProject(true);
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              width: "fit-content",
                              minHeight: 36,
                              marginTop: 12,
                              padding: "7px 10px",
                              border: "1px solid var(--border)",
                              borderRadius: "var(--radius-control)",
                              background: "var(--bg-panel)",
                              color: "var(--text)",
                              cursor: "pointer",
                              fontSize: 12,
                              fontWeight: 600,
                              boxShadow: "var(--shadow-card)",
                            }}
                            className="ui-focus-ring"
                          >
                            <Folder
                              size={14}
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                            {t("appShell.openWorkspaces")}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
            </div>
            <div style={{ position: "absolute", inset: "var(--shell-topbar-height) 0 0", pointerEvents: shipVisible ? "auto" : "none" }}>
            {shipFlows.map((target) => {
              const key = hostProjectKey(target.host, target.path);
              return <ShipDialog
                key={key}
                open
                visible={key === visibleShipKey}
                onOpenChange={(open) => {
                  if (!open) setShipFlows((flows) => flows.filter((flow) => hostProjectKey(flow.host, flow.path) !== key));
                }}
                {...target}
                onAskAgentToResolve={async (message) => {
                  let advisor = false;
                  try {
                    advisor = localStorage.getItem(`omp-advisor-enabled:${target.sessionId}`) === "true";
                  } catch {
                    // Storage can be unavailable; match the normal session default.
                  }
                  await addToOutbox({ id: newOutboxId(), sessionId: target.sessionId, scope: await getOutboxScope(target.sessionId), advisor, mode: "prompt", message, createdAt: Date.now() });
                }}
                onRemoved={() => {
                  const selection = shipSelectionRef.current;
                  updateChatTabs((tabs) => tabs.filter((tab) => !tabInWorkspace(tab, target.path, target.host, selection.projects)));
                  setRefreshKey((value) => value + 1);
                  const selectedPath = comparableProjectPath(selection.explorerCwd ?? "");
                  const removedPath = comparableProjectPath(target.path);
                  if (!selection.settingsTab && selection.workspaceHostId === target.host &&
                    (selection.visibleShipKey === key || selectedPath === removedPath || selectedPath.startsWith(removedPath === "/" ? "/" : `${removedPath}/`))) {
                    activateChat(null);
                    setActiveCwd(target.projectPath);
                    setActiveHostId(remoteHostId(target.host));
                    router.replace("/");
                  }
                }}
              />;
            })}
            </div>
            </div>
          </main>
          {rightPanelIsModal && (
            <div
              className="right-panel-backdrop"
              aria-hidden="true"
              onClick={closeRightPanel}
            />
          )}
          {!settingsTab && rightPanelHasOpened && (
            <div inert={shipVisible ? true : undefined} style={{ display: "contents" }}>
            <RightPanel
              onActivityContainerChange={setActivityContainer}
              fileTabs={fileTabs}
              activeFileTabId={activeFileTabId}
              rightView={rightView}
              onSelectView={handleSelectRightView}
              rightPanelOpen={rightPanelOpen}
              onClose={closeRightPanel}
              rightPanelWidth={rightPanelWidth}
              rightPanelResizing={rightPanelResizing}
              rightPanelRef={attachRightPanel}
              fileExplorerRef={fileExplorerRef}
              revealPath={
                revealTarget?.hostId === workspaceHostId
                  ? revealTarget.path
                  : null
              }
              onRevealDone={handleRevealDone}
              explorerCwd={explorerCwd}
              sourceSessionId={selectedSession?.id ?? null}
              hostId={workspaceHostId}
              connectionDiagnosticsOn={connectionDiagnosticsOn}
              explorerRefreshKey={explorerRefreshKey}
              fileSearchOpen={fileSearchOpen}
              onToggleFileSearch={handleToggleFileSearch}
              onFileSearchOpenChange={setFileSearchOpen}
              explorerUploadBusy={explorerUploadBusy}
              onUploadBusyChange={setExplorerUploadBusy}
              explorerGitCount={explorerGitCount}
              explorerIsRepo={explorerIsRepo}
              explorerRefreshing={explorerRefreshing}
              isMobile={isMobile}
              isCompactOverlay={isCompactOverlay}
              onOpenFile={handleOpenFile}
              onSelectFileTab={handleSelectFileTab}
              onCloseFileTab={handleCloseFileTab}
              onCloseOtherFileTabs={handleCloseOtherFileTabs}
              onCloseAllFileTabs={handleCloseAllFileTabs}
              onMentionActiveFile={handleMentionActiveFile}
              onCopyActiveFilePath={handleCopyActiveFilePath}
              onDownloadActiveFile={handleDownloadActiveFile}
              onRevealActiveFile={handleRevealActiveFile}
              onExplorerRefresh={handleExplorerRefresh}
              onExplorerRefreshDone={handleExplorerRefreshDone}
              onAtMention={handleAtMention}
              onAtMentions={handleAtMentions}
              onMentionLines={handleFileLineMention}
              onExplorerGitStatus={handleExplorerGitStatus}
              onResetRightPanelWidth={resetRightPanelWidth}
              onRightPanelResizeStart={handleRightPanelResizeStart}
              onRightPanelResizeKey={handleRightPanelResizeKey}
            />
            </div>
          )}
        </div>
        <LocalDaemonBanner />
        {archiveBrowserOpen && (
          <ArchiveBrowser
            open={archiveBrowserOpen}
            onClose={() => setArchiveBrowserOpen(false)}
            onRestored={handleArchiveRestored}
          />
        )}
      </ToastProvider>
    </>
  );
}
