"use client";

import { sessionKey } from "@/lib/session-identity";
import { useState } from "react";
import {
  ChevronRight,
  ClipboardList,
  MoreHorizontal,
  Plus,
  Settings2,
} from "lucide-react";
import type { EffortRecord, SystemRecord } from "@/lib/api-contracts/systems";
import { comparableProjectPath } from "@/lib/comparable-path";
import { effortStatusLabels } from "./EffortDetails";
import {
  SidebarIconButton,
  SidebarSectionHeader,
} from "./SessionSidebar-chrome";
import {
  systemsRequest,
  type SystemsHost,
  type SystemsAction,
} from "./SystemsHost";
import type { PlanningDestination } from "./SessionSidebar";
import {
  EffortCreator,
  EffortRootEditor,
  SystemEditor,
  SystemsButton,
  SystemsDialog,
  SystemsError,
  systemsMuted,
  systemsRow,
  systemsStack,
  useSystemsAction,
} from "./SystemsForms";

type Editor =
  | { kind: "root" | "new" }
  | { kind: "edit" | "archive" | "effort"; system: SystemRecord };

function ArchiveSystem({
  system,
  action,
  onClose,
}: {
  system: SystemRecord;
  action: SystemsAction;
  onClose: () => void;
}) {
  const { busy, error, run } = useSystemsAction(action);
  const label = system.archived ? "Restore System" : "Archive System";
  return (
    <SystemsDialog
      title={`${system.archived ? "Restore" : "Archive"} ${system.name}?`}
      busy={busy}
      onClose={onClose}
    >
      <div style={systemsStack}>
        <span>
          {system.archived
            ? "You can create new Efforts from this System again."
            : "Existing Efforts stay as they are. Restore the System before creating new Efforts."}
        </span>
        <SystemsError message={error} />
        <div style={systemsRow}>
          <SystemsButton
            disabled={busy}
            onClick={async () => {
              if (
                await run({
                  action: "archiveSystem",
                  id: system.id,
                  archived: !system.archived,
                })
              )
                onClose();
            }}
          >
            {busy ? "Saving…" : label}
          </SystemsButton>
          <SystemsButton disabled={busy} onClick={onClose}>
            Cancel
          </SystemsButton>
        </div>
      </div>
    </SystemsDialog>
  );
}

export function SystemsSidebar({
  host,
  state,
  action,
  repos,
  selectedPath,
  query,
  runningOnly,
  runningIds,
  matchedIds,
  unavailable,
  onOpenEffort,
  onOpenLinkedSession,
  onOpenPlanning,
  onChanged,
}: {
  host: { id: string; name: string };
  state?: SystemsHost;
  action: SystemsAction;
  repos: { path: string; name: string }[];
  selectedPath: string | null;
  query: string;
  runningOnly: boolean;
  runningIds: ReadonlySet<string>;
  matchedIds: ReadonlySet<string> | null;
  unavailable?: string | null;
  onOpenEffort: (effort: EffortRecord, navigate: boolean) => void;
  onOpenLinkedSession?: (sessionId: string) => void;
  onOpenPlanning?: (destination: PlanningDestination) => void;
  onChanged: () => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [systemExpansion, setSystemExpansion] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const [hidden, setHidden] = useState(false);
  const data = state?.data;
  const disabled = !data || !!unavailable || !!state?.error;
  const close = () => setEditor(null);
  const findEffort = (effort: EffortRecord) => {
    if (!selectedPath) return false;
    const path = comparableProjectPath(selectedPath);
    const root = comparableProjectPath(effort.root);
    return path === root || path.startsWith(`${root}/`);
  };
  const renderSystem = (system: SystemRecord) => {
    const systemMatch = `${system.name} ${system.repoPaths.join(" ")}`
      .toLowerCase()
      .includes(query);
    const systemEfforts =
      data?.efforts.filter((effort) => effort.systemId === system.id) ?? [];
    const efforts = systemEfforts.filter(
      (effort) =>
        (!runningOnly ||
          findEffort(effort) ||
          effort.sessionIds.some((id) =>
            runningIds.has(sessionKey(id, host.id)),
          ) ||
          effort.services.some(({ status }) => status === "running") ||
          effort.status === "creating" ||
          effort.status === "cleaning") &&
        (systemMatch ||
          `${effort.name} ${effort.root} ${effort.branch}`
            .toLowerCase()
            .includes(query) ||
          effort.sessionIds.some((id) =>
            matchedIds?.has(sessionKey(id, host.id)),
          )),
    );
    if ((runningOnly || !systemMatch) && !efforts.length) return null;
    const forcedOpen = Boolean(query) || runningOnly;
    const allDefault = systemEfforts.every((effort) =>
      effort.members.every(
        (member) =>
          !!member.currentBranch &&
          !!member.defaultBranch &&
          member.currentBranch === member.defaultBranch,
      ),
    );
    const open =
      forcedOpen ||
      (systemExpansion.get(system.id) ??
        (!allDefault && efforts.some(findEffort)));
    return (
      <div key={system.id} style={{ ...systemsStack, gap: 4 }}>
        <div
          style={{
            ...systemsRow,
            flexWrap: "nowrap",
            minWidth: 0,
            position: "relative",
          }}
        >
          <button
            type="button"
            className="sidebar-branch-toggle ui-focus-ring"
            aria-expanded={open}
            aria-disabled={forcedOpen || undefined}
            style={{ fontWeight: 600, paddingInlineStart: 4 }}
            onClick={
              forcedOpen
                ? undefined
                : () =>
                    setSystemExpansion((previous) =>
                      new Map(previous).set(system.id, !open),
                    )
            }
          >
            <ChevronRight
              size={12}

              aria-hidden="true"
            />
            <span className="truncate" title={system.name}>
              {system.name}
            </span>
          </button>
          {!system.archived && (
            <SystemsButton
              style={{ flexShrink: 0 }}
              disabled={disabled}
              aria-label={`New Effort in ${system.name}`}
              title="New Effort"
              onClick={() => setEditor({ kind: "effort", system })}
            >
              <Plus size={12} aria-hidden="true" />
            </SystemsButton>
          )}
          <details>
            <summary
              aria-label={`Actions for ${system.name}`}
              title={`Actions for ${system.name}`}
              style={{
                cursor: "pointer",
                listStyle: "none",
                padding: "3px 6px",
                display: "flex",
              }}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </summary>
            <div
              style={{
                ...systemsStack,
                position: "absolute",
                insetBlockStart: "100%",
                insetInlineEnd: 0,
                zIndex: 10,
                width: "max-content",
                maxWidth: "100%",
                gap: 4,
                padding: 4,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                boxShadow: "var(--shadow-pop)",
              }}
            >
              <SystemsButton
                style={{ display: "flex", alignItems: "center", gap: 8 }}
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  onOpenPlanning?.({
                    host: host.id,
                    owner: { kind: "system", id: system.id },
                    onChanged,
                    onOpenTarget: async ({ effortId, path }) => {
                      const effort = (
                        await systemsRequest(host.id)
                      ).efforts.find(({ id }) => id === effortId);
                      if (!effort) throw new Error("Effort not found.");
                      setSystemExpansion((previous) =>
                        new Map(previous).set(effort.systemId, true),
                      );
                      onOpenEffort(effort, !!path && effort.status === "ready");
                    },
                    onOpenChat: onOpenLinkedSession,
                  });
                }}
              >
                <ClipboardList size={16} aria-hidden="true" />
                System Notes &amp; Tasks
              </SystemsButton>
              {!system.archived && (
                <SystemsButton
                  disabled={disabled}
                  onClick={(event) => {
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                    setEditor({ kind: "edit", system });
                  }}
                >
                  Edit System
                </SystemsButton>
              )}
              <SystemsButton
                disabled={disabled}
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  setEditor({ kind: "archive", system });
                }}
              >
                {system.archived ? "Restore System" : "Archive System"}
              </SystemsButton>
            </div>
          </details>
        </div>
        {open && (
          <div
            className="sidebar-tree-children"
            style={{ ...systemsStack, gap: 4 }}
          >
            {!efforts.length && <span style={systemsMuted}>No Efforts.</span>}
            {efforts.map((effort) => (
              <div key={effort.id} style={systemsRow}>
                <SystemsButton
                  aria-current={findEffort(effort) ? "page" : undefined}
                  data-active={findEffort(effort)}
                  style={{
                    flex: "1 1 8em",
                    minWidth: 0,
                    textAlign: "left",
                    background: findEffort(effort)
                      ? "var(--bg-hover)"
                      : "transparent",
                  }}
                  onClick={() =>
                    onOpenEffort(effort, effort.status === "ready" && !disabled)
                  }
                >
                  {effort.name}
                  <span style={{ ...systemsMuted, display: "block" }}>
                    {effortStatusLabels[effort.status]}
                  </span>
                </SystemsButton>
                <SystemsButton
                  aria-label={`Manage ${effort.name}`}
                  title="Effort details"
                  onClick={() => onOpenEffort(effort, false)}
                >
                  <Settings2 size={13} aria-hidden="true" />
                </SystemsButton>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };
  const currentSystem =
    editor && "system" in editor
      ? (data?.systems.find(({ id }) => id === editor.system.id) ??
        editor.system)
      : undefined;
  const registered = new Map(repos.map((repo) => [repo.path, repo]));
  for (const system of data?.systems ?? [])
    for (const path of system.repoPaths)
      if (!registered.has(path)) registered.set(path, { path, name: path });
  const archive = data?.systems
    .filter((system) => system.archived)
    .map(renderSystem)
    .filter(Boolean);
  const searching = Boolean(query);
  const sectionExpanded = searching || !hidden;
  return (
    <section
      aria-label="Systems"
      style={{
        ...systemsStack,
        gap: 5,
        paddingBottom: 4,
      }}
    >
      <SidebarSectionHeader
        label="Systems"
        disclosure={{
          expanded: sectionExpanded,
          onToggle: searching ? undefined : () => setHidden((value) => !value),
        }}
      >
        <SidebarIconButton
          disabled={disabled}
          label="Configure Effort worktrees root"
          title="Effort worktrees root"
          onClick={() => setEditor({ kind: "root" })}
        >
          <Settings2 aria-hidden="true" />
        </SidebarIconButton>
        <SidebarIconButton
          disabled={disabled}
          label="New System"
          onClick={() => setEditor({ kind: "new" })}
        >
          <Plus aria-hidden="true" />
        </SidebarIconButton>
      </SidebarSectionHeader>
      {sectionExpanded && (
        <div
          className="sidebar-tree-children"
          style={{ ...systemsStack, gap: 5 }}
        >
          <SystemsError message={unavailable ?? state?.error} />
          {!data && !unavailable && !state?.error && (
            <span role="status" style={systemsMuted}>
              Loading Systems…
            </span>
          )}
          {data?.systems.filter((system) => !system.archived).map(renderSystem)}
          {data?.systems.length === 0 && (
            <span style={systemsMuted}>No Systems on this host.</span>
          )}
          {!!archive?.length && (
            <details data-persistent>
              <summary
                style={{ color: "var(--text-muted)", cursor: "pointer" }}
              >
                Archived Systems ({archive.length})
              </summary>
              {archive}
            </details>
          )}
        </div>
      )}
      {(editor?.kind === "new" || editor?.kind === "edit") && (
        <SystemEditor
          host={host}
          repos={[...registered.values()]}
          system={currentSystem}
          action={action}
          onClose={close}
        />
      )}
      {editor?.kind === "root" && data && (
        <EffortRootEditor
          host={host}
          root={data.root}
          action={action}
          onClose={close}
        />
      )}
      {editor?.kind === "archive" && currentSystem && (
        <ArchiveSystem system={currentSystem} action={action} onClose={close} />
      )}
      {editor?.kind === "effort" && currentSystem && (
        <EffortCreator
          system={currentSystem}
          action={action}
          onClose={close}
          onCreated={(effort) => {
            setSystemExpansion((previous) =>
              new Map(previous).set(effort.systemId, true),
            );
            close();
            onChanged();
            onOpenEffort(effort, false);
          }}
        />
      )}
    </section>
  );
}
