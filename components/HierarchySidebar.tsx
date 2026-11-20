"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AlertCircle,
  BellOff,
  Bot,
  ChevronRight,
  ClipboardList,
  FolderCog,
  FolderInput,
  Loader2,
  MoreHorizontal,
  Plus,
  Server,
  Trash2,
  Wrench,
} from "lucide-react";
import { isLinkUp, type HostStatus } from "@/lib/hosts/host";
import { useI18n } from "@/lib/i18n";
import type {
  HierarchyProject,
  HierarchySnapshot,
  HierarchyRequest,
} from "@/lib/project-hierarchy-types";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import { hostProjectKey, LOCAL_HOST_ID } from "@/lib/project-ordering";
import type {
  WorkspaceCreateRequest,
  WorkspaceCreationJob,
  WorkspaceDeleteResult,
} from "@/lib/workspace-creation-types";
import { readWorkspaceSetupJob, WorktreesPanel } from "./WorktreesPanel";
import { PendingOperation } from "./PendingOperation";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import type { ShipTarget } from "./ShipDialog";
import { useShipAvailability } from "@/hooks/useShipAvailability";
import { ConfirmDialog } from "./ui/field";
import { ProjectSettings } from "./ReposConfig";
import { toast } from "./ui/toast";
import type { EffortRecord } from "@/lib/api-contracts/systems";
import {
  SidebarIconButton,
  SidebarSectionHeader,
} from "./SessionSidebar-chrome";
import type { PlanningDestination } from "./SessionSidebar";
import { SystemsSidebar } from "./SystemsSidebar";
import type { SystemsHosts } from "./SystemsHost";

function ProjectIcon({ project }: { project: HierarchyProject }) {
  const name = project.alias || project.name;
  let hash = 2166136261;
  for (const character of name)
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  const style: CSSProperties = {
    width: 26,
    height: 26,
    flex: "0 0 26px",
    marginRight: 8,
    borderRadius: "50%",
    objectFit: "cover",
  };
  return project.icon ? (
    <img src={project.icon} alt="" style={style} />
  ) : (
    <span
      aria-hidden="true"
      style={{
        ...style,
        display: "grid",
        placeItems: "center",
        background: `var(--project-icon-${(hash >>> 0) % 6})`,
        color: "var(--project-icon-text)",
        fontSize: 13,
      }}
    >
      {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?"}
    </span>
  );
}

type Host = { id: string; label: string; status?: HostStatus };
type Props = {
  hosts: Host[];
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  selectedCwd: string | null;
  selectedHostId: string;
  refreshKey?: number;
  systemsHosts: SystemsHosts;
  onOpenEffort: (
    host: string,
    effort: EffortRecord,
    navigate: boolean,
    latestSession?: SessionInfo,
  ) => void;
  onSelectWorkspace: (
    path: string,
    host: string,
    latestSession?: SessionInfo,
  ) => void;
  onWorkspaceRemoved: (path: string, host: string) => void;
  onShip?: (target: ShipTarget) => void;
  onProjects: (projects: ManagedProject[]) => void;
  onSnapshots: (snapshots: Record<string, HierarchySnapshot>) => void;
  searchQuery: string;
  matchedSessionIds: Set<string> | null;
  runningOnly: boolean;
  runningSessionIds: Set<string>;
  awaitingInputIds: Set<string>;
  unreadSessionIds: Set<string>;
  hasUndismissedExit: (id: string) => boolean;
  collapsedHosts: Set<string>;
  onToggleHost: (host: string) => void;
  onSelectSession: (session: SessionInfo) => void;
  onOpenLinkedSession?: (sessionId: string) => void;
  onOpenPlanning?: (destination: PlanningDestination) => void;
  onAddProject: (host: string) => void;
  onNewWorkspace: (project: ManagedProject) => void;
  buildingWorkspaceProjects?: ReadonlySet<string>;
  hostUnavailableReason?: (hostId: string) => string | null;
  onChanged: () => void;
};

type Discovery = {
  host: string;
  projectId: string;
  workspaceId?: string;
  snapshot: HierarchySnapshot;
};

function SidebarShipButton({
  host,
  projectPath,
  path,
  sessionId,
  disabled,
  open,
  onClick,
  style,
}: {
  host: string;
  projectPath: string;
  path: string;
  sessionId?: string;
  disabled: boolean;
  open: boolean;
  onClick: () => void;
  style: CSSProperties;
}) {
  const empty = useShipAvailability(
    host,
    projectPath,
    path,
    open && !!sessionId,
  );
  return (
    <button
      style={style}
      type="button"
      disabled={disabled || empty}
      title={
        disabled && sessionId
          ? "Wait for the session to finish"
          : empty
            ? "Nothing to ship"
            : "Ship workspace"
      }
      onClick={(e) => {
        e.currentTarget.closest("details")?.removeAttribute("open");
        onClick();
      }}
    >
      Ship...
    </button>
  );
}

export function HierarchySidebar({
  hosts,
  sessions,
  selectedSessionId,
  selectedCwd,
  selectedHostId,
  refreshKey,
  systemsHosts,
  onOpenEffort,
  onSelectWorkspace,
  onWorkspaceRemoved,
  onShip,
  onSelectSession,
  onOpenLinkedSession,
  onOpenPlanning,
  onAddProject,
  onNewWorkspace,
  buildingWorkspaceProjects,
  hostUnavailableReason,
  onProjects,
  onSnapshots,
  onChanged,
  searchQuery,
  matchedSessionIds,
  runningOnly,
  runningSessionIds,
  awaitingInputIds,
  unreadSessionIds,
  hasUndismissedExit,
  collapsedHosts,
  onToggleHost,
}: Props) {
  const { t } = useI18n();
  const connectedHosts = hosts.filter(
    (host) => host.status && isLinkUp(host.status),
  );
  const ungroupedHostId =
    connectedHosts.length === 1
      ? connectedHosts[0].id
      : hosts.length === 1
        ? hosts[0].id
        : null;
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(
    () => new Set(),
  );
  const sidebarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismissMenus = (event: PointerEvent) => {
      sidebarRef.current
        ?.querySelectorAll<HTMLDetailsElement>(
          "details[open]:not([data-persistent])",
        )
        .forEach((menu) => {
          if (event.target instanceof Node && !menu.contains(event.target))
            menu.open = false;
        });
    };
    document.addEventListener("pointerdown", dismissMenus);
    return () => document.removeEventListener("pointerdown", dismissMenus);
  }, []);
  const [snapshots, setSnapshots] = useState<Record<string, HierarchySnapshot>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const loadGenerations = useRef<Record<string, number>>({});
  const completedLoadGenerations = useRef<Record<string, number>>({});
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [managedProject, setManagedProject] = useState<{
    host: string;
    project: HierarchyProject;
  } | null>(null);
  const [managerCreations, setManagerCreations] = useState<
    Partial<Record<string, WorkspaceCreationJob | "starting">>
  >({});
  const setupObservers = useRef(
    new Map<string, { controller: AbortController; blocking: boolean }>(),
  );
  useEffect(() => {
    const observers = setupObservers.current;
    return () => {
      for (const { controller } of observers.values()) controller.abort();
      observers.clear();
    };
  }, []);
  const [settingsProject, setSettingsProject] = useState<{
    host: string;
    project: HierarchyProject;
  } | null>(null);
  const [projectSettingsPending, setProjectSettingsPending] = useState(false);
  const [openWorkspaceMenu, setOpenWorkspaceMenu] = useState<string | null>(
    null,
  );
  const [finishTarget, setFinishTarget] = useState<{
    host: string;
    projectPath: string;
    path: string;
  } | null>(null);
  const [finishingWorkspace, setFinishingWorkspace] = useState<string | null>(
    null,
  );
  const [deletingWorkspace, setDeletingWorkspace] = useState<string | null>(
    null,
  );
  const finishAbort = useRef<AbortController | null>(null);
  useEffect(() => () => finishAbort.current?.abort(), []);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const confirmationRef = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(() => () => confirmationRef.current?.(false), []);
  const confirmAction = (
    title: string,
    description: string,
    confirmLabel: string,
  ) =>
    new Promise<boolean>((resolve) => {
      if (confirmationRef.current) return resolve(false);
      confirmationRef.current = resolve;
      setConfirmation({ title, description, confirmLabel, resolve });
    });
  const finishConfirmation = (confirmed: boolean) => {
    if (!confirmation) return;
    confirmationRef.current = null;
    setConfirmation(null);
    confirmation.resolve(confirmed);
  };
  const [branchChoice, setBranchChoice] = useState<{
    branch: string | undefined;
    resolve: (choice: boolean | null) => void;
  } | null>(null);
  const branchChoiceRef = useRef<((choice: boolean | null) => void) | null>(
    null,
  );
  useEffect(() => () => branchChoiceRef.current?.(null), []);
  const chooseBranch = (branch: string | undefined) =>
    new Promise<boolean | null>((resolve) => {
      branchChoiceRef.current = resolve;
      setBranchChoice({ branch, resolve });
    });
  const finishBranchChoice = (choice: boolean | null) => {
    if (!branchChoice) return;
    branchChoiceRef.current = null;
    setBranchChoice(null);
    branchChoice.resolve(choice);
  };
  const stoppingMonitors = useRef(new Set<string>());
  const [pendingMonitorStops, setPendingMonitorStops] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const stopMonitoring = async (target: {
    host: string;
    projectPath: string;
    path: string;
    monitorId: string;
  }) => {
    const key = hostProjectKey(target.host, target.path);
    if (stoppingMonitors.current.has(key)) return;
    stoppingMonitors.current.add(key);
    setPendingMonitorStops(new Set(stoppingMonitors.current));
    try {
      const response = await fetch("/api/ship/monitor/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `Request failed (${response.status})`);
      }
      await load();
      onChanged();
    } catch (error) {
      toast.error(
        "Couldn't stop PR monitoring",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      stoppingMonitors.current.delete(key);
      setPendingMonitorStops(new Set(stoppingMonitors.current));
    }
  };
  const finishShip = async () => {
    if (!finishTarget || finishAbort.current) return;
    const abort = new AbortController();
    finishAbort.current = abort;
    setFinishingWorkspace(hostProjectKey(finishTarget.host, finishTarget.path));
    setFinishTarget(null);
    try {
      const response = await fetch("/api/ship/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finishTarget),
        signal: abort.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Cleanup failed");
      await load();
      onChanged();
    } catch (error) {
      if (!abort.signal.aborted)
        toast.error(
          "Cleanup failed",
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      finishAbort.current = null;
      setFinishingWorkspace(null);
    }
  };
  useEffect(() => {
    onProjects(
      Object.entries(snapshots).flatMap(([hostId, snapshot]) =>
        snapshot.projects.flatMap((project) =>
          project.workspaces.map((workspace) => ({
            path: workspace.path,
            hostId,
            name: workspace.name,
            projectId: project.id,
            workspaceId: workspace.id,
            projectPath: project.path,
            projectName: project.alias ?? project.name,
            projectKind: project.kind,
            isDefaultWorkspace: workspace.isDefault,
            addedAt: project.addedAt,
            launchConfig: project.launchConfig,
          })),
        ),
      ),
    );
  }, [snapshots, onProjects]);
  useEffect(() => {
    onSnapshots(snapshots);
  }, [snapshots, onSnapshots]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    await Promise.all(
      hosts.map(async (host) => {
        const generation = (loadGenerations.current[host.id] ?? 0) + 1;
        loadGenerations.current[host.id] = generation;
        try {
          const response = await fetch(
            `/api/hierarchy?${new URLSearchParams({ host: host.id })}`,
          );
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error ?? `HTTP ${response.status}`);
          if ((completedLoadGenerations.current[host.id] ?? 0) > generation)
            return;
          completedLoadGenerations.current[host.id] = generation;
          setSnapshots((prev) => ({ ...prev, [host.id]: data }));
          setLoadErrors((prev) => {
            if (!(host.id in prev)) return prev;
            const next = { ...prev };
            delete next[host.id];
            return next;
          });
        } catch (e) {
          if ((completedLoadGenerations.current[host.id] ?? 0) > generation)
            return;
          completedLoadGenerations.current[host.id] = generation;
          setLoadErrors((prev) => ({
            ...prev,
            [host.id]: e instanceof Error ? e.message : String(e),
          }));
        }
      }),
    );
  }, [hosts]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    const refresh = () => {
      void load();
    };
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);
  async function createWorkspace(
    hostId: string,
    input: WorkspaceCreateRequest,
  ) {
    const key = hostProjectKey(hostId, input.projectPath);
    const previous = setupObservers.current.get(key);
    if (previous?.blocking) return;
    previous?.controller.abort();
    const controller = new AbortController();
    const { signal } = controller;
    const observer = { controller, blocking: true };
    setupObservers.current.set(key, observer);
    setManagerCreations((jobs) => ({ ...jobs, [key]: "starting" }));
    try {
      const response = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, action: "create", input }),
        signal,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      let job: WorkspaceCreationJob = data;
      let registered = false;
      while (!signal.aborted) {
        observer.blocking =
          job.status === "running" && job.stage !== "postNonBlocking";
        const snapshot = job;
        setManagerCreations((jobs) => ({ ...jobs, [key]: snapshot }));
        if (job.status !== "running") {
          void load();
          if (job.workspaceId) onChanged();
          if (job.error) toast.error("Workspace setup failed", job.error);
          break;
        }
        if (job.workspaceId && !registered) {
          registered = true;
          void load();
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 1000);
        await promise;
        if (signal.aborted) break;
        job = await readWorkspaceSetupJob(hostId, job.id, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        setManagerCreations((jobs) => ({ ...jobs, [key]: undefined }));
        toast.error(
          "Couldn't track workspace setup",
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (setupObservers.current.get(key) === observer)
        setupObservers.current.delete(key);
    }
  }
  const operate = async (host: string, input: HierarchyRequest) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/hierarchy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, input }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      setSnapshots((prev) => ({ ...prev, [host]: data }));
      if (
        input.action !== "discoverWorkspaces" &&
        input.action !== "discoverSessions"
      )
        onChanged();
      return data as HierarchySnapshot;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const discover = async (
    host: string,
    project: HierarchyProject,
    workspaceId?: string,
  ) => {
    const result = await operate(
      host,
      workspaceId
        ? { action: "discoverSessions", workspaceId }
        : { action: "discoverWorkspaces", projectId: project.id },
    );
    if (result) {
      setChecked(new Set());
      setDiscovery({
        host,
        projectId: project.id,
        workspaceId,
        snapshot: result,
      });
    }
  };
  const unregisterWorkspace = async (
    hostId: string,
    projectPath: string,
    path: string,
  ) => {
    if (
      !(await confirmAction(
        "Delete workspace?",
        "Unregister this workspace and remove its checkout? Running processes and uncommitted changes require separate approval. Session history is kept.",
        "Delete workspace",
      ))
    )
      return;
    setBusy(true);
    setError(null);
    let stopProcesses = false;
    let discardChanges = false;
    let keepBranch: boolean | undefined;
    let cancel = false;
    try {
      while (true) {
        setDeletingWorkspace(hostProjectKey(hostId, path));
        const response = await fetch("/api/worktrees", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hostId,
            action: "delete",
            input: {
              projectPath,
              path,
              stopProcesses,
              discardChanges,
              keepBranch,
              cancel,
            },
          }),
        });
        const result: WorkspaceDeleteResult & { error?: string } =
          await response.json();
        if (!response.ok)
          throw new Error(result.error ?? `HTTP ${response.status}`);
        if (
          result.status === "processes" ||
          result.status === "dirty" ||
          result.status === "branch"
        )
          setDeletingWorkspace(null);
        if (result.status === "processes") {
          const processes =
            result.processes
              ?.map((p) => {
                const session = sessions.find(
                  (s) => s.id === p.id && (s.hostId ?? "local") === hostId,
                );
                const title =
                  session?.name?.trim() || session?.firstMessage?.trim();
                return title
                  ? `Session: ${title.slice(0, 120)}\n  Working directory: ${p.cwd}`
                  : `Unidentified session or terminal (ID: ${p.id})\n  Working directory: ${p.cwd}`;
              })
              .join("\n\n") ?? "";
          stopProcesses = await confirmAction(
            "Stop running processes?",
            `Deleting this workspace will stop these sessions or terminals:\n\n${processes}\n\nStop them and continue?`,
            "Stop and continue",
          );
          cancel = !stopProcesses;
        } else if (result.status === "dirty") {
          discardChanges = await confirmAction(
            "Discard uncommitted changes?",
            "Previously stopped sessions remain stopped if you cancel.",
            "Discard and continue",
          );
          cancel = !discardChanges;
        } else if (result.status === "branch") {
          const choice = await chooseBranch(result.branch);
          if (choice === null) cancel = true;
          else keepBranch = choice;
        } else {
          await load();
          if (result.status === "deleted") {
            onWorkspaceRemoved(path, hostId);
            onChanged();
          }
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingWorkspace(null);
      setBusy(false);
    }
  };
  const confirmForget = (what: string) =>
    confirmAction(
      "Unregister?",
      `Unregister ${what}? Files and processes will not be deleted.`,
      "Unregister",
    );
  const query = searchQuery.trim().toLowerCase();
  const searching = Boolean(query);
  const hostExpanded = (id: string) =>
    searching || id === ungroupedHostId || !collapsedHosts.has(id);
  const button = {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg-panel)",
    color: "var(--text-muted)",
    padding: "3px 6px",
    cursor: "pointer",
    fontSize: 11,
  } as const;
  const menu = {
    position: "absolute",
    right: 0,
    zIndex: 10,
    display: "flex",
    gap: 4,
    padding: 4,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    boxShadow: "var(--shadow-pop)",
  } as const;
  const menuButton = {
    ...button,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 6,
  } as const;
  const repoMenuButton = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    borderRadius: "var(--radius-control)",
    color: "var(--text)",
    fontSize: 13,
    whiteSpace: "nowrap",
  } as const;
  const rowButton = {
    ...button,
    border: "none",
    background: "transparent",
    color: "var(--text)",
    textAlign: "left",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: 1,
  } as const;
  const currentManagedProject =
    managedProject &&
    (snapshots[managedProject.host]?.projects.find(
      (project) => project.id === managedProject.project.id,
    ) ??
      managedProject.project);
  const workspaceConfirmations = (
    <>
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) finishConfirmation(false);
        }}
        title={confirmation?.title ?? ""}
        description={confirmation?.description}
        confirmLabel={confirmation?.confirmLabel ?? "Confirm"}
        danger
        onConfirm={() => finishConfirmation(true)}
      />
      <Dialog
        open={branchChoice !== null}
        onOpenChange={(open) => {
          if (!open) finishBranchChoice(null);
        }}
      >
        <DialogContent
          style={{ width: 420, maxWidth: "min(92vw, 420px)", padding: 22 }}
        >
          <DialogTitle>Keep or delete branch?</DialogTitle>
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: 13,
              lineHeight: 1.55,
            }}
          >
            Branch {branchChoice?.branch ?? "for this workspace"} is not
            confirmed merged. Choose whether to keep it or delete it along with
            the workspace.
          </p>
          <div
            className="dialog-actions"
            style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
          >
            <button
              type="button"
              className="dialog-action"
              style={{
                padding: "6px 14px",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
              }}
              onClick={() => finishBranchChoice(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dialog-action"
              style={{
                padding: "6px 14px",
                background: "var(--accent-strong)",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: "var(--on-accent)",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
              }}
              onClick={() => finishBranchChoice(true)}
            >
              Keep branch
            </button>
            <button
              type="button"
              className="dialog-action"
              style={{
                padding: "6px 14px",
                background: "var(--status-error)",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: "var(--on-accent)",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
              }}
              onClick={() => finishBranchChoice(false)}
            >
              Delete branch
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
  return (
    <div ref={sidebarRef} style={{ fontSize: 12, color: "var(--text)" }}>
      <ConfirmDialog
        open={finishTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFinishTarget(null);
        }}
        title="Clean up merged workspace?"
        description="Archive its sessions and delete the workspace and branch."
        confirmLabel="Clean up"
        cancelLabel="Cancel"
        onConfirm={() => void finishShip()}
      />
      {error && (
        <div role="alert" style={{ color: "var(--status-error)", padding: 8 }}>
          {error}
        </div>
      )}
      {hosts.map(
        (host) =>
          loadErrors[host.id] && (
            <div
              key={host.id}
              role="alert"
              style={{ color: "var(--status-error)", padding: 8 }}
            >
              {loadErrors[host.id]}
            </div>
          ),
      )}
      {hosts.map((host) => (
        <section key={host.id} style={{ marginBottom: 8 }}>
          {host.id !== ungroupedHostId && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                padding: "4px 0 2px",
              }}
            >
              <button
                type="button"
                className="ui-focus-ring"
                aria-expanded={hostExpanded(host.id)}
                aria-disabled={searching || undefined}
                onClick={searching ? undefined : () => onToggleHost(host.id)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 4px",
                  border: 0,
                  borderRadius: 6,
                  background: "none",
                  color: "var(--text-muted)",
                  fontSize: 13,
                  fontWeight: 600,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <ChevronRight
                  size={12}
                  aria-hidden="true"
                  style={{
                    flexShrink: 0,
                    transform: hostExpanded(host.id)
                      ? "rotate(90deg)"
                      : undefined,
                  }}
                />
                <Server
                  size={14}
                  aria-hidden="true"
                  style={{ flexShrink: 0 }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {host.label || "This machine"}
                </span>
              </button>
            </div>
          )}
          {hostExpanded(host.id) && (
            <SidebarSectionHeader
              label={t("projects.heading")}
              disclosure={{
                expanded: searching || !collapsedRepos.has(host.id),
                onToggle: searching
                  ? undefined
                  : () =>
                      setCollapsedRepos((current) => {
                        const next = new Set(current);
                        if (next.has(host.id)) next.delete(host.id);
                        else next.add(host.id);
                        return next;
                      }),
              }}
            >
              <SidebarIconButton
                label={
                  host.id === ungroupedHostId
                    ? t("projects.add")
                    : t("projects.addOnHost", {
                        host: host.label || "This machine",
                      })
                }
                title={t("projects.addTitle")}
                onClick={() => onAddProject(host.id)}
              >
                <Plus aria-hidden="true" />
              </SidebarIconButton>
            </SidebarSectionHeader>
          )}
          {hostExpanded(host.id) &&
            (searching || !collapsedRepos.has(host.id)) &&
            (snapshots[host.id]?.projects ?? []).map((project) => {
              const projectMatch =
                !!query &&
                `${project.alias ?? ""} ${project.name} ${project.path}`
                  .toLowerCase()
                  .includes(query);
              const workspaces = project.workspaces.filter(
                (workspace) =>
                  (!runningOnly ||
                    (selectedHostId === host.id &&
                      selectedCwd === workspace.path) ||
                    workspace.sessionIds.some((id) =>
                      runningSessionIds.has(id),
                    )) &&
                  (!query ||
                    projectMatch ||
                    `${workspace.name} ${workspace.path} ${workspace.branch ?? ""}`
                      .toLowerCase()
                      .includes(query) ||
                    workspace.sessionIds.some((id) =>
                      matchedSessionIds?.has(id),
                    )),
              );
              if (!workspaces.length) return null;
              const defaultWorkspace = project.workspaces.find(
                (workspace) => workspace.isDefault,
              );
              const unavailableReason =
                hostUnavailableReason?.(host.id) ?? null;
              const projectKey = hostProjectKey(host.id, project.path);
              const creation = managerCreations[projectKey];
              const buildingFromManager =
                creation === "starting" ||
                (creation?.status === "running" &&
                  !project.workspaces.some(
                    (workspace) => workspace.id === creation.workspaceId,
                  ));
              return (
                <div key={project.id} style={{ marginBottom: 4 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "5px 4px",
                      fontWeight: 600,
                    }}
                  >
                    <ProjectIcon project={project} />
                    <span
                      title={project.path}
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {project.alias || project.name}
                    </span>
                    {(buildingFromManager ||
                      buildingWorkspaceProjects?.has(projectKey)) && (
                      <PendingOperation compact label="Building workspace…" />
                    )}
                    <button
                      type="button"
                      aria-label={`New ${project.kind === "git" ? "workspace" : "session"} in ${project.alias || project.name}`}
                      title={
                        unavailableReason ??
                        `New ${project.kind === "git" ? "workspace" : "session"}`
                      }
                      disabled={!defaultWorkspace || unavailableReason !== null}
                      style={{ ...button, padding: "3px 6px" }}
                      onClick={() => {
                        if (!defaultWorkspace) return;
                        onNewWorkspace({
                          path: defaultWorkspace.path,
                          hostId: host.id,
                          name: defaultWorkspace.name,
                          projectId: project.id,
                          workspaceId: defaultWorkspace.id,
                          projectPath: project.path,
                          projectName: project.alias ?? project.name,
                          projectKind: project.kind,
                          isDefaultWorkspace: defaultWorkspace.isDefault,
                          addedAt: project.addedAt,
                          launchConfig: project.launchConfig,
                        });
                      }}
                    >
                      <Plus size={14} />
                    </button>
                    <details style={{ position: "relative" }}>
                      <summary
                        aria-label={`Actions for repo ${project.alias || project.name}`}
                        style={{
                          cursor: "pointer",
                          listStyle: "none",
                          padding: "3px 6px",
                        }}
                      >
                        <MoreHorizontal size={16} aria-hidden="true" />
                      </summary>
                      <div
                        style={{
                          ...menu,
                          flexDirection: "column",
                          width: "max-content",
                        }}
                      >
                        <button
                          className="sidebar-menu-item"
                          style={repoMenuButton}
                          type="button"
                          aria-label="Repo settings"
                          title="Repo settings"
                          onClick={(e) => {
                            e.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                            setSettingsProject({ host: host.id, project });
                          }}
                        >
                          <Wrench size={16} aria-hidden="true" /> Repo settings
                        </button>
                        <button
                          className="sidebar-menu-item"
                          style={repoMenuButton}
                          type="button"
                          onClick={(event) => {
                            event.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                            onOpenPlanning?.({
                              host: host.id,
                              owner: { kind: "repo", id: project.id },
                              onChanged,
                              onOpenTarget: ({ path }) => {
                                if (path) onSelectWorkspace(path, host.id);
                              },
                              onOpenChat: onOpenLinkedSession,
                            });
                          }}
                        >
                          <ClipboardList size={16} aria-hidden="true" /> Repo
                          Notes &amp; Tasks
                        </button>
                        {project.kind === "git" && (
                          <button
                            className="sidebar-menu-item"
                            style={repoMenuButton}
                            type="button"
                            aria-label="Manage workspaces"
                            title="Manage workspaces"
                            onClick={(e) => {
                              e.currentTarget
                                .closest("details")
                                ?.removeAttribute("open");
                              setManagedProject({ host: host.id, project });
                            }}
                          >
                            <FolderCog size={16} aria-hidden="true" /> Manage
                            workspaces
                          </button>
                        )}
                        {project.kind === "git" && (
                          <button
                            className="sidebar-menu-item"
                            style={repoMenuButton}
                            type="button"
                            aria-label="Import workspaces"
                            title="Import workspaces"
                            disabled={busy}
                            onClick={(e) => {
                              e.currentTarget
                                .closest("details")
                                ?.removeAttribute("open");
                              void discover(host.id, project);
                            }}
                          >
                            <FolderInput size={16} aria-hidden="true" /> Import
                            workspaces
                          </button>
                        )}
                        <button
                          className="sidebar-menu-item"
                          style={repoMenuButton}
                          type="button"
                          aria-label="Unregister repo"
                          title="Unregister repo"
                          disabled={busy}
                          onClick={(e) => {
                            e.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                            void confirmForget(
                              "this repo and its registrations",
                            ).then((confirmed) => {
                              if (confirmed)
                                void operate(host.id, {
                                  action: "unregisterProject",
                                  projectId: project.id,
                                });
                            });
                          }}
                        >
                          <Trash2 size={16} aria-hidden="true" /> Unregister
                          repo
                        </button>
                      </div>
                    </details>
                  </div>
                  {workspaces.map((workspace) => {
                    const runningCount = workspace.sessionIds.filter((id) =>
                      runningSessionIds.has(id),
                    ).length;
                    const workspaceSessions = sessions.filter(
                      (session) =>
                        (session.hostId ?? LOCAL_HOST_ID) === host.id &&
                        workspace.sessionIds.includes(session.id),
                    );
                    const latestSession = workspaceSessions.sort((a, b) =>
                      (b.lastMessageAt ?? b.modified).localeCompare(
                        a.lastMessageAt ?? a.modified,
                      ),
                    )[0];
                    const needsAttention = workspaceSessions.some(
                      ({ id }) =>
                        awaitingInputIds.has(id) ||
                        unreadSessionIds.has(id) ||
                        hasUndismissedExit(id),
                    );
                    const workspaceKey = hostProjectKey(
                      host.id,
                      workspace.path,
                    );
                    const monitor = workspace.ship?.pr?.monitor;
                    const stoppingMonitor =
                      pendingMonitorStops.has(workspaceKey);
                    const deleting = deletingWorkspace === workspaceKey;
                    const cleaningUp =
                      finishingWorkspace === workspaceKey ||
                      (workspace.ship?.job?.status === "running" &&
                        workspace.ship.job.kind === "finish");
                    const setup =
                      creation &&
                      creation !== "starting" &&
                      (creation.id === workspace.setup?.jobId ||
                        (!workspace.setup &&
                          creation.workspaceId === workspace.id))
                        ? creation
                        : workspace.setup;
                    const pr = workspace.ship?.pr;
                    const prLink = pr?.state === "open" && (
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        title={`Checks: ${pr.checks}`}
                        style={{
                          fontSize: 11,
                          whiteSpace: "nowrap",
                          color: "var(--text)",
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            color:
                              pr.checks === "passing"
                                ? "var(--status-success)"
                                : pr.checks === "failing"
                                  ? "var(--status-error)"
                                  : "var(--status-warning)",
                          }}
                        >
                          ●
                        </span>{" "}
                        PR #{pr.number}
                        {monitor &&
                          (monitor.state === "watching"
                            ? " · Monitoring"
                            : monitor.state === "error"
                              ? " · Monitoring error"
                              : " · Delivery expired")}
                      </a>
                    );
                    return (
                      <div key={workspace.id} style={{ marginLeft: 12 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "4px 6px",
                            borderRadius: "var(--radius-control)",
                            background:
                              selectedHostId === host.id &&
                              selectedCwd === workspace.path
                                ? "var(--bg-selected)"
                                : "transparent",
                          }}
                        >
                          <button
                            style={rowButton}
                            type="button"
                            title={workspace.path}
                            disabled={workspace.unavailable}
                            aria-pressed={
                              selectedHostId === host.id &&
                              selectedCwd === workspace.path
                            }
                            onClick={() =>
                              onSelectWorkspace(
                                workspace.path,
                                host.id,
                                latestSession,
                              )
                            }
                          >
                            {workspace.name}
                            {workspace.unavailable ? " (unavailable)" : ""}
                          </button>
                          {deleting ? (
                            <PendingOperation label="Deleting…" />
                          ) : cleaningUp ? (
                            <PendingOperation label="Cleaning up…" />
                          ) : workspace.ship?.job?.status === "running" ? (
                            <span
                              title="Shipping"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 3,
                                fontSize: 11,
                                flexShrink: 0,
                              }}
                            >
                              <Loader2 size={12} className="animate-spin" />{" "}
                              Shipping...
                            </span>
                          ) : pr?.state === "open" ? (
                            monitor ? null : (
                              prLink
                            )
                          ) : workspace.ship?.pr?.state === "merged" ? (
                            <span
                              style={{ fontSize: 11, whiteSpace: "nowrap" }}
                            >
                              Merged{" "}
                              <button
                                type="button"
                                disabled={busy || finishingWorkspace !== null}
                                onClick={() =>
                                  setFinishTarget({
                                    host: host.id,
                                    projectPath: project.path,
                                    path: workspace.path,
                                  })
                                }
                              >
                                Clean up
                              </button>
                            </span>
                          ) : workspace.ship?.pr?.state === "closed" ? (
                            <span
                              style={{ fontSize: 11, whiteSpace: "nowrap" }}
                            >
                              PR closed
                            </span>
                          ) : null}
                          {runningCount > 0 && (
                            <span
                              title={`${runningCount} running agents`}
                              aria-label={`${runningCount} running agents`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 3,
                                flexShrink: 0,
                              }}
                            >
                              <Bot size={14} aria-hidden="true" />
                              {runningCount}
                            </span>
                          )}
                          {needsAttention && (
                            <span
                              title="Attention required"
                              aria-label="Attention required"
                              style={{
                                color: "var(--status-warning)",
                                padding: "0 4px",
                              }}
                            >
                              <AlertCircle size={14} aria-hidden="true" />
                            </span>
                          )}
                          {setup?.status === "running" ? (
                            <PendingOperation
                              compact
                              label="Setting up workspace…"
                            />
                          ) : setup && setup.status !== "complete" ? (
                            <span
                              title={setup.error || `Setup ${setup.status}`}
                              aria-label={`Setup ${setup.status}`}
                            >
                              <Wrench size={14} aria-hidden="true" />
                            </span>
                          ) : null}
                          <details
                            style={{ position: "relative" }}
                            onToggle={(e) =>
                              setOpenWorkspaceMenu(
                                e.currentTarget.open
                                  ? `${host.id}:${workspace.path}`
                                  : null,
                              )
                            }
                          >
                            <summary
                              aria-label={`Actions for workspace ${workspace.name}`}
                              style={{
                                cursor: "pointer",
                                listStyle: "none",
                                padding: "3px 6px",
                              }}
                            >
                              <MoreHorizontal size={16} aria-hidden="true" />
                            </summary>
                            <div style={menu}>
                              {!workspace.isDefault &&
                                project.kind === "git" && (
                                  <SidebarShipButton
                                    style={menuButton}
                                    host={host.id}
                                    projectPath={project.path}
                                    path={workspace.path}
                                    sessionId={latestSession?.id}
                                    open={
                                      openWorkspaceMenu ===
                                      `${host.id}:${workspace.path}`
                                    }
                                    disabled={
                                      workspace.unavailable ||
                                      !latestSession ||
                                      runningSessionIds.has(latestSession.id)
                                    }
                                    onClick={() => {
                                      if (latestSession) {
                                        onSelectWorkspace(
                                          workspace.path,
                                          host.id,
                                          latestSession,
                                        );
                                        onShip?.({
                                          host: host.id,
                                          projectPath: project.path,
                                          path: workspace.path,
                                          sessionId: latestSession.id,
                                        });
                                      }
                                    }}
                                  />
                                )}
                              <button
                                style={menuButton}
                                type="button"
                                aria-label="Import sessions"
                                title="Import sessions"
                                disabled={busy || workspace.unavailable}
                                onClick={(e) => {
                                  e.currentTarget
                                    .closest("details")
                                    ?.removeAttribute("open");
                                  void discover(host.id, project, workspace.id);
                                }}
                              >
                                <FolderInput size={16} aria-hidden="true" />
                              </button>
                              {!workspace.isDefault && (
                                <button
                                  style={menuButton}
                                  type="button"
                                  aria-label="Unregister workspace"
                                  title="Unregister workspace"
                                  disabled={
                                    busy ||
                                    cleaningUp ||
                                    setup?.status === "running"
                                  }
                                  onClick={(e) => {
                                    e.currentTarget
                                      .closest("details")
                                      ?.removeAttribute("open");
                                    void unregisterWorkspace(
                                      host.id,
                                      project.path,
                                      workspace.path,
                                    );
                                  }}
                                >
                                  <Trash2 size={16} aria-hidden="true" />
                                </button>
                              )}
                            </div>
                          </details>
                        </div>
                        {pr?.state === "open" &&
                          monitor &&
                          !deleting &&
                          !cleaningUp &&
                          workspace.ship?.job?.status !== "running" && (
                            <div
                              style={{
                                display: "flex",
                                gap: 8,
                                alignItems: "center",
                                paddingLeft: 10,
                              }}
                            >
                              {prLink}
                              <SidebarIconButton
                                label={
                                  stoppingMonitor
                                    ? "Stopping monitoring"
                                    : "Stop monitoring"
                                }
                                disabled={busy || stoppingMonitor}
                                onClick={() =>
                                  void stopMonitoring({
                                    host: host.id,
                                    projectPath: project.path,
                                    path: workspace.path,
                                    monitorId: monitor.id,
                                  })
                                }
                              >
                                {stoppingMonitor ? (
                                  <Loader2
                                    size={14}
                                    className="animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <BellOff size={14} aria-hidden="true" />
                                )}
                              </SidebarIconButton>
                            </div>
                          )}
                        {query &&
                          workspace.sessionIds
                            .filter((id) => matchedSessionIds?.has(id))
                            .map((id) => {
                              const session = sessions.find(
                                (item) =>
                                  item.id === id &&
                                  (item.hostId ?? "local") === host.id,
                              );
                              return (
                                <div
                                  key={id}
                                  style={{
                                    marginLeft: 18,
                                    display: "flex",
                                    alignItems: "center",
                                    background:
                                      selectedSessionId === id
                                        ? "var(--bg-selected)"
                                        : undefined,
                                  }}
                                >
                                  <button
                                    style={rowButton}
                                    type="button"
                                    disabled={!session || workspace.unavailable}
                                    aria-current={
                                      selectedSessionId === id
                                        ? "true"
                                        : undefined
                                    }
                                    onClick={() => {
                                      if (session) {
                                        onSelectWorkspace(
                                          workspace.path,
                                          host.id,
                                        );
                                        onSelectSession(session);
                                      }
                                    }}
                                  >
                                    {session?.name ||
                                      session?.firstMessage ||
                                      id}
                                  </button>
                                  <details style={{ position: "relative" }}>
                                    <summary
                                      aria-label={`Actions for session ${session?.name || session?.firstMessage || id}`}
                                      style={{
                                        cursor: "pointer",
                                        listStyle: "none",
                                        padding: "3px 6px",
                                      }}
                                    >
                                      <MoreHorizontal
                                        size={16}
                                        aria-hidden="true"
                                      />
                                    </summary>
                                    <div style={menu}>
                                      <button
                                        style={menuButton}
                                        type="button"
                                        aria-label="Unregister session"
                                        title="Unregister session"
                                        disabled={busy}
                                        onClick={(e) => {
                                          e.currentTarget
                                            .closest("details")
                                            ?.removeAttribute("open");
                                          void confirmForget(
                                            "this session",
                                          ).then((confirmed) => {
                                            if (confirmed)
                                              void operate(host.id, {
                                                action: "unregisterSession",
                                                workspaceId: workspace.id,
                                                sessionId: id,
                                              });
                                          });
                                        }}
                                      >
                                        <Trash2 size={16} aria-hidden="true" />
                                      </button>
                                    </div>
                                  </details>
                                </div>
                              );
                            })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          {hostExpanded(host.id) && (
            <SystemsSidebar
              host={{
                id: host.id,
                name: host.label || t("hostsConfig.thisMachine"),
              }}
              state={systemsHosts.byHost[host.id]}
              action={(input) => systemsHosts.run(host.id, input)}
              repos={(snapshots[host.id]?.projects ?? [])
                .filter((project) => project.kind === "git")
                .map((project) => ({
                  path: project.path,
                  name: project.alias ?? project.name,
                }))}
              selectedPath={selectedHostId === host.id ? selectedCwd : null}
              query={query}
              runningOnly={runningOnly}
              runningIds={runningSessionIds}
              matchedIds={matchedSessionIds}
              unavailable={hostUnavailableReason?.(host.id)}
              onOpenEffort={(effort, navigate) => {
                const latest = navigate
                  ? sessions
                      .filter(
                        (session) =>
                          (session.hostId ?? LOCAL_HOST_ID) === host.id &&
                          effort.sessionIds.includes(session.id) &&
                          session.cwd === effort.root,
                      )
                      .sort((a, b) =>
                        (b.lastMessageAt ?? b.modified).localeCompare(
                          a.lastMessageAt ?? a.modified,
                        ),
                      )[0]
                  : undefined;
                onOpenEffort(host.id, effort, navigate, latest);
              }}
              onOpenLinkedSession={onOpenLinkedSession}
              onOpenPlanning={onOpenPlanning}
              onChanged={onChanged}
            />
          )}
        </section>
      ))}
      {settingsProject && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !projectSettingsPending) setSettingsProject(null);
          }}
        >
          <DialogContent
            style={{
              width: 850,
              maxWidth: "calc(100vw - 24px)",
              maxHeight: "calc(100dvh - 24px)",
              overflowY: "auto",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                paddingBottom: 16,
                marginBottom: 16,
                borderBottom: "1px solid var(--border)",
              }}
            >
              <DialogTitle style={{ margin: 0 }}>Repo settings</DialogTitle>
              <button
                type="button"
                className="dialog-action"
                disabled={projectSettingsPending}
                onClick={() => setSettingsProject(null)}
                style={{
                  padding: "6px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--text)",
                  background: "var(--bg-panel)",
                  cursor: projectSettingsPending ? "not-allowed" : "pointer",
                  opacity: projectSettingsPending ? 0.5 : 1,
                  fontSize: 13,
                }}
              >
                Close
              </button>
            </div>
            <ProjectSettings
              key={`${settingsProject.host}:${settingsProject.project.id}`}
              hostId={settingsProject.host}
              project={settingsProject.project}
              onPendingChange={setProjectSettingsPending}
              onUpdated={(snapshot) => {
                const host = settingsProject.host;
                setSnapshots((previous) => ({ ...previous, [host]: snapshot }));
                setSettingsProject((previous) => {
                  if (
                    !previous ||
                    previous.host !== host ||
                    previous.project.id !== settingsProject.project.id
                  )
                    return previous;
                  const project = snapshot.projects.find(
                    (item) => item.id === previous.project.id,
                  );
                  return project ? { ...previous, project } : previous;
                });
                onChanged();
              }}
            />
          </DialogContent>
        </Dialog>
      )}
      {!managedProject && workspaceConfirmations}
      {managedProject && currentManagedProject && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setManagedProject(null);
          }}
        >
          <DialogContent>
            <DialogTitle>Manage workspaces</DialogTitle>
            <WorktreesPanel
              hostId={managedProject.host}
              project={currentManagedProject}
              currentPath={
                selectedHostId === managedProject.host ? selectedCwd : null
              }
              creation={
                managerCreations[
                  hostProjectKey(
                    managedProject.host,
                    currentManagedProject.path,
                  )
                ]
              }
              deletionDisabled={busy || finishingWorkspace !== null}
              removingPath={
                currentManagedProject.workspaces.find(
                  (workspace) =>
                    hostProjectKey(managedProject.host, workspace.path) ===
                    deletingWorkspace,
                )?.path
              }
              onCreate={(input) =>
                void createWorkspace(managedProject.host, input)
              }
              onRemove={(path) =>
                void unregisterWorkspace(
                  managedProject.host,
                  currentManagedProject.path,
                  path,
                )
              }
              onSelect={(path) => {
                onSelectWorkspace(path, managedProject.host);
                setManagedProject(null);
              }}
            />
            {workspaceConfirmations}
          </DialogContent>
        </Dialog>
      )}
      {discovery && (
        <div
          role="dialog"
          aria-label={
            discovery.workspaceId ? "Import sessions" : "Import workspaces"
          }
          style={{
            padding: 10,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
          }}
        >
          <strong>
            {discovery.workspaceId ? "Import sessions" : "Import workspaces"}
          </strong>
          {(discovery.workspaceId
            ? (discovery.snapshot.sessionCandidates ?? []).map((s) => ({
                id: s.id,
                label: s.name || s.firstMessage || s.id,
              }))
            : (discovery.snapshot.workspaceCandidates ?? []).map((w) => ({
                id: w.path,
                label: w.branch ? `${w.name} (${w.branch})` : w.path,
              }))
          ).map((candidate) => (
            <label
              key={candidate.id}
              style={{ display: "block", padding: "4px 0" }}
            >
              <input
                type="checkbox"
                checked={checked.has(candidate.id)}
                onChange={(e) =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(candidate.id);
                    else next.delete(candidate.id);
                    return next;
                  })
                }
              />{" "}
              {candidate.label}
            </label>
          ))}
          <button
            style={button}
            type="button"
            disabled={busy || checked.size === 0}
            onClick={async () => {
              const result = await operate(
                discovery.host,
                discovery.workspaceId
                  ? {
                      action: "importSessions",
                      workspaceId: discovery.workspaceId,
                      sessionIds: [...checked],
                    }
                  : {
                      action: "importWorkspaces",
                      projectId: discovery.projectId,
                      paths: [...checked],
                    },
              );
              if (result) setDiscovery(null);
            }}
          >
            Import selected
          </button>{" "}
          <button
            style={button}
            type="button"
            onClick={() => setDiscovery(null)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
