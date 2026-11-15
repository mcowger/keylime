"use client";

import { useEffect, useState } from "react";
import type { HierarchySnapshot } from "@/lib/project-hierarchy-types";
import { LOCAL_HOST_ID } from "@/lib/project-ordering";
import type { SessionInfo } from "@/lib/types";

export function WorkspaceChatPicker({
  hostId,
  cwd,
  openSessionIds,
  onSelect,
}: {
  hostId: string;
  cwd: string;
  openSessionIds: string[];
  onSelect: (session: SessionInfo) => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSessions([]);
    void (async () => {
      try {
        const [hierarchyResponse, sessionsResponse] = await Promise.all([
          fetch(`/api/hierarchy?${new URLSearchParams({ host: hostId })}`, {
            signal: controller.signal,
          }),
          fetch("/api/sessions", { signal: controller.signal }),
        ]);
        if (!hierarchyResponse.ok)
          throw new Error(
            `Workspace unavailable (HTTP ${hierarchyResponse.status})`,
          );
        if (!sessionsResponse.ok)
          throw new Error(
            `Chats unavailable (HTTP ${sessionsResponse.status})`,
          );
        const hierarchy = (await hierarchyResponse.json()) as HierarchySnapshot;
        const data = (await sessionsResponse.json()) as {
          sessions: SessionInfo[];
        };
        const workspaces = hierarchy.projects.flatMap(
          (project) => project.workspaces,
        );
        const normalize = (path: string) => path.replace(/\/+$/, "") || "/";
        const target = workspaces.find(
          (workspace) => normalize(workspace.path) === normalize(cwd),
        );
        if (!target) throw new Error("Workspace is unavailable on this host");
        const ids = new Set(target.sessionIds);
        const nestedIds = new Set(
          workspaces
            .filter((workspace) => {
              const path = normalize(workspace.path);
              const parent = normalize(cwd);
              return (
                path !== parent &&
                path.startsWith(parent === "/" ? "/" : `${parent}/`)
              );
            })
            .flatMap((workspace) => workspace.sessionIds),
        );
        setSessions(
          data.sessions.filter((session) => {
            if (
              !ids.has(session.id) ||
              nestedIds.has(session.id) ||
              (session.hostId ?? LOCAL_HOST_ID) !== hostId
            )
              return false;
            const sessionCwd = normalize(session.cwd);
            const containingWorkspace = workspaces
              .filter((workspace) => {
                const path = normalize(workspace.path);
                return (
                  sessionCwd === path ||
                  sessionCwd.startsWith(path === "/" ? "/" : `${path}/`)
                );
              })
              .sort((a, b) => b.path.length - a.path.length)[0];
            return containingWorkspace?.id === target.id;
          }),
        );
      } catch (err) {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [hostId, cwd, revision]);

  const filtered = sessions.filter((session) =>
    !openSessionIds.includes(session.id) &&
    `${session.name ?? ""} ${session.firstMessage ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section className="workspace-picker-history">
      <h3>Saved chats</h3>
      <input
        aria-label="Search saved chats"
        placeholder="Search saved chats"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {loading ? (
        <p>Loading chats…</p>
      ) : error ? (
        <p role="alert">
          {error}{" "}
          <button onClick={() => setRevision((value) => value + 1)}>
            Retry
          </button>
        </p>
      ) : filtered.length === 0 ? (
        <p>No saved chats found.</p>
      ) : (
        filtered.map((session) => (
          <button
            className="workspace-picker-saved"
            key={session.id}
            onClick={() => onSelect(session)}
          >
            {session.name || session.firstMessage || "Untitled chat"}
          </button>
        ))
      )}
    </section>
  );
}
