"use client";

import { useEffect, useRef, useState } from "react";
import { useHostRows } from "@/hooks/useHostRows";
import { useI18n } from "@/lib/i18n";
import type {
  HierarchyProject,
  HierarchySnapshot,
} from "@/lib/project-hierarchy-types";
import { CreationPipelineEditor } from "./CreationPipelineEditor";
import { hostName, hostStatusText } from "./host-status";
import { isLinkUp } from "@/lib/hosts/host";

export function ProjectsConfig() {
  const { t } = useI18n();
  const { hosts, failed } = useHostRows();
  const [hostId, setHostId] = useState("local");
  const selectedHost = useRef(hostId);
  selectedHost.current = hostId;
  const [snapshot, setSnapshot] = useState<HierarchySnapshot | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const host = hosts?.find((item) => item.id === hostId);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setError("");
    if (!host || !isLinkUp(host.status)) return () => controller.abort();
    void fetch(`/api/hierarchy?${new URLSearchParams({ host: hostId })}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!controller.signal.aborted) setSnapshot(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [hostId, host?.status, revision]);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <label>
        Host{" "}
        {hosts && (
          <select
            value={hostId}
            onChange={(e) => {
              setSnapshot(null);
              setError("");
              setHostId(e.target.value);
            }}
          >
            {hosts.map((item) => (
              <option key={item.id} value={item.id}>
                {hostName(t, item)} ({hostStatusText(t, item)})
              </option>
            ))}
          </select>
        )}
      </label>
      {failed && <div role="alert">Could not load hosts.</div>}
      {!hosts && !failed && <div role="status">Loading hosts...</div>}
      {hosts && !host && <div>Select a host.</div>}
      {host && !isLinkUp(host.status) && (
        <div role="status">
          {hostName(t, host)}: {hostStatusText(t, host)}. Projects are
          unavailable.
        </div>
      )}
      {error && (
        <div role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRevision((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
      {host && isLinkUp(host.status) && !snapshot && !error && (
        <div role="status">Loading projects...</div>
      )}
      {snapshot && snapshot.projects.length === 0 && (
        <p>No registered projects on this host.</p>
      )}
      {snapshot?.projects.map((project) => (
        <ProjectSettings
          key={`${hostId}:${project.id}`}
          hostId={hostId}
          project={project}
          onUpdated={(value) => {
            if (selectedHost.current === hostId) setSnapshot(value);
          }}
        />
      ))}
    </div>
  );
}

type NameSave = {
  name: string;
  saved: string | null;
  version: number;
  running: boolean;
  error: string;
  listeners: Set<() => void>;
  updated: Set<(snapshot: HierarchySnapshot) => void>;
};

// Keep pending edits alive when a settings dialog closes or its host changes.
const nameSaves = new Map<string, NameSave>();

function notifyNameSave(save: NameSave) {
  for (const listener of save.listeners) listener();
}

async function saveProjectName(key: string, hostId: string, projectId: string, save: NameSave) {
  if (save.running) return;
  save.running = true;
  while (true) {
    const version = save.version;
    const alias = save.name.trim() || null;
    save.error = "";
    notifyNameSave(save);
    try {
      const response = await fetch("/api/hierarchy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: hostId,
          input: { action: "updateProject", projectId, alias },
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      save.saved = alias;
      for (const updated of save.updated) updated(data);
    } catch (e) {
      if (version === save.version) {
        save.error = e instanceof Error ? e.message : String(e);
        break;
      }
      continue;
    }
    if (version === save.version || (save.name.trim() || null) === save.saved) break;
  }
  save.running = false;
  notifyNameSave(save);
  if (!save.listeners.size && !save.error && nameSaves.get(key) === save)
    nameSaves.delete(key);
}


export function ProjectSettings({
  hostId,
  project,
  onUpdated,
}: {
  hostId: string;
  project: HierarchyProject;
  onUpdated: (snapshot: HierarchySnapshot) => void;
}) {
  const key = JSON.stringify([hostId, project.id]);
  const [save] = useState(() => {
    let current = nameSaves.get(key);
    if (!current) {
      current = {
        name: project.alias ?? project.name,
        saved: project.alias ?? null,
        version: 0,
        running: false,
        error: "",
        listeners: new Set(),
        updated: new Set(),
      };
      nameSaves.set(key, current);
    }
    return current;
  });
  const [, setRevision] = useState(0);
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;
  useEffect(() => {
    nameSaves.set(key, save);
    const listener = () => setRevision((n) => n + 1);
    const updated = (snapshot: HierarchySnapshot) => onUpdatedRef.current(snapshot);
    save.listeners.add(listener);
    save.updated.add(updated);
    return () => {
      save.listeners.delete(listener);
      save.updated.delete(updated);
      if (!save.listeners.size && !save.running && !save.error && nameSaves.get(key) === save)
        nameSaves.delete(key);
    };
  }, [key, save]);
  useEffect(() => {
    if (!save.running && !save.error) {
      save.name = project.alias ?? project.name;
      save.saved = project.alias ?? null;
      notifyNameSave(save);
    }
  }, [project.alias, project.name, save]);
  function changeName(name: string) {
    save.name = name;
    save.version++;
    save.error = "";
    notifyNameSave(save);
    void saveProjectName(key, hostId, project.id, save);
  }

  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
        display: "grid",
        gap: 12,
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      <h3>{project.alias ?? project.name}</h3>
      <div style={{ color: "var(--text-dim)", fontSize: 12, overflowWrap: "anywhere" }}>
        {project.path}
      </div>
      <label>
        Display name{" "}
        <input style={{ width: "100%", padding: 8, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)" }} value={save.name} onChange={(e) => changeName(e.target.value)} />
      </label>
      {save.error && <div role="alert">{save.error} <button type="button" onClick={() => void saveProjectName(key, hostId, project.id, save)}>Retry</button></div>}
      <CreationPipelineEditor
        key={`${hostId}:${project.path}`}
        hostId={hostId}
        projectPath={project.path}
        gitProject={project.kind === "git"}
      />
    </section>
  );
}
