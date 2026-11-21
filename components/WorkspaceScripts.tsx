"use client";

import { useEffect, useRef, useState } from "react";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  WorkspaceScriptListResultSchema,
  WorkspaceScriptLaunchResultSchema,
  WorkspaceScriptStopResultSchema,
  type WorkspaceScriptRowSchema,
  type WorkspaceTerminalSchema,
} from "@/lib/api-contracts/workspace-models";

type ScriptList = Static<typeof WorkspaceScriptListResultSchema>;
type ScriptRow = Static<typeof WorkspaceScriptRowSchema>;
type Terminal = Static<typeof WorkspaceTerminalSchema>;

type Scope = { hostId: string; cwd: string };

type Scripts = {
  list: ScriptList | null;
  readError: string | null;
  actionError: string | null;
  isPending: (name: string) => boolean;
  mutate: (row: ScriptRow, action: "launch" | "stop") => Promise<void>;
  view: (id: string) => void;
};

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) {
    if (body?.code === "workspace_unsupported")
      throw new Error("Update the owning host to use Paseo scripts");
    throw new Error(
      body?.error?.message ??
        body?.error ??
        `Request failed (${response.status})`,
    );
  }
  return body;
}

export function useWorkspaceScripts({
  hostId,
  cwd,
  open,
  activeId,
  activeChatId,
  onInventory,
  onView,
}: {
  hostId: string;
  cwd: string | null;
  open: boolean;
  activeId: string | null;
  activeChatId: string | null;
  onInventory: (scope: Scope, terminal?: Terminal) => void;
  onView: (id: string) => void;
}): Scripts {
  const scopeKey = JSON.stringify([hostId, cwd]);
  const navigationKey = JSON.stringify([
    scopeKey,
    open,
    activeId,
    activeChatId,
  ]);
  const current = useRef({
    scopeKey,
    navigationKey,
    open,
    scope: 0,
    navigation: 0,
  });
  if (current.current.navigationKey !== navigationKey) {
    const previous = current.current;
    current.current = {
      scopeKey,
      navigationKey,
      open,
      scope: previous.scope + Number(previous.scopeKey !== scopeKey),
      navigation: previous.navigation + 1,
    };
  }
  const callbacks = useRef({ onInventory, onView });
  callbacks.current = { onInventory, onView };
  const [list, setList] = useState<{ scope: string; value: ScriptList } | null>(
    null,
  );
  const [readError, setReadError] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const [actionError, setActionError] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const pending = useRef(new Set<string>());
  const [, setPendingRevision] = useState(0);
  const readVersion = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useRef<() => void>(() => {});

  refresh.current = () => {
    if (
      !mounted.current ||
      !current.current.open ||
      !cwd ||
      current.current.scopeKey !== scopeKey
    )
      return;
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    const version = readVersion.current;
    const navigation = current.current.navigation;
    void request(
      `/api/workspace-scripts?${new URLSearchParams({ hostId, cwd })}`,
    )
      .then((value) => {
        if (
          !mounted.current ||
          current.current.scopeKey !== scopeKey ||
          !current.current.open ||
          current.current.navigation !== navigation ||
          readVersion.current !== version
        )
          return;
        if (!Value.Check(WorkspaceScriptListResultSchema, value))
          throw new Error("Invalid scripts response");
        setList({ scope: scopeKey, value });
        setReadError(null);
      })
      .catch((error: unknown) => {
        if (
          current.current.scopeKey === scopeKey &&
          mounted.current &&
          current.current.open &&
          current.current.navigation === navigation &&
          readVersion.current === version
        )
          setReadError({
            scope: scopeKey,
            message: error instanceof Error ? error.message : String(error),
          });
      })
      .finally(() => {
        inFlight.current = false;
        if (queued.current) {
          queued.current = false;
          refresh.current();
        }
      });
  };

  useEffect(() => {
    if (!open || !cwd) return;
    refresh.current();
    const timer = setInterval(() => refresh.current(), 2000);
    return () => clearInterval(timer);
  }, [open, hostId, cwd]);

  async function mutate(row: ScriptRow, action: "launch" | "stop") {
    if (!cwd) return;
    const key = JSON.stringify([scopeKey, row.name]);
    if (pending.current.has(key)) return;
    const terminalId = row.run?.terminalId;
    if (action === "stop" && !terminalId) return;
    pending.current.add(key);
    setPendingRevision((value) => value + 1);
    setActionError(null);
    readVersion.current++;
    const navigation = current.current.navigation;
    const scopeVersion = current.current.scope;
    const scope = { hostId, cwd };
    try {
      const value = await request("/api/workspace-scripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "launch"
            ? { hostId, cwd, action, name: row.name }
            : { hostId, cwd, action, terminalId },
        ),
      });
      if (!mounted.current || current.current.scope !== scopeVersion) return;
      if (action === "launch") {
        if (
          !Value.Check(WorkspaceScriptLaunchResultSchema, value) ||
          value.terminal.cwd !== cwd
        )
          throw new Error("Invalid launch response");
        const terminal = value.terminal;
        callbacks.current.onInventory(scope, terminal);
        if (
          current.current.scopeKey === scopeKey &&
          current.current.open &&
          current.current.navigation === navigation
        )
          callbacks.current.onView(terminal.id);
      } else if (!Value.Check(WorkspaceScriptStopResultSchema, value)) {
        throw new Error("Invalid stop response");
      }
    } catch (error) {
      if (mounted.current && current.current.scope === scopeVersion)
        setActionError({
          scope: scopeKey,
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      pending.current.delete(key);
      if (mounted.current) setPendingRevision((value) => value + 1);
      if (mounted.current && current.current.scopeKey === scopeKey) {
        readVersion.current++;
        refresh.current();
      }
    }
  }

  const view = (id: string) => {
    if (!cwd) return;
    callbacks.current.onInventory({ hostId, cwd });
    callbacks.current.onView(id);
  };
  return {
    list: list?.scope === scopeKey ? list.value : null,
    readError: readError?.scope === scopeKey ? readError.message : null,
    actionError: actionError?.scope === scopeKey ? actionError.message : null,
    isPending: (name: string) =>
      pending.current.has(JSON.stringify([scopeKey, name])),
    mutate,
    view,
  };
}

export function WorkspaceScripts({ scripts }: { scripts: Scripts }) {
  const { list, readError, actionError, isPending, mutate, view } = scripts;
  const loading = !list && !readError && !actionError;
  return (
    <section className="workspace-scripts">
      <h3>Scripts &amp; services</h3>
      {loading && <p role="status">Loading scripts…</p>}
      {list && !list.enabled && list.entries.length === 0 && (
        <p>
          Enable Follow Paseo workspace setup in Repo settings to run scripts
          and services.
        </p>
      )}
      {readError && <p role="alert">{readError}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {list?.error && <p role="alert">{list.error}</p>}
      {list?.enabled && list.entries.length === 0 && !list.error && (
        <p>No scripts defined in paseo.json</p>
      )}
      {list?.entries.map((row) => {
        const run = row.run;
        const live = run?.status === "running";
        const status = !run
          ? "Not run"
          : live
            ? "Running"
            : run.status === "stopped"
              ? "Stopped"
              : `Exited${run.exitCode !== null ? ` (code ${run.exitCode})` : run.signal ? ` (signal ${run.signal})` : ""}`;
        return (
          <div key={row.name} className="workspace-script-row">
            <div className="workspace-script-description">
              <div>
                {row.name} · {status}
              </div>
              {live && run.port !== null && (
                <div>Port {run.port} on this workspace's host</div>
              )}
              {row.error && <div role="alert">{row.error}</div>}
            </div>
            {list.enabled && row.configured && !row.error && !live && (
              <button
                type="button"
                className="ui-focus-ring"
                disabled={isPending(row.name)}
                onClick={() => void mutate(row, "launch")}
              >
                {row.kind === "service" ? "Start" : "Run"}
              </button>
            )}
            {live && (
              <button
                type="button"
                className="ui-focus-ring"
                disabled={isPending(row.name)}
                onClick={() => void mutate(row, "stop")}
              >
                Stop
              </button>
            )}
            {run && (
              <button
                type="button"
                className="ui-focus-ring"
                onClick={() => view(run.terminalId)}
              >
                View output
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
