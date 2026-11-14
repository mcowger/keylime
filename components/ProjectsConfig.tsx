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

function ProjectSettings({
  hostId,
  project,
  onUpdated,
}: {
  hostId: string;
  project: HierarchyProject;
  onUpdated: (snapshot: HierarchySnapshot) => void;
}) {
  const [name, setName] = useState(project.alias ?? project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setName(project.alias ?? project.name);
  }, [project.alias, project.name]);
  async function saveName() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/hierarchy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: hostId,
          input: {
            action: "updateProject",
            projectId: project.id,
            alias: name.trim() || null,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      onUpdated(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <h3>{project.alias ?? project.name}</h3>
      <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
        {project.path}
      </div>
      <label>
        Display name{" "}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div>
        <button type="button" disabled={busy} onClick={() => void saveName()}>
          {busy ? "Saving..." : "Save name"}
        </button>
      </div>
      {error && <div role="alert">{error}</div>}
      <CreationPipelineEditor
        key={`${hostId}:${project.path}`}
        hostId={hostId}
        projectPath={project.path}
      />
    </section>
  );
}
