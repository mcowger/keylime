"use client";

import { useEffect, useRef, useState } from "react";
import type {
  WorkspaceCreationSettings,
  WorkspacePipeline,
} from "@/lib/workspace-creation-types";

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: 8,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg-panel)",
  color: "var(--text)",
} as const;

const buttonStyle = {
  padding: "6px 14px",
  background: "var(--accent-strong)",
  border: "none",
  borderRadius: "var(--radius-control)",
  color: "var(--on-accent)",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
} as const;

// Keep writes ordered even if an editor is closed and reopened while a request is pending.
const pendingWrites = new Map<string, Promise<void>>();

export function CreationPipelineEditor({
  hostId,
  projectPath,
  gitProject = false,
}: {
  hostId: string;
  projectPath?: string;
  gitProject?: boolean;
}) {
  const [settings, setSettings] = useState<WorkspaceCreationSettings | null>(
    null,
  );
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [saving, setSaving] = useState(false);
  const [invalidStored, setInvalidStored] = useState(false);
  const [replacement, setReplacement] = useState({
    pre: "",
    create: "",
    postBlocking: "",
    postNonBlocking: "",
  });
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const previewGeneration = useRef(0);
  const editGeneration = useRef(0);
  const latestSettings = useRef<WorkspaceCreationSettings | null>(null);
  const latestSaveIncludesPaseo = useRef(false);
  const key = JSON.stringify([hostId, projectPath]);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    ++previewGeneration.current;
    setSettings(null);
    setError("");
    setInvalidStored(false);
    setReplacement({
      pre: "",
      create: "",
      postBlocking: "",
      postNonBlocking: "",
    });
    setPreviewError("");
    latestSettings.current = null;
    ++editGeneration.current;
    setSaving(false);
    setRefreshing(false);
    const params = new URLSearchParams({ hostId, action: "settings" });
    if (projectPath !== undefined) params.set("projectPath", projectPath);
    void (async () => {
      await pendingWrites.get(key);
      if (controller.signal.aborted) return;
      const response = await fetch(`/api/worktrees?${params}`, {
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) {
        if (
          data.code === "invalid_workspace_settings" &&
          !controller.signal.aborted &&
          generation.current === current
        )
          setInvalidStored(true);
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      if (!controller.signal.aborted && generation.current === current) {
        latestSettings.current = data;
        setSettings(data);
      }
    })().catch((e) => {
      if (!controller.signal.aborted && generation.current === current)
        setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      controller.abort();
      ++generation.current;
    };
  }, [hostId, projectPath, revision, key]);

  async function refreshPreview() {
    const current = generation.current;
    const preview = ++previewGeneration.current;
    setRefreshing(true);
    setPreviewError("");
    try {
      const params = new URLSearchParams({
        hostId,
        action: "settings",
        projectPath: projectPath!,
      });
      const response = await fetch(`/api/worktrees?${params}`);
      const data: WorkspaceCreationSettings & { error?: string } =
        await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      if (
        generation.current === current &&
        previewGeneration.current === preview
      ) {
        setSettings((previous) => {
          const next = previous ? { ...previous, paseo: data.paseo } : previous;
          latestSettings.current = next;
          return next;
        });
      }
    } catch (e) {
      if (
        generation.current === current &&
        previewGeneration.current === preview
      )
        setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      if (
        generation.current === current &&
        previewGeneration.current === preview
      )
        setRefreshing(false);
    }
  }

  const pipeline =
    projectPath === undefined ? settings?.defaults : settings?.override;
  function save(next: WorkspaceCreationSettings, includePaseo = false) {
    latestSettings.current = next;
    latestSaveIncludesPaseo.current = includePaseo;
    setSettings(next);
    const current = generation.current;
    const edit = ++editGeneration.current;
    setSaving(true);
    setError("");
    const clean = (value: WorkspacePipeline) => ({
      pre: value.pre.filter((s) => s.trim()),
      create: value.create.filter((s) => s.trim()),
      postBlocking: value.postBlocking.filter((s) => s.trim()),
      postNonBlocking: value.postNonBlocking.filter((s) => s.trim()),
    });
    const input =
      projectPath === undefined
        ? { defaults: clean(next.defaults) }
        : {
            projectPath,
            override: next.override ? clean(next.override) : null,
            ...(gitProject
              ? {
                  source: next.source,
                  ...(includePaseo
                    ? { paseoBlocking: next.paseoBlocking }
                    : {}),
                }
              : {}),
          };
    const previous = pendingWrites.get(key) ?? Promise.resolve();
    const write = previous.then(async () => {
      const response = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, action: "settings", input }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
    });
    const settled = write
      .catch((e) => {
        if (generation.current === current && editGeneration.current === edit)
          setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (generation.current === current && editGeneration.current === edit)
          setSaving(false);
      });
    pendingWrites.set(key, settled);
    void settled.then(() => {
      if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
    });
  }
  async function replaceInvalidPipeline() {
    const current = generation.current;
    setSaving(true);
    const pipeline = Object.fromEntries(
      Object.entries(replacement).map(([stage, value]) => [
        stage,
        value.split("\n").filter((line) => line.trim()),
      ]),
    );
    try {
      const response = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostId,
          action: "settings",
          input:
            projectPath === undefined
              ? { defaults: pipeline }
              : { projectPath, override: pipeline },
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      if (generation.current === current) setRevision((n) => n + 1);
    } catch (e) {
      if (generation.current === current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation.current === current) setSaving(false);
    }
  }
  return (
    <section
      style={{
        display: "grid",
        gap: 10,
        gridTemplateColumns: "minmax(0, 1fr)",
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      <h3>Creation commands</h3>
      {invalidStored && !settings && (
        <div style={{ display: "grid", gap: 8 }}>
          <p>
            Stored workspace commands are invalid and cannot be displayed. Enter
            replacement{" "}
            {projectPath === undefined ? "host defaults" : "project commands"}{" "}
            below. Saving replaces the stored commands; it does not run them.
            {projectPath !== undefined &&
              " If host defaults are also invalid, replace them first in Settings → Hosts."}
          </p>
          {(
            [
              ["pre", "Pre"],
              ["create", "Create"],
              ["postBlocking", "Post-blocking"],
              ["postNonBlocking", "Post-non-blocking"],
            ] as const
          ).map(([stage, label]) => (
            <label key={stage} style={{ display: "grid", gap: 4 }}>
              {label} commands (one per line)
              <textarea
                style={fieldStyle}
                rows={3}
                value={replacement[stage]}
                onChange={(e) =>
                  setReplacement({ ...replacement, [stage]: e.target.value })
                }
              />
            </label>
          ))}
          <div>
            <button
              type="button"
              style={buttonStyle}
              disabled={saving}
              onClick={() => void replaceInvalidPipeline()}
            >
              Replace invalid commands
            </button>
          </div>
        </div>
      )}
      {gitProject && settings && (
        <fieldset style={{ minWidth: 0, display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
          <legend>Workspace configuration source</legend>
          <label>
            <input
              type="radio"
              name={`source-${hostId}-${projectPath}`}
              checked={settings.source === "manual"}
              onChange={() => save({ ...settings, source: "manual" })}
            />{" "}
            Manual
          </label>{" "}
          {!settings.paseo?.missing && (
            <label>
              <input
                type="radio"
                name={`source-${hostId}-${projectPath}`}
                checked={settings.source === "paseo"}
                onChange={() => save({ ...settings, source: "paseo" })}
              />{" "}
              Follow Paseo workspace setup
            </label>
          )}
        </fieldset>
      )}
      {gitProject && settings?.source === "paseo" && (
        <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
          <p>
            Follow Paseo uses the current on-disk project file, including
            uncommitted changes. It bypasses all manual project and host
            commands and uses built-in Git workspace creation, .worktreeinclude
            copying, setup and teardown.
          </p>
          <p>
            Services, scripts, terminals and port runtime are not supported.
            Future edits to the recipe will execute as your user when workspaces
            are created or deleted. Only enable this for a trusted project.
            Saving settings does not run the recipe.
          </p>
          <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
            Setup and teardown commands receive PASEO_SOURCE_CHECKOUT_PATH (the
            project checkout), PASEO_WORKTREE_PATH, and PASEO_BRANCH_NAME.
            Workspace commands also receive PASEO_PROJECT_PATH,
            PASEO_WORKSPACE_PATH, PASEO_BRANCH, PASEO_BASE_REF,
            PASEO_BRANCH_MODE, and PASEO_CREATE_RESULT as available; the
            create-result file is not used in Paseo mode.
          </p>
          <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
            Blocking setup commands run first in recipe order after the
            workspace is registered; the workspace is ready after they finish.
            Nonblocking commands then run in recipe order. Commands are
            nonblocking by default. Refresh the preview after editing the
            recipe. A blocking choice must match both its line position and
            command; if a selected line changes or moves, workspace creation is
            blocked until you review and remove the stale choice, then select
            any commands that should block readiness.
          </p>
          <div>
            <button
              type="button"
              className="dialog-action"
              style={buttonStyle}
              disabled={refreshing}
              onClick={() => void refreshPreview()}
            >
              {refreshing ? "Refreshing preview..." : "Refresh preview"}
            </button>
          </div>
          {previewError && (
            <div role="alert">Preview refresh failed: {previewError}</div>
          )}
          {settings.paseo ? (
            <div style={{ minWidth: 0 }}>
              <div>Project file: {settings.paseo.path}</div>
              {settings.paseo.fingerprint && (
                <div>Fingerprint: {settings.paseo.fingerprint}</div>
              )}
              {settings.paseo.error && (
                <div role="alert">{settings.paseo.error}</div>
              )}
              {settings.paseoBlocking
                .filter(
                  (entry) =>
                    settings.paseo!.setup[entry.index] !== entry.command,
                )
                .map((entry) => (
                  <div key={`${entry.index}-${entry.command}`} role="alert">
                    Blocking choice needs review: setup command{" "}
                    {entry.index + 1}: {entry.command}. This selection no longer
                    matches the recipe and blocks workspace creation.{" "}
                    <button
                      type="button"
                      onClick={() =>
                        save(
                          {
                            ...settings,
                            paseoBlocking: settings.paseoBlocking.filter(
                              (item) =>
                                item.index !== entry.index ||
                                item.command !== entry.command,
                            ),
                          },
                          true,
                        )
                      }
                    >
                      Remove stale choice
                    </button>
                  </div>
                ))}
              <div>
                <strong>Setup</strong>
                {settings.paseo.setup.length ? (
                  settings.paseo.setup.map((command, index) => (
                    <label
                      key={index}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "baseline",
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Block readiness for setup command ${index + 1}: ${command}`}
                        disabled={settings.paseoBlocking.some(
                          (entry) =>
                            entry.index === index && entry.command !== command,
                        )}
                        checked={settings.paseoBlocking.some(
                          (entry) =>
                            entry.index === index && entry.command === command,
                        )}
                        onChange={(e) => {
                          const paseoBlocking = settings.paseoBlocking.filter(
                            (entry) => entry.index !== index,
                          );
                          if (e.target.checked)
                            paseoBlocking.push({ index, command });
                          save({ ...settings, paseoBlocking }, true);
                        }}
                      />
                      <span>Blocking: {command}</span>
                    </label>
                  ))
                ) : (
                  <div>None</div>
                )}
              </div>
              {(
                [
                  ["Teardown", settings.paseo.teardown],
                  [
                    `.worktreeinclude (${settings.paseo.includePath})`,
                    settings.paseo.includePatterns,
                  ],
                  ["Unsupported features", settings.paseo.unsupportedFeatures],
                ] as const
              ).map(([label, values]) => (
                <div key={label}>
                  <strong>{label}</strong>
                  <pre
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {values.length ? values.join("\n") : "None"}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <div>No Paseo preview available.</div>
          )}
        </div>
      )}
      {(!gitProject || settings?.source !== "paseo") && (
        <>
          {projectPath !== undefined && settings && (
            <label>
              <input
                type="checkbox"
                checked={settings.override !== null}
                onChange={(e) =>
                  save({
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
            (
              [
                ["pre", "Pre"],
                ["create", "Create"],
                ["postBlocking", "Post-blocking"],
                ["postNonBlocking", "Post-non-blocking"],
              ] as const
            ).map(([stage, label]) => (
              <label key={stage} style={{ display: "grid", gap: 4 }}>
                {label} commands (one per line)
                <textarea
                  style={fieldStyle}
                  rows={3}
                  value={pipeline[stage].join("\n")}
                  onChange={(e) => {
                    const next = {
                      ...pipeline,
                      [stage]: e.target.value.split("\n"),
                    };
                    if (settings)
                      save(
                        projectPath === undefined
                          ? { ...settings, defaults: next }
                          : { ...settings, override: next },
                      );
                  }}
                />
              </label>
            ))}
          <p style={{ color: "var(--text-dim)", fontSize: 12 }}>
            Pre and create commands run before the workspace is registered.
            Post-blocking commands run after registration and must finish before
            the workspace is ready; post-nonblocking commands run afterward.
            Commands within each stage run in order. Commands receive
            OMP_PROJECT_PATH, OMP_WORKSPACE_PATH, OMP_BRANCH, OMP_BASE_REF,
            OMP_BRANCH_MODE and OMP_CREATE_RESULT. Write{" "}
            {`{"path":"/absolute/worktree/path"}`} to OMP_CREATE_RESULT to
            return a custom path. An empty create stage uses Git.
          </p>
        </>
      )}
      {error && (
        <div role="alert">
          {error}{" "}
          <button
            type="button"
            onClick={() =>
              settings && latestSettings.current
                ? save(latestSettings.current, latestSaveIncludesPaseo.current)
                : setRevision((n) => n + 1)
            }
          >
            Retry
          </button>
        </div>
      )}
      {!settings && !error && (
        <div role="status">Loading creation commands...</div>
      )}
      {saving && <div role="status">Saving commands...</div>}
    </section>
  );
}
