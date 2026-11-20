"use client";

import { useState } from "react";
import { ChevronRight, ClipboardList, Plus, Settings2 } from "lucide-react";
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
  host: string;
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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
    const efforts =
      data?.efforts.filter(
        (effort) =>
          effort.systemId === system.id &&
          (!runningOnly ||
            findEffort(effort) ||
            effort.sessionIds.some((id) => runningIds.has(id)) ||
            effort.services.some(({ status }) => status === "running") ||
            effort.status === "creating" ||
            effort.status === "cleaning") &&
          (systemMatch ||
            `${effort.name} ${effort.root} ${effort.branch}`
              .toLowerCase()
              .includes(query) ||
            effort.sessionIds.some((id) => matchedIds?.has(id))),
      ) ?? [];
    if ((runningOnly || !systemMatch) && !efforts.length) return null;
    const open =
      expanded.has(system.id) ||
      efforts.some(findEffort) ||
      Boolean(query) ||
      runningOnly;
    return (
      <div
        key={system.id}
        style={{ ...systemsStack, gap: 4, paddingInlineStart: 4 }}
      >
        <div style={systemsRow}>
          <SystemsButton
            aria-expanded={open}
            style={{
              flex: "1 1 7em",
              minWidth: 0,
              border: 0,
              background: "transparent",
              fontWeight: 600,
              textAlign: "left",
            }}
            onClick={() =>
              setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(system.id)) next.delete(system.id);
                else next.add(system.id);
                return next;
              })
            }
          >
            <ChevronRight
              size={12}
              style={{
                verticalAlign: "middle",
                transform: open ? "rotate(90deg)" : undefined,
              }}
              aria-hidden="true"
            />{" "}
            {system.name}
          </SystemsButton>
          {!system.archived && (
            <SystemsButton
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
              style={{ cursor: "pointer" }}
            >
              Actions
            </summary>
            <div style={{ ...systemsStack, padding: 4 }}>
              <SystemsButton
                style={{ display: "flex", alignItems: "center", gap: 8 }}
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  onOpenPlanning?.({
                    host,
                    owner: { kind: "system", id: system.id },
                    onChanged,
                    onOpenTarget: async ({ effortId, path }) => {
                      const effort = (await systemsRequest(host)).efforts.find(
                        ({ id }) => id === effortId,
                      );
                      if (!effort) throw new Error("Effort not found.");
                      setExpanded((previous) =>
                        new Set(previous).add(effort.systemId),
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
          <div style={{ ...systemsStack, gap: 4, paddingInlineStart: 14 }}>
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
        borderTop: "1px solid var(--border)",
        paddingBottom: 4,
        marginTop: 5,
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
        <>
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
        </>
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
            setExpanded((previous) => new Set(previous).add(effort.systemId));
            close();
            onChanged();
            onOpenEffort(effort, false);
          }}
        />
      )}
    </section>
  );
}
