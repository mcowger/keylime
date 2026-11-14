"use client";

import { useEffect, useState } from "react";
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
}: {
  hostId: string;
  projectPath?: string;
}) {
  const [settings, setSettings] = useState<WorkspaceCreationSettings | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setSettings(null);
    setError("");
    const params = new URLSearchParams({ hostId, action: "settings" });
    if (projectPath !== undefined) params.set("projectPath", projectPath);
    void fetch(`/api/worktrees?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!controller.signal.aborted) setSettings(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [hostId, projectPath, revision]);

  const pipeline =
    projectPath === undefined ? settings?.defaults : settings?.override;
  async function save() {
    if (!settings) return;
    setBusy(true);
    setError("");
    const clean = (value: WorkspacePipeline) => ({
      pre: value.pre.filter((s) => s.trim()),
      create: value.create.filter((s) => s.trim()),
      post: value.post.filter((s) => s.trim()),
    });
    try {
      const input =
        projectPath === undefined
          ? { defaults: clean(settings.defaults) }
          : {
              projectPath,
              override: settings.override ? clean(settings.override) : null,
            };
      const response = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, action: "settings", input }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      setSettings(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section style={{ display: "grid", gap: 10 }}>
      <h3>Creation commands</h3>
      {projectPath !== undefined && settings && (
        <label>
          <input
            type="checkbox"
            checked={settings.override !== null}
            onChange={(e) =>
              setSettings({
                ...settings,
                override: e.target.checked
                  ? structuredClone(settings.defaults)
                  : null,
              })
            }
          />{" "}
          Override all stages (otherwise inherit host defaults)
        </label>
      )}
      {pipeline &&
        (["pre", "create", "post"] as const).map((stage) => (
          <label key={stage} style={{ display: "grid", gap: 4 }}>
            {stage} commands (one per line)
            <textarea
              style={fieldStyle}
              rows={3}
              value={pipeline[stage].join("\n")}
              onChange={(e) => {
                const next = {
                  ...pipeline,
                  [stage]: e.target.value.split("\n"),
                };
                setSettings(
                  settings &&
                    (projectPath === undefined
                      ? { ...settings, defaults: next }
                      : { ...settings, override: next }),
                );
              }}
            />
          </label>
        ))}
      <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
        Commands receive OMP_PROJECT_PATH, OMP_WORKSPACE_PATH, OMP_BRANCH,
        OMP_BASE_REF, OMP_BRANCH_MODE and OMP_CREATE_RESULT. Write{" "}
        {`{"path":"/absolute/worktree/path"}`} to OMP_CREATE_RESULT to return a
        custom path. An empty create stage uses Git.
      </p>
      {error && (
        <div role="alert">
          {error}{" "}
          {!settings && (
            <button type="button" onClick={() => setRevision((n) => n + 1)}>
              Retry
            </button>
          )}
        </div>
      )}
      {!settings && !error && (
        <div role="status">Loading creation commands...</div>
      )}
      <div>
        <button
          type="button"
          disabled={!settings || busy}
          onClick={() => void save()}
        >
          {busy ? "Saving..." : "Save commands"}
        </button>
      </div>
    </section>
  );
}
