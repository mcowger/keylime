"use client";

import { useEffect, useRef, useState } from "react";
import type {
  WorkspaceCreationSettings,
  WorkspacePipeline,
} from "@/lib/workspace-creation-types";

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 13,
  lineHeight: 1.5,
  resize: "vertical",
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

const labelStyle = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  minWidth: 0,
} as const;

const descriptionStyle = {
  margin: 0,
  color: "var(--text-muted)",
  fontSize: 12.5,
  lineHeight: 1.5,
} as const;

const choiceStyle = {
  minWidth: 0,
  cursor: "pointer",
} as const;

const choiceInputStyle = {
  accentColor: "var(--accent-strong)",
  flexShrink: 0,
  width: 16,
  height: 16,
  margin: 0,
} as const;

const secondaryButtonStyle = {
  ...buttonStyle,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  color: "var(--text)",
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
        gap: 14,
        gridTemplateColumns: "minmax(0, 1fr)",
        minWidth: 0,
        borderTop: "1px solid var(--border)",
        paddingTop: 18,
        overflowWrap: "anywhere",
      }}
    >
      <h3 className="settings-section-title" style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>Creation commands</h3>
      {invalidStored && !settings && (
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <p style={descriptionStyle}>
            Stored workspace commands are invalid and cannot be displayed. Enter
            replacement{" "}
            {projectPath === undefined ? "host defaults" : "repo commands"}{" "}
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
            <label key={stage} className="settings-card" style={labelStyle}>
              <span className="settings-card-text">
                <span className="settings-card-title">{label} commands (one per line)</span>
                <span className="settings-card-desc" style={{ display: "block" }}>Replace the stored {label.toLowerCase()} stage.</span>
              </span>
              <textarea
                aria-label={`${label} commands (one per line)`}
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
        <fieldset style={{ minWidth: 0, margin: 0, padding: 0, border: 0, display: "grid", gap: 10 }}>
          <legend className="settings-section-title" style={{ padding: 0, marginBottom: 10 }}>Workspace configuration source</legend>
          <label className="settings-card" style={choiceStyle}>
            <span className="settings-card-text">
              <span className="settings-card-title">Manual</span>
              <span className="settings-card-desc" style={{ display: "block" }}>Use repo commands or inherit host defaults.</span>
            </span>
            <input
              type="radio"
              className="settings-card-control"
              style={choiceInputStyle}
              aria-label="Manual"
              name={`source-${hostId}-${projectPath}`}
              checked={settings.source === "manual"}
              onChange={() => save({ ...settings, source: "manual" })}
            />
          </label>
          {!settings.paseo?.missing && (
            <label className="settings-card" style={choiceStyle}>
              <span className="settings-card-text">
                <span className="settings-card-title">Follow Paseo workspace setup</span>
                <span className="settings-card-desc" style={{ display: "block" }}>Use the repo's on-disk Paseo recipe instead of manual commands.</span>
              </span>
              <input
                type="radio"
                className="settings-card-control"
                style={choiceInputStyle}
                aria-label="Follow Paseo workspace setup"
                name={`source-${hostId}-${projectPath}`}
                checked={settings.source === "paseo"}
                onChange={() => save({ ...settings, source: "paseo" })}
              />
            </label>
          )}
        </fieldset>
      )}
      {gitProject && settings?.source === "paseo" && (
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <p className="settings-card-desc" style={{ margin: 0 }}>
            Paseo uses the current Repo recipe, including uncommitted changes.
            Setup, teardown, and scripts or services you start run as your host
            user. Only enable this for a Repo you trust. Saving settings does
            not run the recipe.
          </p>
          <p className="settings-card-desc" style={{ margin: 0 }}>
            Refresh after editing the recipe. Changed or moved blocking commands
            must be reviewed and removed before workspace creation can continue.
          </p>
          <details className="settings-card-desc">
            <summary style={{ cursor: "pointer" }}>Command environment and execution details</summary>
          <p style={descriptionStyle}>
            Paseo uses built-in Git workspace creation, .worktreeinclude copying,
            setup and teardown. Start named scripts and services from the
            Scripts tab in the right sidebar. Services use a fixed or
            automatically assigned port on the owning host. Keylime does not
            proxy them or use custom port allocators.
          </p>
          <p style={descriptionStyle}>
            Setup and teardown commands receive PASEO_SOURCE_CHECKOUT_PATH (the
            repo checkout), PASEO_WORKTREE_PATH, and PASEO_BRANCH_NAME.
            Workspace commands also receive PASEO_PROJECT_PATH,
            PASEO_WORKSPACE_PATH, PASEO_BRANCH, PASEO_BASE_REF,
            PASEO_BRANCH_MODE, and PASEO_CREATE_RESULT as available; the
            create-result file is not used in Paseo mode.
          </p>
          <p style={descriptionStyle}>
            Blocking setup commands run first in recipe order after the
            workspace is registered; the workspace is ready after they finish.
            Nonblocking commands then run in recipe order. Commands are
            nonblocking by default. Refresh the preview after editing the
            recipe. A blocking choice must match both its line position and
            command; if a selected line changes or moves, workspace creation is
            blocked until you review and remove the stale choice, then select
            any commands that should block readiness.
          </p>
          </details>
          <div>
            <button
              type="button"
              className="dialog-action"
              style={secondaryButtonStyle}
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
            <div style={{ display: "grid", gap: 12, minWidth: 0, fontSize: 13, lineHeight: 1.5 }}>
              <div>Repo file: {settings.paseo.path}</div>
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
                      style={secondaryButtonStyle}
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
                      className="settings-card"
                      style={choiceStyle}
                    >
                      <span className="settings-card-text">
                        <span className="settings-card-title">{command}</span>
                        <span className="settings-card-desc" style={{ display: "block" }}>Block workspace readiness until this command finishes.</span>
                      </span>
                      <input
                        type="checkbox"
                        className="settings-card-control"
                        style={{ ...choiceInputStyle, marginTop: 2 }}
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
                    style={{ margin: "6px 0 0", color: "var(--text-muted)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
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
            <label className="settings-card" style={choiceStyle}>
              <span className="settings-card-text">
                <span className="settings-card-title">Override all stages</span>
                <span className="settings-card-desc" style={{ display: "block" }}>Otherwise, inherit host defaults.</span>
              </span>
              <input
                type="checkbox"
                className="settings-card-control"
                aria-label="Override all stages (otherwise inherit host defaults)"
                style={choiceInputStyle}
                checked={settings.override !== null}
                onChange={(e) =>
                  save({
                    ...settings,
                    override: e.target.checked
                      ? structuredClone(settings.defaults)
                      : null,
                  })
                }
              />
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
              <label key={stage} className="settings-card" style={labelStyle}>
                <span className="settings-card-text">
                  <span className="settings-card-title">{label} commands (one per line)</span>
                  <span className="settings-card-desc" style={{ display: "block" }}>
                    {stage === "pre" ? "Run before workspace creation." : stage === "create" ? "Create the workspace; leave empty to use Git." : stage === "postBlocking" ? "Run after registration and block readiness." : "Run after blocking commands without delaying readiness."}
                  </span>
                </span>
                <textarea
                  aria-label={`${label} commands (one per line)`}
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
          <details className="settings-card-desc">
            <summary style={{ cursor: "pointer" }}>Command execution and environment</summary>
          <p style={descriptionStyle}>
            Pre and create commands run before the workspace is registered.
            Post-blocking commands run after registration and must finish before
            the workspace is ready; post-nonblocking commands run afterward.
            Commands within each stage run in order. Commands receive
            OMP_PROJECT_PATH, OMP_WORKSPACE_PATH, OMP_BRANCH, OMP_BASE_REF,
            OMP_BRANCH_MODE and OMP_CREATE_RESULT. Write{" "}
            {`{"path":"/absolute/worktree/path"}`} to OMP_CREATE_RESULT to
            return a custom path. An empty create stage uses Git.
          </p>
          </details>
        </>
      )}
      {error && (
        <div role="alert" style={{ ...descriptionStyle, color: "var(--text)" }}>
          {error}{" "}
          <button
            type="button"
            style={secondaryButtonStyle}
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
        <div role="status" style={descriptionStyle}>Loading creation commands...</div>
      )}
      {saving && <div role="status" style={descriptionStyle}>Saving commands...</div>}
    </section>
  );
}
