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

async function saveProjectName(
  key: string,
  hostId: string,
  projectId: string,
  save: NameSave,
) {
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
    if (version === save.version || (save.name.trim() || null) === save.saved)
      break;
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
    const updated = (snapshot: HierarchySnapshot) =>
      onUpdatedRef.current(snapshot);
    save.listeners.add(listener);
    save.updated.add(updated);
    return () => {
      save.listeners.delete(listener);
      save.updated.delete(updated);
      if (
        !save.listeners.size &&
        !save.running &&
        !save.error &&
        nameSaves.get(key) === save
      )
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
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: 12,
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      <h3>{project.alias ?? project.name}</h3>
      <div
        style={{
          color: "var(--text-dim)",
          fontSize: 12,
          overflowWrap: "anywhere",
        }}
      >
        {project.path}
      </div>
      <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
        Display name{" "}
        <input
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: 8,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            background: "var(--bg-panel)",
            color: "var(--text)",
          }}
          value={save.name}
          onChange={(e) => changeName(e.target.value)}
        />
      </label>
      {save.error && (
        <div role="alert">
          {save.error}{" "}
          <button
            type="button"
            onClick={() => void saveProjectName(key, hostId, project.id, save)}
          >
            Retry
          </button>
        </div>
      )}
      <ProjectIconSettings
        hostId={hostId}
        project={project}
        onUpdated={onUpdated}
      />
      <CreationPipelineEditor
        key={`${hostId}:${project.path}`}
        hostId={hostId}
        projectPath={project.path}
        gitProject={project.kind === "git"}
      />
    </section>
  );
}

function ProjectIconSettings({
  hostId,
  project,
  onUpdated,
}: {
  hostId: string;
  project: HierarchyProject;
  onUpdated: (snapshot: HierarchySnapshot) => void;
}) {
  const [candidates, setCandidates] = useState<NonNullable<HierarchySnapshot["iconCandidates"]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  async function request(input: object): Promise<HierarchySnapshot> {
    const current = new AbortController();
    controller.current = current;
    const response = await fetch("/api/hierarchy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: hostId, input }),
      signal: current.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }

  async function saveIcon(icon: string | null) {
    setBusy(true);
    setError("");
    try {
      const snapshot = await request({ action: "setProjectIcon", projectId: project.id, icon });
      if (mounted.current) onUpdated(snapshot);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function uploadIcon(file: File) {
    setBusy(true);
    setError("");
    try {
      if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const size = Math.min(image.naturalWidth, image.naturalHeight);
        if (!size) throw new Error("The image is empty.");
        const canvas = document.createElement("canvas");
        canvas.width = 192;
        canvas.height = 192;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not process the image.");
        context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 192, 192);
        if (mounted.current) await saveIcon(canvas.toDataURL("image/png"));
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function findIcons() {
    setBusy(true);
    setError("");
    try {
      const snapshot = await request({ action: "listProjectIcons", projectId: project.id });
      if (mounted.current) setCandidates(snapshot.iconCandidates ?? []);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8, minWidth: 0 }}>
      <strong>Project icon</strong>
      {project.icon && (
        <img src={project.icon} alt="Current project icon" width={48} height={48} style={{ objectFit: "cover", borderRadius: 6 }} />
      )}
      <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
        Upload image (center-cropped to a square)
        <input style={{ maxWidth: "100%", minWidth: 0 }} type="file" accept="image/*" disabled={busy} onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void uploadIcon(file);
        }} />
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" disabled={busy} onClick={() => void findIcons()}>Find repository icons</button>
        {project.icon && <button type="button" disabled={busy} onClick={() => void saveIcon(null)}>Remove icon</button>}
      </div>
      {busy && <div role="status">Working...</div>}
      {error && <div role="alert">{error}</div>}
      {candidates && (candidates.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8, minWidth: 0 }}>
          {candidates.map((candidate) => (
            <button key={candidate.path} type="button" disabled={busy} onClick={() => void saveIcon(candidate.icon)} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, textAlign: "left", overflowWrap: "anywhere" }}>
              <img src={candidate.icon} alt="" width={40} height={40} style={{ objectFit: "contain", flexShrink: 0 }} />
              <span style={{ minWidth: 0 }}>{candidate.path}</span>
            </button>
          ))}
        </div>
      ) : <div>No repository icons found.</div>)}
    </div>
  );
}
