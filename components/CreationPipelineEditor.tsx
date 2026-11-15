"use client";

import { useEffect, useRef, useState } from "react";
import type {
  WorkspaceCreationSettings,
  WorkspacePipeline,
} from "@/lib/workspace-creation-types";

const fieldStyle = {
  width: "100%",
  padding: 8,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg-panel)",
  color: "var(--text)",
} as const;

export function CreationPipelineEditor({
  hostId,
  projectPath,
  gitProject = false,
}: {
  hostId: string;
  projectPath?: string;
  gitProject?: boolean;
}) {
  const [settings, setSettings] = useState<WorkspaceCreationSettings | null>(null);
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const previewGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    ++previewGeneration.current;
    setSettings(null);
    setError("");
    setPreviewError("");
    setBusy(false);
    setRefreshing(false);
    const params = new URLSearchParams({ hostId, action: "settings" });
    if (projectPath !== undefined) params.set("projectPath", projectPath);
    void fetch(`/api/worktrees?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!controller.signal.aborted && generation.current === current) setSettings(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted && generation.current === current)
          setError(e instanceof Error ? e.message : String(e));
      });
    return () => { controller.abort(); ++generation.current; };
  }, [hostId, projectPath, revision]);

  async function refreshPreview() {
    const current = generation.current;
    const preview = ++previewGeneration.current;
    setRefreshing(true);
    setPreviewError("");
    try {
      const params = new URLSearchParams({ hostId, action: "settings", projectPath: projectPath! });
      const response = await fetch(`/api/worktrees?${params}`);
      const data: WorkspaceCreationSettings & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (generation.current === current && previewGeneration.current === preview)
        setSettings((previous) => previous ? { ...previous, paseo: data.paseo } : previous);
    } catch (e) {
      if (generation.current === current && previewGeneration.current === preview)
        setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation.current === current && previewGeneration.current === preview) setRefreshing(false);
    }
  }

  const pipeline = projectPath === undefined ? settings?.defaults : settings?.override;
  async function save() {
    if (!settings) return;
    const current = generation.current;
    ++previewGeneration.current;
    setRefreshing(false);
    setBusy(true);
    setError("");
    const clean = (value: WorkspacePipeline) => ({
      pre: value.pre.filter((s) => s.trim()),
      create: value.create.filter((s) => s.trim()),
      post: value.post.filter((s) => s.trim()),
    });
    try {
      const input = projectPath === undefined
        ? { defaults: clean(settings.defaults) }
        : { projectPath, override: settings.override ? clean(settings.override) : null,
            ...(gitProject ? { source: settings.source } : {}) };
      const response = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, action: "settings", input }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (generation.current === current) setSettings(data);
    } catch (e) {
      if (generation.current === current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <section style={{ display: "grid", gap: 10, minWidth: 0, overflowWrap: "anywhere" }}>
      <h3>Creation commands</h3>
      {gitProject && settings && (
        <fieldset disabled={busy} style={{ minWidth: 0 }}>
          <legend>Workspace configuration source</legend>
          <label><input type="radio" name={`source-${hostId}-${projectPath}`} checked={settings.source === "manual"} onChange={() => setSettings({ ...settings, source: "manual" })} /> Manual</label>{" "}
          <label><input type="radio" name={`source-${hostId}-${projectPath}`} checked={settings.source === "paseo"} onChange={() => setSettings({ ...settings, source: "paseo" })} /> Follow Paseo workspace setup</label>
        </fieldset>
      )}
      {gitProject && settings?.source === "paseo" && (
        <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
          <p>Follow Paseo uses the current on-disk project file, including uncommitted changes. It bypasses all manual project and host commands and uses built-in Git workspace creation, .worktreeinclude copying, setup and teardown.</p>
          <p>Services, scripts, terminals and port runtime are not supported. Future edits to the recipe will execute as your user when workspaces are created or deleted. Only enable this for a trusted project. Saving settings does not run the recipe.</p>
          <button type="button" disabled={refreshing || busy} onClick={() => void refreshPreview()}>{refreshing ? "Refreshing preview..." : "Refresh preview"}</button>
          {previewError && <div role="alert">Preview refresh failed: {previewError}</div>}
          {settings.paseo ? (
            <div style={{ minWidth: 0 }}>
              <div>Project file: {settings.paseo.path}</div>
              {settings.paseo.fingerprint && <div>Fingerprint: {settings.paseo.fingerprint}</div>}
              {settings.paseo.error && <div role="alert">{settings.paseo.error}</div>}
              {([['Setup', settings.paseo.setup], ['Teardown', settings.paseo.teardown], [`.worktreeinclude (${settings.paseo.includePath})`, settings.paseo.includePatterns], ['Unsupported features', settings.paseo.unsupportedFeatures]] as const).map(([label, values]) => (
                <div key={label}><strong>{label}</strong><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{values.length ? values.join("\n") : "None"}</pre></div>
              ))}
            </div>
          ) : <div>No Paseo preview available.</div>}
        </div>
      )}
      {(!gitProject || settings?.source !== "paseo") && <>
        {projectPath !== undefined && settings && (
          <label><input type="checkbox" disabled={busy} checked={settings.override !== null} onChange={(e) => setSettings({ ...settings, override: e.target.checked ? structuredClone(settings.defaults) : null })} /> Override all stages (otherwise inherit host defaults)</label>
        )}
        {pipeline && (["pre", "create", "post"] as const).map((stage) => (
          <label key={stage} style={{ display: "grid", gap: 4 }}>
            {stage} commands (one per line)
            <textarea style={fieldStyle} rows={3} disabled={busy} value={pipeline[stage].join("\n")} onChange={(e) => {
              const next = { ...pipeline, [stage]: e.target.value.split("\n") };
              setSettings(settings && (projectPath === undefined ? { ...settings, defaults: next } : { ...settings, override: next }));
            }} />
          </label>
        ))}
        <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
          Commands receive OMP_PROJECT_PATH, OMP_WORKSPACE_PATH, OMP_BRANCH, OMP_BASE_REF, OMP_BRANCH_MODE and OMP_CREATE_RESULT. Write {`{"path":"/absolute/worktree/path"}`} to OMP_CREATE_RESULT to return a custom path. An empty create stage uses Git.
        </p>
      </>}
      {error && <div role="alert">{error} {!settings && <button type="button" onClick={() => setRevision((n) => n + 1)}>Retry</button>}</div>}
      {!settings && !error && <div role="status">Loading creation commands...</div>}
      <div><button type="button" disabled={!settings || busy} onClick={() => void save()}>{busy ? "Saving..." : "Save commands"}</button></div>
    </section>
  );
}
