"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FolderGit2, Settings2 } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ThemedSelect } from "./ui/primitives";
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
      <div className="settings-card">
        <div className="settings-card-text">
          <label htmlFor="project-settings-host" className="settings-card-title">Host</label>
          <div className="settings-card-desc">Choose the host whose projects you want to configure.</div>
        </div>
        {hosts && (
          <span className="settings-card-control">
            <ThemedSelect
              id="project-settings-host"
              value={hostId}
              onChange={(value) => {
                setSnapshot(null);
                setError("");
                setHostId(value);
              }}
              options={hosts.map((item) => ({
                value: item.id,
                label: `${hostName(t, item)} (${hostStatusText(t, item)})`,
              }))}
            />
          </span>
        )}
      </div>
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
  onPendingChange,
}: {
  hostId: string;
  project: HierarchyProject;
  onUpdated: (snapshot: HierarchySnapshot) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [tab, setTab] = useState<"general" | "workspace">("general");
  const mobile = useIsMobile();
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
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

  const tabs = [
    { id: "general", label: "General", description: "Name and icon", Icon: Settings2 },
    { id: "workspace", label: "Workspace setup", description: "Creation pipeline", Icon: FolderGit2 },
  ] as const;

  return (
    <section style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <div style={{ padding: "0 0 16px" }}>
        <h3 style={{ margin: 0, fontSize: 16, color: "var(--text)" }}>{project.alias ?? project.name}</h3>
        <div style={{ marginTop: 4, color: "var(--text-dim)", fontSize: 12 }}>{project.path}</div>
      </div>
      <div style={{ display: "flex", flexDirection: mobile ? "column" : "row", minWidth: 0 }}>
        <nav role="tablist" aria-label="Project settings" aria-orientation={mobile ? "horizontal" : "vertical"} className={mobile ? "settings-nav-horizontal" : "settings-nav"} style={mobile ? { display: "flex", gap: 3, padding: "7px 0", borderBottom: "1px solid var(--border)", overflowX: "auto" } : { width: 190, padding: "0 10px 0 0", background: "transparent" }}>
          {tabs.map((item, index) => {
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                ref={(element) => { tabRefs.current[index] = element; }}
                type="button"
                role="tab"
                id={`${id}-tab-${item.id}`}
                aria-controls={`${id}-panel-${item.id}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => {
                  let next: number;
                  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
                  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + tabs.length - 1) % tabs.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = tabs.length - 1;
                  else return;
                  event.preventDefault();
                  setTab(tabs[next].id);
                  tabRefs.current[next]?.focus();
                }}
                className={mobile ? undefined : `settings-nav-item${selected ? " active" : ""}`}
                style={mobile ? { display: "inline-flex", alignItems: "flex-start", gap: 5, padding: "6px 9px", border: "none", borderRadius: "var(--radius-control)", background: selected ? "var(--bg-selected)" : "transparent", color: selected ? "var(--text)" : "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap", textAlign: "left", cursor: "pointer" } : undefined}
              >
                <item.Icon size={mobile ? 13 : 16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: selected ? "var(--accent)" : "currentColor" }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: mobile ? 12 : 13, fontWeight: selected ? 600 : 500, lineHeight: 1.3 }}>{item.label}</span>
                  <span style={{ fontSize: mobile ? 10 : 11, color: "var(--text-dim)", lineHeight: 1.35 }}>{item.description}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <div style={{ flex: 1, minWidth: 0, padding: mobile ? "20px 0 0" : "0 0 0 20px" }}>
          <div role="tabpanel" id={`${id}-panel-general`} aria-labelledby={`${id}-tab-general`} hidden={tab !== "general"}>
            <h2 style={{ margin: "0 0 6px", fontFamily: "var(--font-serif, Georgia, serif)", fontSize: 22, fontWeight: 600 }}>General</h2>
            <p className="settings-content-subtitle" style={{ margin: "0 0 24px" }}>Set how this project appears in the sidebar.</p>
            <div className="settings-card" style={mobile ? { flexDirection: "column", alignItems: "stretch", gap: 10 } : undefined}>
              <div className="settings-card-text">
                <label htmlFor={`${id}-name`} className="settings-card-title">Display name</label>
                <div id={`${id}-name-desc`} className="settings-card-desc">Choose the name shown for this project. Clear it to use the directory name.</div>
              </div>
              <span className="settings-card-control" style={mobile ? { width: "100%" } : { flexShrink: 1 }}>
                <input id={`${id}-name`} aria-describedby={`${id}-name-desc`} style={{ width: "100%", minWidth: 0, boxSizing: "border-box", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 13 }} value={save.name} onChange={(e) => changeName(e.target.value)} />
              </span>
            </div>
            {save.running && <div role="status" className="settings-card-desc">Saving name...</div>}
            {save.error && <div role="alert" className="settings-card-desc">{save.error} <button type="button" className="dialog-action" onClick={() => void saveProjectName(key, hostId, project.id, save)}>Retry</button></div>}
            <ProjectIconSettings hostId={hostId} project={project} onUpdated={onUpdated} onPendingChange={onPendingChange} />
          </div>
          <div role="tabpanel" id={`${id}-panel-workspace`} aria-labelledby={`${id}-tab-workspace`} hidden={tab !== "workspace"}>
            <h2 style={{ margin: "0 0 6px", fontFamily: "var(--font-serif, Georgia, serif)", fontSize: 22, fontWeight: 600 }}>Workspace setup</h2>
            <p className="settings-content-subtitle" style={{ margin: "0 0 24px" }}>Configure workspace creation for this project.</p>
            <CreationPipelineEditor key={`${hostId}:${project.path}`} hostId={hostId} projectPath={project.path} gitProject={project.kind === "git"} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ProjectIconSettings({
  hostId,
  project,
  onUpdated,
  onPendingChange,
}: {
  hostId: string;
  project: HierarchyProject;
  onUpdated: (snapshot: HierarchySnapshot) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [candidates, setCandidates] = useState<NonNullable<HierarchySnapshot["iconCandidates"]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    onPendingChange?.(busy);
    return () => onPendingChange?.(false);
  }, [busy, onPendingChange]);
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
    <div className="settings-card" style={{ display: "block", minWidth: 0 }}>
      <div className="settings-card-title">Project icon</div>
      <div className="settings-card-desc" style={{ marginBottom: 12 }}>Choose an image or find an icon in the repository. Uploaded images are center-cropped to a square.</div>
      {project.icon && (
        <img src={project.icon} alt="Current project icon" width={48} height={48} style={{ objectFit: "cover", borderRadius: "var(--radius-control)", border: "1px solid var(--border)", marginBottom: 10 }} />
      )}
      <label style={{ display: "grid", gap: 6, minWidth: 0, color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
        Upload image (center-cropped to a square)
        <input className="project-icon-upload" style={{ maxWidth: "100%", minWidth: 0, color: "var(--text)", fontSize: 12 }} type="file" accept="image/*" disabled={busy} onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void uploadIcon(file);
        }} />
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="dialog-action" style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, cursor: busy ? "not-allowed" : "pointer" }} type="button" disabled={busy} onClick={() => void findIcons()}>Find repository icons</button>
        {project.icon && <button className="dialog-action" style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, cursor: busy ? "not-allowed" : "pointer" }} type="button" disabled={busy} onClick={() => void saveIcon(null)}>Remove icon</button>}
      </div>
      {busy && <div role="status">Working...</div>}
      {error && <div role="alert">{error}</div>}
      {candidates && (candidates.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8, minWidth: 0 }}>
          {candidates.map((candidate) => (
            <button key={candidate.path} type="button" disabled={busy} onClick={() => void saveIcon(candidate.icon)} style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, padding: 8, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, textAlign: "left", overflowWrap: "anywhere", cursor: busy ? "not-allowed" : "pointer" }}>
              <img src={candidate.icon} alt="" width={40} height={40} style={{ objectFit: "contain", flexShrink: 0 }} />
              <span style={{ minWidth: 0 }}>{candidate.path}</span>
            </button>
          ))}
        </div>
      ) : <div>No repository icons found.</div>)}
    </div>
  );
}
