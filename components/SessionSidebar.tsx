"use client";

import { browserUUID } from "@/lib/browser-uuid";
import {
  memo,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  useDeferredValue,
} from "react";
import type {
  ExitedRpcSession,
  ManagedProject,
  ProjectLaunchConfig,
  SessionInfo,
} from "@/lib/types";
import type { HierarchySnapshot } from "@/lib/project-hierarchy-types";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { DirectoryPicker } from "./DirectoryPicker";
import { ProjectLaunchConfigDialog } from "./ProjectLaunchConfigDialog";
import { ProviderUsageBar } from "./ProviderUsageBar";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import {
  clearLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf,
} from "@/lib/workspace-memory";
import {
  LOCAL_HOST_ID,
  foldedHostProjectKey,
  groupProjectsByHost,
  groupSessionsByProject,
  hostProjectKey,
  projectIdentity,
  orderProjects,
  projectActivityCounts,
  remoteHostId,
  type ProjectSortMode,
} from "@/lib/project-ordering";
import { isLinkUp } from "@/lib/hosts/host";
import { useHostRows } from "@/hooks/useHostRows";
import { HOST_STATUS_COLOR, hostName, hostStatusText } from "./host-status";
import { comparableProjectPath } from "@/lib/comparable-path";
import type { SearchMatchTarget } from "./SessionSearchMatches";
import {
  compileSearchQuery,
  FIRST_MESSAGE_WEIGHT,
  scoreSearchFields,
  searchField,
  TITLE_WEIGHT,
} from "@/lib/session-search";
import {
  Archive,
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  FileUp,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { publishSessionsChanged } from "@/lib/session-change-bus";
import { openEventStream } from "@/lib/event-stream";
import {
  loadRecentRuns,
  recordCompletedRun,
  removeActiveFromCompleted,
  saveRecentRuns,
  seedRecentRuns,
  type RecentRunEntry,
} from "@/lib/recent-runs";
import { useRecentRunsLimit } from "@/hooks/useRecentRunsLimit";
import {
  EMPTY_PROJECT_SET,
  INITIAL_RESTORE_MAX_ATTEMPTS,
  INITIAL_RESTORE_RETRY_MS,
  MAX_PROJECT_SESSIONS,
  livePlace,
  loadExpandedProjects,
  loadProjectSortMode,
  loadUnreadSessionIds,
  projectLabel,
  saveExpandedProjects,
  saveProjectSortMode,
  saveUnreadSessionIds,
  type LivePlace,
  type WorktreeContext,
  hostsCameOnline,
} from "./SessionSidebar-helpers";
import {
  OmpWebTitle,
  SIDEBAR_BUTTON_TRANSITION,
  SidebarIconButton,
  SidebarPortalMenu,
} from "./SessionSidebar-chrome";
import { HierarchySidebar } from "./HierarchySidebar";

/** Deadline for one /api/sessions fetch. A wedged-but-listening server never
 * answers; without this the initial spinner would pend forever. */
const SESSIONS_FETCH_TIMEOUT_MS = 15_000;
/** Stable empty list: sort modes that ignore sessions keep their memo inputs fixed. */
const NO_SESSIONS: SessionInfo[] = [];

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  /** The active session can exist in memory before its JSONL file is flushed. */
  optimisticSession?: SessionInfo | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (
    sessionId: string,
    cwd: string | null,
    hostId?: string,
    project?: ManagedProject,
  ) => void;
  onNewWorkspace?: (project: ManagedProject) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  onWorkspaceRemoved?: (path: string, host: string) => void;
  selectedCwd?: string | null;
  /** Host `selectedCwd` lives on (this machine when absent). */
  selectedHostId?: string | null;
  selectedLogicalProjectKey?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot: string | null,
    hostId: string,
    project?: ManagedProject,
    synchronized?: boolean,
    latestSession?: SessionInfo,
    discovery?: "pending" | "resolved",
  ) => void;
  onWorkspaceOptionsChange?: (
    projects: ManagedProject[],
    selectedProject: string | null,
    cwd: string | null,
    hostId: string,
  ) => void;
  /** The active Git workspace's worktrees and actions (null when the active
   *  workspace is not a Git top-level repo); rendered by the file panel. */
  onWorktreeContextChange?: (ctx: WorktreeContext | null) => void;
  addProjectOpen: boolean;
  /** Host the open add-workspace picker is for (this machine when absent). */
  addProjectHostId?: string;
  setAddProjectOpen: (open: boolean, hostId?: string) => void;
  /** Shows the provider usage bar above Settings; toggle lives in Settings. */
  usageVisible?: boolean;
  activityTargetRef?: (element: HTMLDivElement | null) => void;
  /** Opens the app settings (pinned sidebar footer row). */
  onOpenSettings?: () => void;
  /** Opens the archived sessions browser. */
  onOpenArchive?: () => void;
  /** In-app back/forward over visited chat views (sidebar header buttons). */
  navigation?: {
    canBack: boolean;
    canForward: boolean;
    onBack: () => void;
    onForward: () => void;
    /** Platform shortcut label for the tooltip, e.g. "⌘[" / "Alt+←". */
    backShortcut: string;
    forwardShortcut: string;
  };
  /** True when settings full-page view is currently open. */
  settingsOpen?: boolean;
  /** Mobile full-screen drawer only: shows a top-left close control. */
  onClose?: () => void;
  /** The trimmed search query ("" while no search runs): the chat highlights its hits. */
  onSearchQueryChange?: (query: string) => void;
  /** A hit picked from a session's match list; the session is opened too. */
  onOpenSearchMatch?: (target: SearchMatchTarget) => void;
}

/** The host a project or session belongs to: this machine unless it says otherwise. */
const hostOf = (item: { hostId?: string }): string =>
  item.hostId ?? LOCAL_HOST_ID;
const projectRequestTarget = (project: ManagedProject) => ({
  cwd: project.path,
  hostId: remoteHostId(project.hostId),
});
const THIS_MACHINE = { id: LOCAL_HOST_ID, label: "" };
const COLLAPSED_HOSTS_STORAGE_KEY = "omp-web:collapsed-hosts";

function loadCollapsedHosts(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(COLLAPSED_HOSTS_STORAGE_KEY) ?? "[]",
    );
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

export const SessionSidebar = memo(function SessionSidebar({
  selectedSessionId,
  optimisticSession,
  onSelectSession,
  onNewSession,
  onNewWorkspace,
  initialSessionId,
  skipInitialProjectSelection,
  onInitialRestoreDone,
  refreshKey,
  onSessionDeleted,
  onWorkspaceRemoved,
  selectedCwd: selectedCwdProp,
  selectedHostId: selectedHostIdProp,
  onCwdChange,
  onWorkspaceOptionsChange,
  onWorktreeContextChange,
  addProjectOpen,
  addProjectHostId = LOCAL_HOST_ID,
  setAddProjectOpen,
  usageVisible = true,
  activityTargetRef,
  onOpenSettings,
  onOpenArchive,
  navigation,
  settingsOpen = false,
  onClose,
  onSearchQueryChange,
  onOpenSearchMatch,
}: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  // Host of selectedCwd: the same path can be a workspace on several hosts.
  const [selectedHostId, setSelectedHostId] = useState<string>(LOCAL_HOST_ID);
  const { hosts } = useHostRows();
  const hostList = useMemo(() => hosts ?? [THIS_MACHINE], [hosts]);
  // Host group headers only exist once a remote host is linked.
  const showHostGroups = hostList.some((host) => host.id !== LOCAL_HOST_ID);
  // The server renders no groups; collapse state is read after mount.
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(
    () => new Set(),
  );
  useEffect(() => setCollapsedHosts(loadCollapsedHosts()), []);
  const toggleHostCollapsed = useCallback((hostId: string) => {
    setCollapsedHosts((prev) => {
      const next = new Set(prev);
      if (!next.delete(hostId)) next.add(hostId);
      try {
        window.localStorage.setItem(
          COLLAPSED_HOSTS_STORAGE_KEY,
          JSON.stringify([...next]),
        );
      } catch {
        // Collapse state is a convenience; ignore storage errors.
      }
      return next;
    });
  }, []);
  // Why a host's sessions cannot be opened or started right now (null when they can).
  const hostUnavailableReason = useCallback(
    (hostId: string): string | null => {
      const row = hosts?.find((host) => host.id === hostId);
      if (!row || isLinkUp(row.status)) return null;
      return t("hosts.unavailableReason", {
        host: hostName(t, row),
        status: hostStatusText(t, row),
      });
    },
    [hosts, t],
  );
  // Managed + session-discovered projects (server-merged, hidden excluded).
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [hierarchyRefresh, setHierarchyRefresh] = useState(0);
  const [registeredWorkspaces, setRegisteredWorkspaces] = useState<
    ManagedProject[]
  >([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  // Add-project picker state.
  const [addProjectBusy, setAddProjectBusy] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  // Per-project expansion, persisted to localStorage (null = nothing stored).
  const [expandedProjects, setExpandedProjects] = useState<Set<string> | null>(
    () => loadExpandedProjects(),
  );
  const [launchConfigProject, setLaunchConfigProject] =
    useState<ManagedProject | null>(null);
  const [hierarchySnapshots, setHierarchySnapshots] = useState<
    Record<string, HierarchySnapshot>
  >({});
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [runningSessionPlaces, setRunningSessionPlaces] = useState<
    Record<string, LivePlace>
  >({});
  const [exitedSessions, setExitedSessions] = useState<
    Map<string, ExitedRpcSession>
  >(() => new Map());
  const awaitingInputIds = useMemo(
    () =>
      new Set(
        Object.keys(runningSessionPlaces).filter(
          (id) => runningSessionPlaces[id].awaitingInput,
        ),
      ),
    [runningSessionPlaces],
  );
  const knownRunningPlacesRef = useRef<Map<string, LivePlace>>(new Map());
  const { limit: recentRunsLimit } = useRecentRunsLimit();
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() =>
    loadUnreadSessionIds(),
  );
  const [recentCompletedRuns, setRecentCompletedRuns] = useState<
    RecentRunEntry[]
  >(() => loadRecentRuns());
  const effectiveRecentCompletedSet = useMemo(() => {
    const timestampMap = new Map<string, number>();

    // 1. Live and persisted recent completed runs
    for (const r of recentCompletedRuns) {
      if (!runningSessionIds.has(r.sessionId)) {
        timestampMap.set(r.sessionId, r.completedAt);
      }
    }

    // 2. On-disk active sessions (fallback & recency backfill)
    for (const s of allSessions) {
      if (runningSessionIds.has(s.id)) continue;
      const isValid =
        (s.firstMessage && s.firstMessage !== "(no messages)") ||
        s.messageCount > 0 ||
        Boolean(s.name);
      if (!isValid) continue;
      const ts = new Date(s.modified).getTime();
      const existing = timestampMap.get(s.id);
      if (existing === undefined || ts > existing) {
        timestampMap.set(s.id, ts);
      }
    }

    // Sort by latest timestamp descending, pick top dynamic limit
    const sorted = [...timestampMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, recentRunsLimit);

    return new Set(sorted.map(([id]) => id));
  }, [recentCompletedRuns, allSessions, runningSessionIds, recentRunsLimit]);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Relative session times must age while the sidebar stays open; one shared
  // minute clock avoids a timer per session row.
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  // Client-side workspace/session filtering (Workspaces header controls).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Workspace sort (per browser). Pins apply only while a sort is active.
  // The sidebar is server-rendered: start at "none" and read storage after mount.
  const [projectSortMode, setProjectSortMode] =
    useState<ProjectSortMode>("none");
  useEffect(() => setProjectSortMode(loadProjectSortMode()), []);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const closeSortMenu = useCallback(() => setSortMenuOpen(false), []);

  // Once the SSE stream has delivered a frame it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const sessionsEtagRef = useRef<string | null>(null);
  const sessionsAbortRef = useRef<AbortController | null>(null);
  // Set once the first /api/sessions fetch settles (success OR failure) so the
  // initial-restore effect can stop waiting on a load that never yields rows.
  const initialLoadedRef = useRef(false);
  const loadSessions = useCallback(
    async (showLoading = false) => {
      sessionsAbortRef.current?.abort();
      const controller = new AbortController();
      sessionsAbortRef.current = controller;
      // A wedged-but-listening server (the long-idle failure mode) accepts the
      // TCP connection and never answers: without a deadline the fetch pends
      // forever and the sidebar shows its initial spinner indefinitely. Abort
      // with a TimeoutError so the catch surfaces an error and the
      // visibility/online recovery below can retry later.
      const timeout = setTimeout(
        () =>
          controller.abort(
            new DOMException("Session list request timed out", "TimeoutError"),
          ),
        SESSIONS_FETCH_TIMEOUT_MS,
      );
      try {
        if (showLoading) setLoading(true);
        const headers: Record<string, string> = {};
        if (sessionsEtagRef.current)
          headers["If-None-Match"] = sessionsEtagRef.current;
        const res = await fetch("/api/sessions", {
          headers,
          signal: controller.signal,
        });
        if (res.status === 304) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const etag = res.headers.get("ETag");
        if (etag) sessionsEtagRef.current = etag;
        const data = (await res.json()) as {
          sessions: SessionInfo[];
          runningSessionIds?: string[];
          runningSessions?: Array<LivePlace & { id: string }>;
        };
        setAllSessions(data.sessions);
        if (data.runningSessions) {
          for (const rs of data.runningSessions) {
            if (rs.id && rs.cwd) knownRunningPlacesRef.current.set(rs.id, rs);
          }
        }
        // Treat the fetched running set as an initial fallback only. Once SSE is
        // live it owns this state, so a slow fetch can't revive a stale snapshot.
        if (!sseAuthoritativeRef.current) {
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
          if (data.runningSessions) {
            const nextPlaces: Record<string, LivePlace> = {};
            for (const rs of data.runningSessions) {
              if (rs.id && rs.cwd) nextPlaces[rs.id] = rs;
            }
            setRunningSessionPlaces(nextPlaces);
          }
        }
        // Drop unread markers for sessions that no longer exist (e.g. deleted).
        const existingIds = new Set(data.sessions.map((s) => s.id));
        setUnreadSessionIds((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set([...prev].filter((id) => existingIds.has(id)));
          return next.size === prev.size ? prev : next;
        });
        setError(null);
        if (!showLoading) {
          setSessionRefreshDone(true);
          if (sessionRefreshTimerRef.current)
            clearTimeout(sessionRefreshTimerRef.current);
          sessionRefreshTimerRef.current = setTimeout(
            () => setSessionRefreshDone(false),
            2000,
          );
        }
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        setError(
          t("sessionSidebar.loadFailed", {
            detail: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        clearTimeout(timeout);
        initialLoadedRef.current = true;
        if (showLoading) setLoading(false);
      }
    },
    [t],
  );

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  const projectsLoadSeqRef = useRef(0);
  const loadProjects = useCallback(async () => {
    const seq = ++projectsLoadSeqRef.current;
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { projects?: ManagedProject[] };
      // A newer request superseded this one — drop the stale response.
      if (seq !== projectsLoadSeqRef.current) return;
      setProjects(data.projects ?? []);
      setHierarchyRefresh((value) => value + 1);
      setProjectsError(null);
      projectsLoadedRef.current = true;
    } catch (e) {
      if (seq !== projectsLoadSeqRef.current) return;
      setProjectsError(
        t("projects.loadFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }, [t]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, refreshKey]);

  useEffect(() => {
    const interval = setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Persist expansion state; null means nothing was stored yet.
  useEffect(() => {
    if (expandedProjects === null) return;
    saveExpandedProjects(expandedProjects);
  }, [expandedProjects]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);
  useEffect(() => {
    saveRecentRuns(recentCompletedRuns, undefined, recentRunsLimit);
  }, [recentCompletedRuns, recentRunsLimit]);

  useEffect(() => {
    if (allSessions.length === 0) return;
    setRecentCompletedRuns((prev) => {
      const seeded = seedRecentRuns(allSessions, recentRunsLimit);
      if (prev.length === 0) return seeded;
      const newestPrev = Math.max(...prev.map((p) => p.completedAt), 0);
      const newestSeeded = Math.max(...seeded.map((s) => s.completedAt), 0);
      if (newestSeeded > newestPrev) {
        return seeded;
      }
      return prev;
    });
  }, [allSessions, recentRunsLimit]);

  // Debounce refresh bursts (agent_start + session_info_update + file-appear signal can fire within 250ms)
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (pendingRefreshRef.current) return;
    pendingRefreshRef.current = setTimeout(() => {
      pendingRefreshRef.current = null;
      void loadSessions(false);
    }, 300);
  }, [loadSessions]);
  useEffect(
    () => () => {
      if (sessionRefreshTimerRef.current) {
        clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = null;
      }
    },
    [],
  );

  // A host's sessions and workspaces only exist server-side once its link is
  // up, and nothing else tells the list so: refetch both when a host comes online.
  const prevHostsRef = useRef<typeof hosts>(null);
  useEffect(() => {
    if (hosts && hostsCameOnline(prevHostsRef.current, hosts)) {
      scheduleRefresh();
      void loadProjects();
    }
    if (hosts) prevHostsRef.current = hosts;
  }, [hosts, loadProjects, scheduleRefresh]);

  useEffect(() => {
    // Live running status and session-list invalidations arrive on the shared
    // event stream; the sidebar never has to poll while an agent is working.
    const source = openEventStream({ kind: "running" });

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as {
          type?: string;
          runningSessionIds?: string[];
          runningSessions?: Array<LivePlace & { id: string }>;
          exitedSessions?: ExitedRpcSession[];
          refreshSessionList?: boolean;
          sessionIds?: string[];
        };
        if (data.type === "running") {
          sseAuthoritativeRef.current = true;
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
          setExitedSessions(
            new Map(
              (data.exitedSessions ?? []).map((session) => [
                session.id,
                session,
              ]),
            ),
          );
          if (data.runningSessions) {
            const nextPlaces: Record<string, LivePlace> = {};
            for (const rs of data.runningSessions) {
              if (rs.id && rs.cwd) {
                knownRunningPlacesRef.current.set(rs.id, rs);
                nextPlaces[rs.id] = rs;
              }
            }
            setRunningSessionPlaces(nextPlaces);
          }
          if (data.refreshSessionList) scheduleRefresh();
        } else if (data.type === "sessions-changed") {
          if (data.refreshSessionList) scheduleRefresh();
          publishSessionsChanged(data.sessionIds ?? []);
        }
      } catch {
        // ignore malformed frames
      }
    };

    source.onerror = () => {
      // The stream reconnects on its own; until a fresh frame arrives, let the
      // polled /api/sessions fallback own running state again.
      sseAuthoritativeRef.current = false;
    };
    return () => {
      if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current);
      source.close();
    };
  }, [loadSessions, scheduleRefresh]);
  // Long-idle recovery: while the tab is hidden the SSE connection can die
  // (laptop sleep, network change, tab freeze) and its EventSource reconnect
  // carries no list invalidation. Refresh whenever the user actually comes
  // back or the network returns, so the list is never left stale/empty.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadSessions(false);
    };
    const onOnline = () => void loadSessions(false);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [loadSessions]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const allCompleted = [...previous].filter(
      (id) => !runningSessionIds.has(id),
    );
    const completedInBackground = allCompleted.filter(
      (id) => id !== selectedSessionId,
    );
    const newlyRunning = [...runningSessionIds].filter(
      (id) => !previous.has(id),
    );

    if (allCompleted.length > 0 || newlyRunning.length > 0) {
      setRecentCompletedRuns((prev) => {
        let updated = prev;
        if (newlyRunning.length > 0) {
          updated = removeActiveFromCompleted(updated, runningSessionIds);
        }
        for (const id of allCompleted) {
          updated = recordCompletedRun(updated, id, undefined, recentRunsLimit);
        }
        return updated;
      });
    }

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    // A brand-new session's JSONL does not exist until the first assistant
    // turn makes progress — but its running badge must show immediately
    // via the optimistic row. Once any session completes (or a new session
    // appears on disk), reload so it replaces the optimistic placeholder
    // without waiting for another refresh trigger.
    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      loadSessions(false);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions, recentRunsLimit]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  const restoredRef = useRef(false);
  /** Set once the first /api/projects fetch succeeds; guards the expansion
   *  prune against running on an empty (still-loading) project list. */
  const projectsLoadedRef = useRef(false);

  const projectRootFor = useCallback(
    (cwd: string | null, hostId: string = LOCAL_HOST_ID): string | null => {
      if (!cwd) return null;
      const path = comparableProjectPath(cwd);
      const workspaces =
        hierarchySnapshots[hostId]?.projects.flatMap(
          (project) => project.workspaces,
        ) ?? [];
      return (
        workspaces
          .filter((workspace) => {
            const root = comparableProjectPath(workspace.path);
            return path === root || path.startsWith(`${root}/`);
          })
          .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? cwd
      );
    },
    [hierarchySnapshots],
  );

  // ---- Expansion (used by the sync/notify effects below, so declared first) --
  const expandProject = useCallback(
    (path: string, hostId: string = LOCAL_HOST_ID) => {
      const key = foldedHostProjectKey(hostId, path);
      setExpandedProjects((prev) => {
        if (prev?.has(key)) return prev;
        const next = new Set(prev ?? []);
        next.add(key);
        return next;
      });
    },
    [],
  );

  /** Activate a project (effective cwd = its root) and expand it, without
   *  opening a session. */
  const activateProject = useCallback(
    (project: ManagedProject) => {
      setSelectedCwd(project.path);
      setSelectedHostId(hostOf(project));
      expandProject(workspaceKeyOf(project), hostOf(project));
    },
    [expandProject],
  );

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const pendingWorkspaceDiscovery = useRef<{ path: string; host: string } | null>(null);
  const lastNotifiedCwdRef = useRef<string | null>(null);
  const synchronizedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    const notifyKey =
      selectedCwd === null ? null : hostProjectKey(selectedHostId, selectedCwd);
    if (lastNotifiedCwdRef.current === notifyKey) return;
    lastNotifiedCwdRef.current = notifyKey;
    const synchronized =
      notifyKey !== null && synchronizedCwdRef.current === notifyKey;
    synchronizedCwdRef.current = null;
    onCwdChange?.(
      selectedCwd,
      projectRootFor(selectedCwd, selectedHostId),
      selectedHostId,
      undefined,
      synchronized,
    );
  }, [selectedCwd, selectedHostId, onCwdChange, projectRootFor]);

  useEffect(() => {
    const pending = pendingWorkspaceDiscovery.current;
    if (!pending || loading || error) return;
    pendingWorkspaceDiscovery.current = null;
    const workspace = hierarchySnapshots[pending.host]?.projects
      .flatMap((project) => project.workspaces)
      .find((item) => item.path === pending.path);
    const latest = allSessions
      .filter((session) => workspace?.sessionIds.includes(session.id) && hostOf(session) === pending.host)
      .sort((a, b) => (b.lastMessageAt ?? b.modified).localeCompare(a.lastMessageAt ?? a.modified))[0];
    onCwdChange?.(pending.path, projectRootFor(pending.path, pending.host), pending.host, undefined, false, latest, "resolved");
  }, [loading, error, allSessions, hierarchySnapshots, onCwdChange, projectRootFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back. Sessions
  // picked outside the sidebar (URL restore, command palette) also expand
  // their containing project.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    // A withdrawn command must not swallow the next one: without this reset,
    // re-commanding a cwd the sidebar already synced (A -> sidebar B -> A)
    // stays stuck on B.
    if (!selectedCwdProp) {
      lastSyncedCwdPropRef.current = null;
      return;
    }
    const hostId = selectedHostIdProp ?? LOCAL_HOST_ID;
    const syncKey = hostProjectKey(hostId, selectedCwdProp);
    if (syncKey !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = syncKey;
      synchronizedCwdRef.current =
        selectedCwd !== selectedCwdProp || selectedHostId !== hostId
          ? syncKey
          : null;
      setSelectedCwd(selectedCwdProp);
      setSelectedHostId(hostId);
      const project = projectRootFor(selectedCwdProp, hostId);
      if (project) expandProject(project, hostId);
    }
  }, [selectedCwdProp, selectedHostIdProp, projectRootFor, expandProject]);

  // Keep a just-created session and its project visible while omp is still
  // flushing the JSONL file. The server list remains authoritative once it
  // contains the same id.
  // IMPORTANT: derive synchronously — the previous projectRootFor(cwd) needs
  // the async /api/worktrees git lookup, so the optimistic row would park in
  // cwd-bucket then jump to repo bucket. Use registered-project match first.
  const optimisticProjectRoot = (() => {
    if (!optimisticSession) return null;
    if (optimisticSession.projectRoot) return optimisticSession.projectRoot;
    if (optimisticSession.projectKey) return optimisticSession.projectKey;
    const cw = optimisticSession.cwd ?? "";
    if (!cw) return null;
    const reg = projects.find(
      (p) =>
        hostOf(p) === hostOf(optimisticSession) &&
        comparableProjectPath(p.path) === comparableProjectPath(cw),
    );
    if (reg) return reg.path;
    return cw;
  })();
  // Stable placeholder timestamps: Date.now() inside the memo would churn every refresh and bust downstream memos.
  const placeholderTsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (optimisticSession?.id && optimisticSession.cwd) {
      const { id, cwd, hostId, projectId, projectKey } = optimisticSession;
      const place = { cwd, hostId, projectId, projectKey };
      knownRunningPlacesRef.current.set(id, place);
      setRunningSessionPlaces((prev) => ({ ...prev, [id]: place }));
    }
  }, [optimisticSession]);
  const visibleSessions = useMemo(() => {
    let base = allSessions;
    if (
      optimisticSession &&
      !base.some((session) => session.id === optimisticSession.id)
    ) {
      const stableRoot = optimisticProjectRoot ?? optimisticSession.cwd;
      const stableKey = stableRoot
        ? comparableProjectPath(stableRoot)
        : undefined;
      base = [
        ...base,
        {
          ...optimisticSession,
          projectRoot: stableRoot ?? optimisticSession.cwd,
          ...(stableKey ? { projectKey: stableKey } : {}),
        },
      ];
    }
    // A running session's JSONL may not exist yet (first turn still
    // streaming). Keep it in the list so navigating away never hides it
    // until the file lands and the next refresh replaces the placeholder.
    const known = new Set(base.map((s) => s.id));
    const placeholders: SessionInfo[] = [];
    const visibleLiveIds = new Set(runningSessionIds);
    for (const id of exitedSessions.keys()) visibleLiveIds.add(id);
    for (const id of visibleLiveIds) {
      if (known.has(id)) continue;
      let ts = placeholderTsRef.current.get(id);
      if (!ts) {
        ts = new Date().toISOString();
        placeholderTsRef.current.set(id, ts);
      }
      const isOptimistic = optimisticSession?.id === id;
      const place = livePlace(
        id,
        optimisticSession,
        runningSessionPlaces,
        exitedSessions,
        knownRunningPlacesRef.current,
        { cwd: selectedCwd ?? "", hostId: selectedHostId },
      );
      const hostId = remoteHostId(place.hostId);
      const resolvedRoot = isOptimistic
        ? (optimisticProjectRoot ??
          optimisticSession.projectRoot ??
          optimisticSession.cwd)
        : (projectRootFor(place.cwd, hostOf(place)) ?? place.cwd);
      const phRoot = resolvedRoot ?? "";
      const phKey = phRoot ? comparableProjectPath(phRoot) : undefined;
      placeholders.push({
        id,
        path: "",
        cwd: place.cwd,
        name: undefined,
        created: ts,
        modified: ts,
        messageCount: 1,
        firstMessage: "",
        projectRoot: phRoot,
        ...(phKey ? { projectKey: phKey } : {}),
        ...(hostId ? { hostId } : {}),
      });
    }
    // Prune timestamps and known cwds for ids that are now materialized or no longer live.
    if (placeholderTsRef.current.size > placeholders.length) {
      for (const key of [...placeholderTsRef.current.keys()]) {
        if (!visibleLiveIds.has(key) || known.has(key))
          placeholderTsRef.current.delete(key);
      }
    }
    if (
      knownRunningPlacesRef.current.size >
      visibleLiveIds.size + (optimisticSession ? 1 : 0)
    ) {
      if (optimisticSession) visibleLiveIds.add(optimisticSession.id);
      for (const key of [...knownRunningPlacesRef.current.keys()]) {
        if (!visibleLiveIds.has(key) && known.has(key))
          knownRunningPlacesRef.current.delete(key);
      }
    }
    return placeholders.length ? [...base, ...placeholders] : base;
  }, [
    allSessions,
    optimisticSession,
    optimisticProjectRoot,
    runningSessionIds,
    runningSessionPlaces,
    exitedSessions,
    projectRootFor,
    selectedCwd,
    selectedHostId,
  ]);
  const visibleProjects = projects;

  // ---- Derived project list ---------------------------------------------------
  const selectedProject = useMemo(
    () => projectRootFor(selectedCwd, selectedHostId),
    [projectRootFor, selectedCwd, selectedHostId],
  );
  // While a fresh optimistic/placeholder is pending (JSONL not yet on disk),
  // freeze ordering so the new project row does not flicker optimistic ->
  // confirmed position. New projects are allowed to append at the end. A
  // user ordering action (sort mode, pin, manual order) ends the freeze, and
  // frozen rows still show the fresh project data.
  const hasPendingNewSession = Boolean(
    optimisticSession ||
    [...runningSessionIds, ...exitedSessions.keys()].some(
      (id) => !allSessions.some((session) => session.id === id),
    ),
  );
  // Only "Last updated" reads sessions; other modes must not re-sort on every session refresh.
  const orderingSessions =
    projectSortMode === "updated" ? visibleSessions : NO_SESSIONS;
  const sortedProjectsBase = useMemo(
    () =>
      orderProjects(
        visibleProjects,
        projectSortMode,
        orderingSessions,
        (project) =>
          project.alias ?? project.name ?? projectLabel(project.path),
      ),
    [visibleProjects, projectSortMode, orderingSessions],
  );
  const orderingKey = useMemo(
    () =>
      [
        projectSortMode,
        ...projects.map(
          (p) =>
            `${projectIdentity(p)}\t${p.sortOrder ?? ""}\t${p.pinOrder ?? ""}`,
        ),
      ].join("\n"),
    [projectSortMode, projects],
  );
  const sortedProjectsRef = useRef<{
    key: string;
    list: ManagedProject[];
  } | null>(null);
  const sortedProjects = useMemo(() => {
    const prev = sortedProjectsRef.current;
    if (hasPendingNewSession && prev && prev.key === orderingKey) {
      const fresh = new Map(
        sortedProjectsBase.map((p) => [projectIdentity(p), p]),
      );
      const next = prev.list.map((p) => fresh.get(projectIdentity(p)) ?? p);
      const prevKeys = new Set(prev.list.map(projectIdentity));
      for (const p of sortedProjectsBase)
        if (!prevKeys.has(projectIdentity(p))) next.push(p);
      return next;
    }
    return sortedProjectsBase;
  }, [sortedProjectsBase, hasPendingNewSession, orderingKey]);
  // Snapshot only committed orders; render work React discards must not leak into the freeze.
  useEffect(() => {
    const prev = sortedProjectsRef.current;
    if (!hasPendingNewSession || !prev || prev.key !== orderingKey) {
      sortedProjectsRef.current = {
        key: orderingKey,
        list: sortedProjectsBase,
      };
    }
  }, [hasPendingNewSession, orderingKey, sortedProjectsBase]);
  useEffect(() => {
    onWorkspaceOptionsChange?.(
      registeredWorkspaces,
      selectedProject,
      selectedCwd,
      selectedHostId,
    );
  }, [
    onWorkspaceOptionsChange,
    registeredWorkspaces,
    selectedProject,
    selectedCwd,
    selectedHostId,
  ]);
  const sessionsByProject = useMemo(
    () => groupSessionsByProject(sortedProjects, visibleSessions),
    [sortedProjects, visibleSessions],
  );
  const projectActivity = useMemo(
    () =>
      projectActivityCounts(
        visibleSessions,
        runningSessionIds,
        unreadSessionIds,
        exitedSessions.keys(),
      ),
    [visibleSessions, runningSessionIds, unreadSessionIds, exitedSessions],
  );

  // Client-side filtering (Workspaces header: search + "running only").
  // While a filter is active, workspaces with no matching sessions are hidden
  // so the list reads as a genuine result set; at rest every workspace stays.
  // Deferred search: typing stays responsive (input updates immediately) while the heavy
  // visibleProjectEntries filter runs at lower priority. Combines with the 200ms ETag loadSessions
  // debounce already in place — keystrokes never block the main thread on large session lists.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const trimmedSearchQuery = deferredSearchQuery.trim();
  const filtersActive =
    searchOpen || runningOnly || trimmedSearchQuery.length > 0;
  // Transcript matches stream from the server; title matches are scored locally
  // so results appear on the first keystroke and never wait on a full scan.
  // Stop (or a new query) aborts the stream; hits found so far stay.
  const [transcriptSearch, setTranscriptSearch] = useState<{
    query: string;
    scores: Record<string, number>;
    status: "running" | "done" | "stopped";
  } | null>(null);
  const transcriptSearchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!trimmedSearchQuery) return;
    const query = trimmedSearchQuery;
    const controller = new AbortController();
    transcriptSearchAbortRef.current = controller;
    // A newer query (or closing the search) aborts too, but is not a user Stop.
    let superseded = false;
    const timer = setTimeout(async () => {
      setTranscriptSearch({ query, scores: {}, status: "running" });
      let status: "done" | "stopped" = "stopped";
      // Each merge re-ranks every session; merge streamed batches at most every 200ms.
      let pending: Record<string, number> = {};
      let lastFlush = 0;
      const flush = () => {
        if (Object.keys(pending).length === 0) return;
        const batch = pending;
        pending = {};
        lastFlush = Date.now();
        setTranscriptSearch((prev) =>
          prev?.query === query
            ? { ...prev, scores: { ...prev.scores, ...batch } }
            : prev,
        );
      };
      try {
        const res = await fetch(
          `/api/sessions/search?q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            const parsed: unknown = line ? JSON.parse(line) : null;
            if (
              !parsed ||
              typeof parsed !== "object" ||
              !("scores" in parsed) ||
              !parsed.scores ||
              typeof parsed.scores !== "object"
            )
              continue;
            for (const [id, score] of Object.entries(parsed.scores))
              if (typeof score === "number") pending[id] = score;
          }
          if (Date.now() - lastFlush >= 200) flush();
        }
        status = "done";
      } catch {
        // Stopped, superseded or failed: the title matches and hits so far stay.
      }
      if (superseded) return;
      flush();
      setTranscriptSearch((prev) =>
        prev?.query === query ? { ...prev, status } : prev,
      );
    }, 250);
    return () => {
      superseded = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedSearchQuery]);
  const currentTranscriptSearch =
    transcriptSearch?.query === trimmedSearchQuery ? transcriptSearch : null;
  useEffect(() => {
    onSearchQueryChange?.(trimmedSearchQuery);
  }, [trimmedSearchQuery, onSearchQueryChange]);
  const matchedSessionIds = useMemo(() => {
    if (!trimmedSearchQuery && !runningOnly) return null;
    const query = compileSearchQuery(trimmedSearchQuery);
    return new Set(
      allSessions
        .filter((session) => {
          if (runningOnly && !runningSessionIds.has(session.id)) return false;
          return (
            !query ||
            currentTranscriptSearch?.scores[session.id] !== undefined ||
            scoreSearchFields(
              [
                searchField(session.name ?? "", TITLE_WEIGHT),
                searchField(session.firstMessage, FIRST_MESSAGE_WEIGHT),
              ],
              query,
            ) !== null
          );
        })
        .map((session) => session.id),
    );
  }, [
    allSessions,
    trimmedSearchQuery,
    runningOnly,
    runningSessionIds,
    currentTranscriptSearch,
  ]);

  // Drop persisted expansion keys whose project no longer exists (removed or
  // vanished), so the storage stays bounded to real projects. Only runs after
  // the first project fetch — an empty list mid-load must never wipe storage.
  useEffect(() => {
    if (expandedProjects === null || !projectsLoadedRef.current) return;
    const known = new Set(
      sortedProjects.map((p) =>
        foldedHostProjectKey(p.hostId, workspaceKeyOf(p)),
      ),
    );
    const stale = [...expandedProjects].filter(
      (path) => !known.has(comparableProjectPath(path)),
    );
    if (stale.length === 0) return;
    setExpandedProjects((prev) => {
      if (!prev) return prev;
      const next = new Set(prev);
      stale.forEach((path) => next.delete(path));
      return next;
    });
  }, [expandedProjects, sortedProjects]);

  // A just-started session's JSONL is not flushed until its first turn makes
  // progress, so a URL reopened in that window has no list entry yet. Retry
  // the list a few times before declaring the restore failed.
  const restoreRetryRef = useRef(0);
  const restoreRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(
    () => () => {
      if (restoreRetryTimerRef.current) {
        clearTimeout(restoreRetryTimerRef.current);
        restoreRetryTimerRef.current = null;
      }
    },
    [],
  );

  // Restore a session explicitly named in the URL on first load.
  useEffect(() => {
    if (skipInitialProjectSelection) return;

    // If restoring a session, set cwd to match that session
    if (initialSessionId && !restoredRef.current) {
      // An empty list only blocks while the first load is still in flight —
      // a settled-but-empty or failed load means the target will never appear
      // (shared ?session= link, deleted session), so fall through to the
      // retry/exhaustion path below instead of returning forever.
      if (allSessions.length === 0 && !initialLoadedRef.current) return; // wait for sessions to load
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        restoreRetryRef.current = 0;
        restoredRef.current = true;
        setSelectedCwd(target.cwd);
        setSelectedHostId(hostOf(target));
        expandProject(workspaceKeyOf(target), hostOf(target));
        onSelectSession(target, true);
        return;
      }
      if (restoreRetryRef.current < INITIAL_RESTORE_MAX_ATTEMPTS) {
        restoreRetryRef.current += 1;
        if (restoreRetryTimerRef.current) {
          clearTimeout(restoreRetryTimerRef.current);
          restoreRetryTimerRef.current = null;
        }
        restoreRetryTimerRef.current = setTimeout(() => {
          restoreRetryTimerRef.current = null;
          void loadSessions(false);
        }, INITIAL_RESTORE_RETRY_MS);
        return;
      }
      restoreRetryRef.current = 0;
      restoredRef.current = true;
      // Session not found — notify parent so it can show the placeholder
      onInitialRestoreDone?.();
    }
  }, [
    allSessions,
    initialSessionId,
    skipInitialProjectSelection,
    onSelectSession,
    onInitialRestoreDone,
    expandProject,
    loadSessions,
  ]);

  // Default expansion: when the user has never stored an expansion choice,
  // expand only the active project.
  const defaultExpandedRef = useRef(false);
  useEffect(() => {
    if (defaultExpandedRef.current) return;
    const project = selectedProject;
    if (!project) return;
    defaultExpandedRef.current = true;
    if (expandedProjects === null) expandProject(project, selectedHostId);
  }, [selectedProject, selectedHostId, expandedProjects, expandProject]);

  const commitAddProject = useCallback(
    async (candidate?: string, launchConfig?: ProjectLaunchConfig) => {
      const path = (candidate ?? "").trim();
      if (!path || addProjectBusy) return;

      setAddProjectBusy(true);
      setAddProjectError(null);
      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: path,
            launchConfig,
            hostId: remoteHostId(addProjectHostId),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          project?: ManagedProject;
          error?: string;
          code?: string;
        };
        if (!res.ok || data.error || !data.project) {
          setAddProjectError(
            formatApiError({
              ...data,
              error: data.error ?? `HTTP ${res.status}`,
            }),
          );
          return;
        }
        await loadProjects();
        // Activate + expand the newly added project and close the picker.
        activateProject(data.project);
        setAddProjectOpen(false);
      } catch (e) {
        setAddProjectError(e instanceof Error ? e.message : String(e));
      } finally {
        setAddProjectBusy(false);
      }
    },
    [
      addProjectBusy,
      addProjectHostId,
      loadProjects,
      activateProject,
      setAddProjectOpen,
    ],
  );

  const handleUpdateProjectPresentation = useCallback(
    async (
      project: ManagedProject,
      updates: {
        alias?: string | null;
        sortOrder?: number | null;
        pinOrder?: number | null;
        launchConfig?: ProjectLaunchConfig | null;
      },
    ) => {
      try {
        const response = await fetch("/api/projects", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...projectRequestTarget(project),
            ...updates,
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
            code?: string;
          };
          throw new Error(
            body.error || body.code
              ? formatApiError(body)
              : t("projects.updateFailed"),
          );
        }
        await loadProjects();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    [loadProjects, t],
  );

  // The menu closes itself on a menu item click and returns focus to the trigger.
  const chooseProjectSortMode = useCallback((mode: ProjectSortMode) => {
    setProjectSortMode(mode);
    saveProjectSortMode(mode);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees. Selecting a session also
  // activates and expands its containing project.
  const handleSelectSessionFromList = useCallback(
    (s: SessionInfo) => {
      // An unreachable host's sessions stay listed, but cannot be opened.
      const unavailable = hostUnavailableReason(hostOf(s));
      if (unavailable) {
        toast.info(unavailable);
        return;
      }
      if (s.cwd) setSelectedCwd(projectRootFor(s.cwd, hostOf(s)));
      setSelectedHostId(hostOf(s));
      expandProject(workspaceKeyOf(s), hostOf(s));
      onSelectSession(s);
    },
    [onSelectSession, expandProject, hostUnavailableReason, projectRootFor],
  );
  const handleOpenSearchMatch = useCallback(
    (s: SessionInfo, target: SearchMatchTarget) => {
      handleSelectSessionFromList(s);
      // An unreachable host refused the selection (with a toast): leave no pending jump behind.
      if (!hostUnavailableReason(hostOf(s))) onOpenSearchMatch?.(target);
    },
    [handleSelectSessionFromList, onOpenSearchMatch, hostUnavailableReason],
  );

  const handleNewSession = useCallback(() => {
    if (!selectedCwd || hostUnavailableReason(selectedHostId)) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = browserUUID();
    onNewSession?.(tempId, selectedCwd, selectedHostId);
  }, [selectedCwd, selectedHostId, onNewSession, hostUnavailableReason]);
  const newSessionBlockedReason = hostUnavailableReason(selectedHostId);
  const newSessionEnabled =
    Boolean(selectedCwd) && newSessionBlockedReason === null;

  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleImportSession = useCallback(
    async (file: File | null) => {
      if (!file || importing) return;
      setImporting(true);
      try {
        const content = await file.text();
        const res = await fetch("/api/sessions/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, content }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          code?: string;
        };
        if (!res.ok || !data.success) {
          toast.error(data.error ?? `HTTP ${res.status}`);
          return;
        }
        toast.success(t("sessionSidebar.imported"));
        loadSessions(false);
        void loadProjects();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setImporting(false);
      }
    },
    [importing, loadSessions, loadProjects, t],
  );

  // Sessions of every worktree in the selected project are shown together.
  // Keys are comparableProjectPath forms (see expandProject) — comparable to
  // the folded registry paths rows are checked against.
  const expandedProjectKeys = expandedProjects ?? EMPTY_PROJECT_SET;

  const worktreeContext = useMemo<WorktreeContext | null>(() => {
    if (!selectedCwd) return null;
    const project = hierarchySnapshots[selectedHostId]?.projects.find((p) =>
      p.workspaces.some(
        (w) =>
          comparableProjectPath(w.path) ===
          comparableProjectPath(
            projectRootFor(selectedCwd, selectedHostId) ?? "",
          ),
      ),
    );
    if (!project || project.kind !== "git") return null;
    return {
      hostId: selectedHostId,
      projectRoot: project.path,
      worktrees: project.workspaces.map((w) => ({
        path: w.path,
        branch: w.branch ?? null,
        isMain: w.isDefault,
      })),
      currentPath: projectRootFor(selectedCwd, selectedHostId) ?? selectedCwd,
      select: (path) => {
        if (project.workspaces.some((w) => w.path === path))
          setSelectedCwd(path);
      },
      refresh: () => setHierarchyRefresh((value) => value + 1),
    };
  }, [hierarchySnapshots, selectedCwd, selectedHostId, projectRootFor]);
  useEffect(() => {
    onWorktreeContextChange?.(worktreeContext);
  }, [onWorktreeContextChange, worktreeContext]);

  // Stable callbacks for the session list so memoized children don't re-render
  // on every parent state change.
  const handleSessionDeleted = useCallback(
    (id: string) => {
      const deleted = allSessions.find((session) => session.id === id);
      if (deleted)
        clearLastOpenSession(
          hostProjectKey(deleted.hostId, workspaceKeyOf(deleted)),
        );
      onSessionDeleted?.(id);
      loadSessions();
    },
    [allSessions, onSessionDeleted, loadSessions],
  );

  useEffect(() => {
    const selected = allSessions.find(
      (session) => session.id === selectedSessionId,
    );
    if (selected)
      setLastOpenSession(
        hostProjectKey(selected.hostId, workspaceKeyOf(selected)),
        selected.id,
      );
  }, [allSessions, selectedSessionId]);

  return (
    <div
      className="sidebar-shell"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {addProjectOpen && (
        <DirectoryPicker
          key={addProjectHostId}
          host={{
            id: addProjectHostId,
            name: hostName(
              t,
              hostList.find((host) => host.id === addProjectHostId) ?? {
                id: addProjectHostId,
                label: addProjectHostId,
              },
            ),
          }}
          busy={addProjectBusy}
          error={addProjectError}
          onCancel={() => {
            setAddProjectOpen(false);
            setAddProjectError(null);
          }}
          onSelect={(path, launchConfig) =>
            void commitAddProject(path, launchConfig)
          }
        />
      )}
      {launchConfigProject && (
        <ProjectLaunchConfigDialog
          projectPath={launchConfigProject.path}
          initialConfig={launchConfigProject.launchConfig}
          onClose={() => setLaunchConfigProject(null)}
          onSave={async (launchConfig) => {
            await handleUpdateProjectPresentation(launchConfigProject, {
              launchConfig,
            });
            toast.info(t("sessionSidebar.launchConfigSaved"));
          }}
        />
      )}
      {/* Header: branding + quiet utilities + New Session */}
      <div
        style={{
          padding: "10px 10px 8px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              minWidth: 0,
            }}
          >
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                title={t("appShell.hideSidebar")}
                aria-label={t("appShell.hideSidebar")}
                className="shell-toolbar-btn ui-focus-ring"
              >
                <X size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            <OmpWebTitle />
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            {navigation && (
              <span className="sidebar-nav-buttons">
                <Tooltip
                  content={`${t("sessionSidebar.navigateBack")} (${navigation.backShortcut})`}
                  side="bottom"
                >
                  <SidebarIconButton
                    label={t("sessionSidebar.navigateBack")}
                    onClick={navigation.onBack}
                    disabled={!navigation.canBack}
                  >
                    <ArrowLeft size={15} strokeWidth={1.9} aria-hidden="true" />
                  </SidebarIconButton>
                </Tooltip>
                <Tooltip
                  content={`${t("sessionSidebar.navigateForward")} (${navigation.forwardShortcut})`}
                  side="bottom"
                >
                  <SidebarIconButton
                    label={t("sessionSidebar.navigateForward")}
                    onClick={navigation.onForward}
                    disabled={!navigation.canForward}
                  >
                    <ArrowRight
                      size={15}
                      strokeWidth={1.9}
                      aria-hidden="true"
                    />
                  </SidebarIconButton>
                </Tooltip>
              </span>
            )}
            {onOpenArchive && (
              <Tooltip
                content={t("sessionSidebar.archiveBrowserTitle")}
                side="bottom"
              >
                <SidebarIconButton
                  label={t("sessionSidebar.archiveBrowser")}
                  onClick={onOpenArchive}
                >
                  <Archive size={14} strokeWidth={1.9} aria-hidden="true" />
                </SidebarIconButton>
              </Tooltip>
            )}
            <Tooltip content={t("sessionSidebar.importTitle")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.import")}
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
              >
                <FileUp size={14} strokeWidth={1.9} aria-hidden="true" />
              </SidebarIconButton>
            </Tooltip>
            <Tooltip content={t("sessionSidebar.refresh")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.refresh")}
                active={sessionRefreshDone}
                onClick={() => {
                  loadSessions(false);
                  void loadProjects();
                }}
              >
                {sessionRefreshDone ? (
                  <Check size={14} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />
                )}
              </SidebarIconButton>
            </Tooltip>
          </div>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".jsonl,.json,application/json,application/jsonl"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            e.target.value = "";
            void handleImportSession(file);
          }}
        />
        <button
          onClick={handleNewSession}
          disabled={!selectedCwd}
          aria-disabled={newSessionEnabled ? undefined : true}
          aria-describedby={
            newSessionBlockedReason ? "sidebar-new-session-reason" : undefined
          }
          className="sidebar-new-session"
          title={
            newSessionBlockedReason ??
            (selectedCwd
              ? t("sessionSidebar.newSessionIn", { cwd: selectedCwd })
              : t("sessionSidebar.selectProjectFirst"))
          }
          style={{
            width: "100%",
            height: 38,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            color: newSessionEnabled ? "var(--text)" : "var(--text-dim)",
            cursor: newSessionEnabled ? "pointer" : "not-allowed",
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            opacity: newSessionEnabled ? 1 : 0.65,
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => {
            if (!newSessionEnabled) return;
            e.currentTarget.style.background = "var(--bg-selected)";
            e.currentTarget.style.borderColor =
              "color-mix(in srgb, var(--accent) 30%, transparent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          <Plus
            size={15}
            strokeWidth={2.2}
            style={{ color: "var(--accent)", flexShrink: 0 }}
            aria-hidden="true"
          />
          <span>{t("sessionSidebar.new")}</span>
          {newSessionBlockedReason && (
            <span
              id="sidebar-new-session-reason"
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                overflow: "hidden",
                clip: "rect(0, 0, 0, 0)",
                whiteSpace: "nowrap",
              }}
            >
              {newSessionBlockedReason}
            </span>
          )}
        </button>
      </div>

      {/* Workspaces section header: label + search / sort / filter / add */}
      <div
        style={{
          flexShrink: 0,
          padding: "4px 10px 2px",
          display: "flex",
          alignItems: "center",
          gap: 2,
        }}
      >
        <span
          style={{
            flex: 1,
            color: "var(--text-muted)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {t("projects.heading")}
        </span>
        <SidebarIconButton
          label={t("sessionSidebar.search")}
          title={t("sessionSidebar.searchTitle")}
          active={searchOpen}
          onClick={() => {
            const nextOpen = !searchOpen;
            setSearchOpen(nextOpen);
            if (nextOpen) setTimeout(() => searchInputRef.current?.focus(), 0);
            else setSearchQuery("");
          }}
        >
          <Search size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SidebarIconButton
          label={t("sessionSidebar.filterRunning")}
          title={t("sessionSidebar.filterRunningTitle", {
            count: recentRunsLimit,
          })}
          active={runningOnly}
          onClick={() => setRunningOnly((v) => !v)}
        >
          <SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SidebarIconButton
          label={t("projects.add")}
          title={t("projects.addTitle")}
          onClick={() => {
            setAddProjectOpen(true, selectedHostId);
            setAddProjectError(null);
          }}
        >
          <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
      </div>
      {searchOpen && (
        <div style={{ padding: "0 10px 6px", flexShrink: 0 }}>
          <input
            className="sidebar-session-search"
            ref={searchInputRef}
            value={searchQuery}
            maxLength={500}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
            placeholder={t("sessionSidebar.searchPlaceholder")}
            aria-label={t("sessionSidebar.search")}
            style={{
              width: "100%",
              height: 27,
              boxSizing: "border-box",
              padding: "0 9px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              outline: "none",
              color: "var(--text)",
              fontSize: 12,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--accent)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
            }}
          />
          {currentTranscriptSearch &&
            currentTranscriptSearch.status !== "done" && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 5,
                  color: "var(--text-dim)",
                  fontSize: 11,
                  lineHeight: 1.35,
                }}
              >
                {currentTranscriptSearch.status === "running" && (
                  <Loader2
                    size={11}
                    strokeWidth={2}
                    className="animate-spin"
                    style={{ flexShrink: 0 }}
                    aria-hidden="true"
                  />
                )}
                <span style={{ flex: 1, minWidth: 0 }}>
                  {t(
                    currentTranscriptSearch.status === "running"
                      ? "sessionSidebar.searchingTranscripts"
                      : "sessionSidebar.searchStopped",
                  )}
                </span>
                {currentTranscriptSearch.status === "running" && (
                  <button
                    type="button"
                    onClick={() => transcriptSearchAbortRef.current?.abort()}
                    style={{
                      flexShrink: 0,
                      padding: "1px 6px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-control)",
                      background: "var(--bg-panel)",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    {t("sessionSidebar.stopSearch")}
                  </button>
                )}
              </div>
            )}
        </div>
      )}

      {/* Workspaces */}
      <div
        style={{
          flex: "1 1 auto",
          overflowY: "auto",
          padding: "2px 10px 10px",
          minHeight: 80,
        }}
      >
        {loading && (
          <div
            role="status"
            aria-live="polite"
            aria-label={t("sessionSidebar.loading")}
            style={{ display: "grid", gap: 10, padding: "10px 4px" }}
          >
            <div
              aria-hidden="true"
              className="skeleton"
              style={{ width: "78%", height: 18 }}
            />
            <div
              aria-hidden="true"
              className="skeleton"
              style={{ width: "92%", height: 30 }}
            />
            <div
              aria-hidden="true"
              className="skeleton"
              style={{ width: "86%", height: 30 }}
            />
            <div
              aria-hidden="true"
              className="skeleton"
              style={{ width: "68%", height: 30 }}
            />
          </div>
        )}
        {projectsError && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "10px 4px",
              color: "var(--status-error)",
              fontSize: 12,
            }}
          >
            <span>{projectsError}</span>
            <button
              className="load-retry-button"
              type="button"
              onClick={() => {
                loadSessions(false);
                void loadProjects();
              }}
              style={{
                minHeight: 32,
                padding: "4px 8px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {t("sessionSidebar.refresh")}
            </button>
          </div>
        )}
        {error && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "10px 4px",
              color: "var(--status-error)",
              fontSize: 12,
            }}
          >
            <span>{error}</span>
            <button
              className="load-retry-button"
              type="button"
              onClick={() => {
                loadSessions(false);
                void loadProjects();
              }}
              style={{
                minHeight: 32,
                padding: "4px 8px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {t("sessionSidebar.refresh")}
            </button>
          </div>
        )}
        {!loading &&
          !projectsError &&
          !error &&
          sortedProjects.length === 0 && (
            <div
              style={{
                padding: "10px 4px",
                color: "var(--text-muted)",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {t("projects.noProjects")}
            </div>
          )}

        <HierarchySidebar
          hosts={hostList}
          onProjects={setRegisteredWorkspaces}
          collapsedHosts={collapsedHosts}
          onToggleHost={toggleHostCollapsed}
          onSnapshots={setHierarchySnapshots}
          searchQuery={trimmedSearchQuery}
          runningOnly={runningOnly}
          runningSessionIds={runningSessionIds}
          awaitingInputIds={awaitingInputIds}
          unreadSessionIds={unreadSessionIds}
          exitedSessionIds={exitedSessions.keys()}
          matchedSessionIds={matchedSessionIds}
          refreshKey={(refreshKey ?? 0) + hierarchyRefresh}
          sessions={allSessions}
          selectedSessionId={selectedSessionId}
          selectedCwd={selectedCwd}
          selectedHostId={selectedHostId}
          onSelectWorkspace={(path, host, latestSession) => {
            pendingWorkspaceDiscovery.current = loading ? { path, host } : null;
            lastNotifiedCwdRef.current = hostProjectKey(host, path);
            onCwdChange?.(path, projectRootFor(path, host), host, undefined, false, latestSession, loading ? "pending" : undefined);
            setSelectedCwd(path);
            setSelectedHostId(host);
            onClose?.();
          }}
          onWorkspaceRemoved={(path, host) => {
            if (selectedCwd === path && selectedHostId === host) {
              setSelectedCwd(null);
            }
            onWorkspaceRemoved?.(path, host);
          }}
          onSelectSession={handleSelectSessionFromList}
          onNewWorkspace={(project) => onNewWorkspace?.(project)}
          hostUnavailableReason={hostUnavailableReason}
          onAddProject={(host) => {
            setAddProjectOpen(true, host);
            setAddProjectError(null);
          }}
          onChanged={() => {
            void loadProjects();
            void loadSessions();
          }}
        />
      </div>
      {activityTargetRef && (
        <div
          ref={activityTargetRef}
          style={{
            flexShrink: 0,
            minHeight: 0,
            maxHeight: "35%",
            overflowY: "auto",
          }}
        />
      )}

      {/* Provider usage bar — pinned above Settings */}
      {usageVisible && <ProviderUsageBar />}
      {/* Pinned footer: Settings */}
      <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        <button
          className="sidebar-settings-row"
          data-active={settingsOpen}
          onClick={onOpenSettings}
          title={t("chatInput.settings")}
          aria-label={t("chatInput.settings")}
          style={{
            width: "100%",
            height: 36,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 12px",
            background: settingsOpen ? "var(--bg-selected)" : "none",
            border: "none",
            color: settingsOpen ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = settingsOpen
              ? "var(--bg-selected)"
              : "var(--bg-hover)";
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = settingsOpen
              ? "var(--bg-selected)"
              : "none";
            e.currentTarget.style.color = settingsOpen
              ? "var(--text)"
              : "var(--text-muted)";
          }}
        >
          <span
            style={{
              position: "relative",
              display: "inline-flex",
              flexShrink: 0,
              color: "var(--accent)",
            }}
          >
            <Settings2 size={14} strokeWidth={2} aria-hidden="true" />
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {t("chatInput.settings")}
          </span>
          <ChevronRight
            size={13}
            strokeWidth={2}
            style={{ flexShrink: 0, color: "var(--text-dim)" }}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
});
