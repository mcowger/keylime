"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  ThemedSelect,
} from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import type {
  ActivateHostArtifactArgs,
  DeployHostReleaseArgs,
  HostArtifactActivationResult,
  HostReleaseList,
  HostReleaseDeployFrame,
  StageHostArtifactArgs,
  StageHostArtifactResult,
} from "@/lib/api-contracts/host-control-models";
import { newUploadId, uploadFile, type UploadHandle } from "@/lib/event-stream";
import type { HostRow } from "@/lib/hosts/hub";
import { useI18n } from "@/lib/i18n";
import { LOCAL_HOST_ID } from "@/lib/project-ordering";
import { useHostRows } from "@/hooks/useHostRows";
import {
  HOST_STATUS_COLOR,
  hostName,
  hostStatusText,
  isLocalRow,
  localInstallCommand,
} from "./host-status";
import { CreationPipelineEditor } from "./CreationPipelineEditor";
import { isLinkUp } from "@/lib/hosts/host";
import { isRecord } from "@/lib/type-guards";

type Dialogs = { kind: "add" } | { kind: "rename"; host: HostRow } | null;

const inputStyle = {
  width: "100%",
  padding: "7px 9px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  font: "13px var(--font-mono)",
} as const;
const buttonStyle = {
  padding: "6px 14px",
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 13,
} as const;
const primaryStyle = {
  ...buttonStyle,
  background: "var(--accent-strong)",
  border: "none",
  color: "var(--on-accent)",
  fontWeight: 600,
} as const;

async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `HTTP ${response.status}`,
    );
  return data;
}

const failure = (error: unknown) =>
  toast.error(error instanceof Error ? error.message : String(error));

export function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)" }}
      >
        {label}
      </span>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <code
          style={{
            ...inputStyle,
            flex: 1,
            minWidth: 0,
            overflowWrap: "anywhere",
            userSelect: "all",
          }}
        >
          {value}
        </code>
        <button
          type="button"
          className="ui-focus-ring"
          style={{
            ...buttonStyle,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
          onClick={() =>
            void copyText(value).then(
              () => toast.success(t("hostsConfig.copied")),
              () => toast.error(t("hostsConfig.copyFailed")),
            )
          }
        >
          <Copy size={13} aria-hidden="true" />
          {t("hostsConfig.copy")}
        </button>
      </div>
    </div>
  );
}

/** Adding a host ends in the one-time token view. */
function HostDialog({
  dialog,
  onClose,
}: {
  dialog: NonNullable<Dialogs>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const adding = dialog.kind === "add";
  const local = dialog.kind === "rename" && dialog.host.id === "local";
  const [label, setLabel] = useState(
    dialog.kind === "rename" ? dialog.host.label : "",
  );
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const [created, setCreated] = useState<{
    token: string;
    command: string;
  } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (dialog.kind === "add") {
        const data = await call("POST", "/api/hosts", { label });
        setCreated({
          token: String(data.token),
          command: String(data.command),
        });
      } else {
        await call("PATCH", "/api/hosts", { id: dialog.host.id, label });
        onClose();
      }
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  };

  const title =
    created || adding
      ? t("hostsConfig.addTitle")
      : t("hostsConfig.renameTitle");
  return (
    // The token is shown once: only Done may close it, never Escape or an outside press.
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !created) onClose();
      }}
    >
      <DialogContent
        ariaLabel={title}
        style={{ width: 520, maxWidth: "min(92vw, 520px)", padding: 22 }}
      >
        <DialogTitle>{title}</DialogTitle>
        {created ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--text-muted)",
              }}
            >
              {t("hostsConfig.tokenIntro")}
            </p>
            <CopyField
              label={t("hostsConfig.command")}
              value={created.command}
            />
            <CopyField label={t("hostsConfig.token")} value={created.token} />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="ui-focus-ring"
                style={primaryStyle}
                onClick={onClose}
              >
                {t("hostsConfig.done")}
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(event) => void submit(event)}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            {adding && <p>{t("hostsConfig.linkEnrollmentNotice")}</p>}
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 11,
                fontWeight: 500,
                color: "var(--text-muted)",
              }}
            >
              {t("hostsConfig.name")}
              <input
                autoFocus
                aria-describedby={local ? hintId : undefined}
                value={label}
                maxLength={100}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={
                  local
                    ? t("hostsConfig.thisMachine")
                    : t("hostsConfig.namePlaceholder")
                }
                style={inputStyle}
              />
            </label>
            {local && (
              <span
                id={hintId}
                style={{
                  marginTop: -8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                {t("hostsConfig.localNameHint")}
              </span>
            )}
            <div
              style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
            >
              <button
                type="button"
                className="ui-focus-ring"
                style={buttonStyle}
                onClick={onClose}
              >
                {t("hostsConfig.cancel")}
              </button>
              <button
                type="submit"
                className="ui-focus-ring"
                style={{
                  ...primaryStyle,
                  opacity: busy || (!local && !label.trim()) ? 0.7 : 1,
                }}
                disabled={busy || (!local && !label.trim())}
              >
                {adding
                  ? t(busy ? "hostsConfig.creating" : "hostsConfig.create")
                  : t(busy ? "hostsConfig.saving" : "hostsConfig.save")}
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type ArtifactStage =
  | { kind: "idle" }
  | { kind: "uploading"; received: number }
  | { kind: "finishing" }
  | ({ kind: "staged"; id: UploadHandle["id"] } & StageHostArtifactResult)
  | { kind: "unconfirmed"; directory: string }
  | { kind: "error"; message: string };

// Give the 30s host op time to report its result over HTTP.
const ARTIFACT_FINALIZATION_TIMEOUT_MS = 40_000;

type ArtifactActivation =
  | { kind: "idle" | "installing" | "checking" }
  | { kind: "transferring"; bytes?: ReleaseTransferBytes }
  | ({ kind: "succeeded" } & ActivationBackups)
  | ({ kind: "failed"; message: string } & ActivationBackups)
  | { kind: "unconfirmed"; operationId: string };

type ActivationBackups = Pick<
  HostArtifactActivationResult,
  "backup" | "runnerBackup"
>;

type ReleaseCatalog =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; releases: HostReleaseList["releases"] }
  | { kind: "error"; message?: string };

const ACTIVATION_POLL_TIMEOUT_MS = 60_000;
const ACTIVATION_POLL_INTERVAL_MS = 2_000;

type ReleaseTransferBytes = NonNullable<
  Extract<HostReleaseDeployFrame, { type: "transfer" }>["bytes"]
>;

const releaseBuildTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

async function readReleaseDeployment(
  response: Response,
  onProgress: (state: ArtifactActivation) => void,
): Promise<{ status: number; data: unknown }> {
  if (!response.body) throw new Error("Missing deployment stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Deployment stream ended without a result");
      buffered += value;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const frame: unknown = JSON.parse(line);
        if (!isRecord(frame)) continue;
        switch (frame.type) {
          case "transfer": {
            const received = isRecord(frame.bytes)
              ? frame.bytes.received
              : undefined;
            const total = isRecord(frame.bytes) ? frame.bytes.total : undefined;
            const bytes =
              typeof received === "number" &&
              typeof total === "number" &&
              Number.isSafeInteger(received) &&
              Number.isSafeInteger(total) &&
              total > 0 &&
              received >= 0 &&
              received <= total
                ? { received, total }
                : undefined;
            onProgress({ kind: "transferring", bytes });
            break;
          }
          case "installing":
            onProgress({ kind: "installing" });
            break;
          case "result":
            return { status: response.status, data: frame.result };
          case "error":
            if (typeof frame.status === "number")
              return { status: frame.status, data: frame };
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function activationOutcome(
  result: Record<string, unknown> | null,
  failedMessage: string,
): ArtifactActivation | null {
  const state = result?.state;
  const terminal: HostArtifactActivationResult["state"] | null =
    state === "succeeded" || state === "failed" ? state : null;
  const backup = typeof result?.backup === "string" ? result.backup : undefined;
  const runnerBackup =
    typeof result?.runnerBackup === "string" ? result.runnerBackup : undefined;
  if (terminal === "succeeded")
    return { kind: "succeeded", backup, runnerBackup };
  if (terminal === "failed") {
    return {
      kind: "failed",
      backup,
      runnerBackup,
      message: typeof result?.error === "string" ? result.error : failedMessage,
    };
  }
  return null;
}

function StageArtifactDialog({
  host,
  mode,
  catalog,
  releaseAvailable,
  onActivationChange,
  onClose,
}: {
  host: HostRow;
  mode: "manual" | "release";
  catalog: ReleaseCatalog;
  releaseAvailable: boolean;
  onActivationChange: (active: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const name = hostName(t, host);
  const deployingRelease = mode === "release";
  const title = t(
    deployingRelease
      ? "hostsConfig.deployReleaseTitle"
      : "hostsConfig.stageArtifactTitle",
    { name },
  );
  const hostUrl = `/api/hosts/${encodeURIComponent(host.id)}`;
  const releasesUrl = `${hostUrl}/releases`;
  const [releaseId, setReleaseId] = useState(() =>
    catalog.kind === "loaded" ? (catalog.releases[0]?.id ?? "") : "",
  );
  const selectedRelease =
    catalog.kind === "loaded"
      ? catalog.releases.find(({ id }) => id === releaseId)
      : undefined;
  const releaseLabelId = useId();
  const canStage = !!host.canStageArtifact && isLinkUp(host.status);
  const canActivate = host.id !== LOCAL_HOST_ID && !!host.canActivateArtifact;
  const [target, setTarget] =
    useState<ActivateHostArtifactArgs["target"]>("keylime");
  const [sha256, setSha256] = useState("");
  const expectedHash = sha256.trim().toLowerCase();
  const [reviewed, setConfirming] = useState<boolean | ReleaseCatalog>(false);
  const confirming = deployingRelease
    ? reviewed === catalog
    : reviewed === true;
  const [activation, setActivation] = useState<ArtifactActivation>({
    kind: "idle",
  });
  const activationRequest = useRef<AbortController | null>(null);
  const mayRetry =
    !deployingRelease && activation.kind === "failed" && !activation.backup;
  const canConfigure = canActivate && (activation.kind === "idle" || mayRetry);
  const canInstall = deployingRelease
    ? activation.kind === "idle" &&
      releaseAvailable &&
      selectedRelease?.status === "different"
    : canConfigure &&
      isLinkUp(host.status) &&
      /^[0-9a-f]{64}$/.test(expectedHash);
  const activating =
    activation.kind === "transferring" ||
    activation.kind === "installing" ||
    activation.kind === "checking";
  const targetName = target === "keylime" ? "Keylime" : "keylime-omp";
  const available = useRef(canStage);
  const active = useRef<UploadHandle | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<ArtifactStage>({ kind: "idle" });
  const busy = stage.kind === "uploading" || stage.kind === "finishing";
  const done = stage.kind === "staged" || stage.kind === "unconfirmed";
  const release = useCallback((handle: UploadHandle) => {
    if (active.current !== handle) return;
    active.current = null;
    handle.abort();
  }, []);

  useEffect(() => {
    available.current = canStage;
  }, [canStage]);

  useEffect(() => {
    return () => {
      const handle = active.current;
      if (handle) release(handle);
      activationRequest.current?.abort();
    };
  }, [release]);

  function close() {
    if (stage.kind === "finishing" || activationRequest.current) return;
    const handle = active.current;
    if (handle) release(handle);
    onClose();
  }

  async function install() {
    if (!confirming || !canInstall || activationRequest.current) return;

    const operationId = newUploadId();
    const artifactsUrl = `${hostUrl}/artifacts`;
    const statusUrl = `${artifactsUrl}?operationId=${encodeURIComponent(operationId)}`;
    let requestBody: DeployHostReleaseArgs | ActivateHostArtifactArgs;
    if (deployingRelease) {
      requestBody = { releaseId, operationId };
    } else {
      if (stage.kind !== "staged") return;
      requestBody = {
        artifactId: stage.id,
        operationId,
        target,
        sha256: expectedHash,
      };
    }
    const controller = new AbortController();
    const { signal } = controller;
    const failedMessage = t("hostsConfig.activateArtifactFailed");
    activationRequest.current = controller;
    setConfirming(false);
    onActivationChange(true);
    setActivation({ kind: deployingRelease ? "transferring" : "installing" });

    try {
      try {
        const response = await fetch(
          deployingRelease ? releasesUrl : artifactsUrl,
          {
            method: deployingRelease ? "POST" : "PATCH",
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(deployingRelease ? 120_000 : 40_000),
            ]),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          },
        );
        const { status, data } =
          deployingRelease && response.ok
            ? await readReleaseDeployment(response, (state) => {
                if (!signal.aborted) setActivation(state);
              })
            : {
                status: response.status,
                data: (await response.json()) as unknown,
              };
        if (signal.aborted) return;
        const result = isRecord(data) ? data : null;
        const outcome =
          status < 300 ? activationOutcome(result, failedMessage) : null;
        if (outcome) {
          setActivation(outcome);
          return;
        }
        if (
          ((status >= 400 && status < 500 && status !== 408) ||
            (status === 501 &&
              result?.code === "host_activation_unsupported")) &&
          typeof result?.code === "string" &&
          typeof result.error === "string"
        ) {
          setActivation({ kind: "failed", message: result.error });
          return;
        }
      } catch {
        // A lost reply doesn't tell us whether the host accepted the install.
      }

      if (signal.aborted) return;
      setActivation({ kind: "checking" });
      const polling = AbortSignal.any([
        signal,
        AbortSignal.timeout(ACTIVATION_POLL_TIMEOUT_MS),
      ]);
      while (!polling.aborted) {
        try {
          const response = await fetch(statusUrl, {
            cache: "no-store",
            signal: AbortSignal.any([polling, AbortSignal.timeout(5_000)]),
          });
          if (response.ok) {
            const data: unknown = await response.json();
            const outcome = activationOutcome(
              isRecord(data) ? data : null,
              failedMessage,
            );
            if (!polling.aborted && outcome) {
              setActivation(outcome);
              return;
            }
          }
        } catch {
          // The daemon can disconnect during restart. Keep checking this operation only.
        }
        if (!polling.aborted) {
          const { promise, resolve } = Promise.withResolvers<void>();
          const wake = () => {
            window.clearTimeout(timer);
            polling.removeEventListener("abort", wake);
            resolve();
          };
          const timer = window.setTimeout(wake, ACTIVATION_POLL_INTERVAL_MS);
          polling.addEventListener("abort", wake, { once: true });
          await promise;
        }
      }
      if (!signal.aborted) setActivation({ kind: "unconfirmed", operationId });
    } finally {
      activationRequest.current = null;
      if (!signal.aborted) onActivationChange(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (deployingRelease || !file || !canStage || active.current || done)
      return;
    let handle: UploadHandle | null = null;
    let unconfirmedDirectory: string | null = null;
    let finalizationTimer: number | undefined;
    setStage({ kind: "uploading", received: 0 });
    try {
      handle = uploadFile(file, host.id, (received) => {
        if (handle && active.current === handle) {
          setStage((current) =>
            current.kind === "uploading"
              ? { kind: "uploading", received }
              : current,
          );
        }
      });
      active.current = handle;
      await handle.promise;
      if (active.current !== handle) return;
      if (!available.current) {
        throw new Error(t("hostsConfig.stageArtifactUnavailable"));
      }

      setStage({ kind: "finishing" });
      unconfirmedDirectory = `<agent dir>/keylime/host-artifacts/${handle.id}`;
      const controller = new AbortController();
      finalizationTimer = window.setTimeout(
        () => controller.abort(),
        ARTIFACT_FINALIZATION_TIMEOUT_MS,
      );
      const response = await fetch(
        `/api/hosts/${encodeURIComponent(host.id)}/artifacts`,
        {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: handle.id,
          } satisfies StageHostArtifactArgs),
        },
      );
      const data: unknown = await response.json();
      const result = isRecord(data) ? data : null;
      if (active.current !== handle) return;
      if (response.ok && typeof result?.path === "string" && result.path) {
        setStage({ kind: "staged", id: handle.id, path: result.path });
      } else if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        typeof result?.error === "string" &&
        typeof result.code === "string"
      ) {
        unconfirmedDirectory = null;
        throw new Error(result.error);
      } else {
        setStage({ kind: "unconfirmed", directory: unconfirmedDirectory });
      }
    } catch (error) {
      if (handle && active.current !== handle) return;
      setStage(
        unconfirmedDirectory
          ? { kind: "unconfirmed", directory: unconfirmedDirectory }
          : {
              kind: "error",
              message: error instanceof Error ? error.message : String(error),
            },
      );
    } finally {
      window.clearTimeout(finalizationTimer);
      if (handle) release(handle);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        ariaLabel={title}
        style={{ width: 520, maxWidth: "min(92vw, 520px)", padding: 22 }}
      >
        <DialogTitle>{title}</DialogTitle>
        <form
          onSubmit={(event) => void submit(event)}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          {host.platform && <span>{host.platform}</span>}
          {deployingRelease && activation.kind === "idle" && (
            <>
              {catalog.kind === "loading" && (
                <div role="status">{t("hostsConfig.deployReleaseLoading")}</div>
              )}
              {catalog.kind === "error" && (
                <div role="alert" style={{ color: "var(--status-error)" }}>
                  {catalog.message ?? t("hostsConfig.deployReleaseListFailed")}
                </div>
              )}
              {catalog.kind === "loaded" && catalog.releases.length === 0 && (
                <div role="status">{t("hostsConfig.deployReleaseEmpty")}</div>
              )}
              {catalog.kind === "loaded" && catalog.releases.length > 0 && (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <span id={releaseLabelId}>
                    {t("hostsConfig.deployReleaseVersion")}
                  </span>
                  <ThemedSelect
                    aria-labelledby={releaseLabelId}
                    value={releaseId}
                    disabled={
                      confirming ||
                      activation.kind !== "idle" ||
                      !releaseAvailable
                    }
                    onChange={setReleaseId}
                    options={catalog.releases.map(({ id, builtAt }, index) => {
                      const stamp = Date.parse(builtAt);
                      return {
                        value: id,
                        label: (
                          <span
                            style={{
                              display: "block",
                              whiteSpace: "normal",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {index === 0
                              ? t("hostsConfig.deployReleaseNewest", { id })
                              : id}
                            {Number.isFinite(stamp) && (
                              <time
                                dateTime={builtAt}
                                style={{
                                  display: "block",
                                  color: "var(--text-muted)",
                                }}
                              >
                                {releaseBuildTime.format(stamp)}
                              </time>
                            )}
                          </span>
                        ),
                      };
                    })}
                  />
                  {selectedRelease?.status === "installed" && (
                    <div role="status">
                      {t("hostsConfig.releaseAlreadyInstalled")}
                    </div>
                  )}
                  {(!selectedRelease ||
                    selectedRelease.status === "unknown") && (
                    <div role="status">
                      {t("hostsConfig.releaseSelectionUnconfirmed")}
                    </div>
                  )}
                </div>
              )}
              {!releaseAvailable && (
                <div role="status">
                  {t("hostsConfig.deployReleaseUnavailable")}
                </div>
              )}
              {confirming && (
                <p role="status" style={{ margin: 0 }}>
                  {t("hostsConfig.deployReleaseConfirm", {
                    name,
                    id: releaseId,
                  })}
                </p>
              )}
            </>
          )}
          {!deployingRelease && !done && (
            <p style={{ margin: 0 }}>
              {t("hostsConfig.stageArtifactDescription")}
            </p>
          )}
          {!deployingRelease && !done && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {t("hostsConfig.stageArtifactFile")}
              <input
                type="file"
                required
                disabled={busy || !canStage}
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null);
                  setStage({ kind: "idle" });
                }}
                style={inputStyle}
              />
            </label>
          )}
          {stage.kind === "uploading" && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {t("hostsConfig.stageArtifactUploading")}
              <progress max={file?.size || 1} value={stage.received} />
            </label>
          )}
          <div role="status">
            {stage.kind === "finishing" &&
              t("hostsConfig.stageArtifactFinishing")}
            {stage.kind === "staged" &&
              activation.kind === "idle" &&
              t("hostsConfig.stageArtifactStaged")}
            {activation.kind === "transferring" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {t("hostsConfig.deployReleaseTransferring")}
                <progress
                  aria-label={t("hostsConfig.deployReleaseTransferring")}
                  style={{ width: "100%", accentColor: "var(--accent)" }}
                  max={activation.bytes?.total}
                  value={activation.bytes?.received}
                />
              </div>
            )}
            {activation.kind === "installing" &&
              t("hostsConfig.activateArtifactInstalling")}
            {activation.kind === "checking" &&
              t("hostsConfig.activateArtifactChecking")}
            {activation.kind === "succeeded" &&
              (deployingRelease
                ? t("hostsConfig.deployReleaseSucceeded", {
                    name,
                    id: releaseId,
                  })
                : t("hostsConfig.activateArtifactSucceeded", {
                    name,
                    target: targetName,
                  }))}
            {!deployingRelease &&
              stage.kind === "idle" &&
              !canStage &&
              t("hostsConfig.stageArtifactUnavailable")}
          </div>
          {stage.kind === "staged" && (
            <CopyField
              label={t("hostsConfig.stageArtifactPath")}
              value={stage.path}
            />
          )}
          {(activation.kind === "succeeded" || activation.kind === "failed") &&
            activation.backup && (
              <CopyField
                label={t(
                  deployingRelease
                    ? "hostsConfig.deployReleaseDaemonBackup"
                    : "hostsConfig.activateArtifactBackup",
                )}
                value={activation.backup}
              />
            )}
          {(activation.kind === "succeeded" || activation.kind === "failed") &&
            activation.runnerBackup && (
              <CopyField
                label={t("hostsConfig.deployReleaseRunnerBackup")}
                value={activation.runnerBackup}
              />
            )}
          {stage.kind === "staged" && canConfigure && (
            <>
              <label
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                {t("hostsConfig.activateArtifactTarget")}
                <select
                  value={target}
                  disabled={confirming}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === "keylime" || value === "keylime-omp")
                      setTarget(value);
                  }}
                  style={inputStyle}
                >
                  <option value="keylime">Keylime</option>
                  <option value="keylime-omp">keylime-omp</option>
                </select>
              </label>
              <label
                style={{ display: "flex", flexDirection: "column", gap: 4 }}
              >
                {t("hostsConfig.activateArtifactSha256")}
                <input
                  type="text"
                  value={sha256}
                  disabled={confirming}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setSha256(event.currentTarget.value)}
                  style={inputStyle}
                />
              </label>
              {confirming && (
                <p role="status" style={{ margin: 0 }}>
                  {t("hostsConfig.activateArtifactConfirm", {
                    name,
                    target: targetName,
                  })}
                </p>
              )}
            </>
          )}
          {activation.kind === "failed" && (
            <div role="alert" style={{ color: "var(--status-error)" }}>
              {activation.message}
            </div>
          )}
          {activation.kind === "unconfirmed" && (
            <>
              <div role="alert">
                {t("hostsConfig.activateArtifactUnconfirmed", { name })}
              </div>
              <CopyField
                label={t("hostsConfig.activateArtifactOperationId")}
                value={activation.operationId}
              />
            </>
          )}
          {stage.kind === "unconfirmed" && (
            <>
              <div role="alert">
                {t("hostsConfig.stageArtifactUnconfirmed")}
              </div>
              <CopyField
                label={t("hostsConfig.stageArtifactInspect")}
                value={stage.directory}
              />
            </>
          )}
          {stage.kind === "error" && (
            <div role="alert" style={{ color: "var(--status-error)" }}>
              {stage.message}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              className="ui-focus-ring"
              style={buttonStyle}
              disabled={stage.kind === "finishing" || activating}
              onClick={confirming ? () => setConfirming(false) : close}
            >
              {t(
                (deployingRelease ? activation.kind === "idle" : !done) ||
                  confirming
                  ? "hostsConfig.cancel"
                  : stage.kind === "staged" &&
                      canActivate &&
                      activation.kind === "idle"
                    ? "hostsConfig.activateArtifactStageOnly"
                    : "hostsConfig.stageArtifactClose",
              )}
            </button>
            {(deployingRelease
              ? catalog.kind === "loaded" &&
                !!releaseId &&
                activation.kind === "idle"
              : stage.kind === "staged" && canConfigure) && (
              <button
                type="button"
                className="ui-focus-ring"
                style={
                  deployingRelease && !canInstall ? buttonStyle : primaryStyle
                }
                disabled={!canInstall}
                onClick={
                  confirming
                    ? () => void install()
                    : () => setConfirming(deployingRelease ? catalog : true)
                }
              >
                {deployingRelease
                  ? t(
                      confirming
                        ? "hostsConfig.deployReleaseInstall"
                        : "hostsConfig.deployReleaseReview",
                    )
                  : t(
                      confirming
                        ? "hostsConfig.activateArtifactInstall"
                        : activation.kind === "failed"
                          ? "hostsConfig.activateArtifactRetry"
                          : "hostsConfig.activateArtifactReview",
                    )}
              </button>
            )}
            {!deployingRelease && !done && (
              <button
                type="submit"
                className="ui-focus-ring"
                style={primaryStyle}
                disabled={!file || !canStage || busy}
              >
                {t("hostsConfig.stageArtifact")}
              </button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HostCard({
  host,
  onRename,
  onRevoke,
}: {
  host: HostRow;
  onRename: () => void;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  const name = hostName(t, host);
  const [artifactMode, setArtifactMode] = useState<"manual" | "release" | null>(
    null,
  );
  const remote = isLocalRow(host) ? null : host;
  const linked = isLinkUp(host.status);
  const releaseAvailable =
    !!remote?.canActivateArtifact && !!remote.arch && linked;
  const [{ active: activationInProgress, generation }, setActivationState] =
    useState({ active: false, generation: 0 });
  const releasesUrl = `/api/hosts/${encodeURIComponent(host.id)}/releases`;
  const request = useMemo(
    () =>
      releaseAvailable && !activationInProgress
        ? { url: releasesUrl, generation }
        : null,
    [
      releaseAvailable,
      activationInProgress,
      generation,
      releasesUrl,
      host.platform,
      host.arch,
      host.keylimeVersion,
      host.ompVersion,
    ],
  );
  const [comparison, setComparison] = useState<{
    request: NonNullable<typeof request>;
    catalog: ReleaseCatalog;
  } | null>(null);
  // A result belongs only to the request for this link and activation state.
  const catalog: ReleaseCatalog = !request
    ? { kind: "idle" }
    : comparison?.request === request
      ? comparison.catalog
      : { kind: "loading" };

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const { signal } = controller;
    const finish = (catalog: ReleaseCatalog) => {
      if (!signal.aborted) setComparison({ request, catalog });
    };
    void (async () => {
      try {
        const response = await fetch(request.url, {
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        const data: unknown = await response.json();
        if (!response.ok) {
          finish({
            kind: "error",
            message:
              isRecord(data) && typeof data.error === "string"
                ? data.error
                : undefined,
          });
          return;
        }
        if (!isRecord(data) || !Array.isArray(data.releases)) {
          finish({ kind: "error" });
          return;
        }
        const releases: HostReleaseList["releases"] = [];
        for (const item of data.releases as unknown[]) {
          if (
            !isRecord(item) ||
            typeof item.id !== "string" ||
            typeof item.builtAt !== "string" ||
            (item.status !== "installed" &&
              item.status !== "different" &&
              item.status !== "unknown")
          ) {
            finish({ kind: "error" });
            return;
          }
          releases.push({
            id: item.id,
            builtAt: item.builtAt,
            status: item.status,
          });
        }
        finish({ kind: "loaded", releases });
      } catch {
        finish({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [request]);

  const newest = catalog.kind === "loaded" ? catalog.releases[0] : undefined;
  const releaseStatus = !linked
    ? "hostsConfig.releaseComparisonOffline"
    : catalog.kind === "loading" || activationInProgress
      ? "hostsConfig.releaseComparisonChecking"
      : catalog.kind !== "loaded" || newest?.status === "unknown"
        ? "hostsConfig.releaseComparisonFailed"
        : !newest
          ? "hostsConfig.releaseComparisonEmpty"
          : newest.status === "installed"
            ? "hostsConfig.releaseComparisonCurrent"
            : "hostsConfig.releaseComparisonDifferent";
  const versionText = (version?: string | null) => {
    if (!version) return t("hostsConfig.binaryVersionUnavailable");
    return linked
      ? version
      : t("hostsConfig.binaryVersionLastReported", { version });
  };
  const details = [
    host.platform,
    host.hostVersion !== null &&
      host.status !== "needs-upgrade" &&
      t("hostsConfig.protocol", { version: host.hostVersion }),
    remote &&
      (host.lastSeenAt
        ? t("hostsConfig.lastSeen", {
            time: new Date(host.lastSeenAt).toLocaleString(),
          })
        : t("hostsConfig.neverSeen")),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li
      className="settings-card"
      style={{ flexWrap: "wrap", listStyle: "none" }}
    >
      <div className="settings-card-text">
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              flexShrink: 0,
              background: HOST_STATUS_COLOR[host.status],
            }}
          />
          <strong
            style={{
              fontSize: 14,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </strong>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {hostStatusText(t, host)}
          </span>
        </div>
        {details && (
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: "var(--text-dim)",
              overflowWrap: "anywhere",
            }}
          >
            {details}
          </div>
        )}
        {remote && (
          <div
            style={{
              marginTop: 4,
              fontSize: 12,
              color: "var(--text-muted)",
              overflowWrap: "anywhere",
            }}
          >
            <div>
              {t("hostsConfig.binaryVersions", {
                keylime: versionText(remote.keylimeVersion),
                omp: versionText(remote.ompVersion),
              })}
            </div>
            <div role="status">{t(releaseStatus)}</div>
          </div>
        )}
        {isLocalRow(host) &&
          host.daemonManaged &&
          host.status === "offline" && (
            <div
              style={{
                marginTop: 6,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
              {t("hostsConfig.localOfflineHint")}
              <CopyField
                label={t("hostsConfig.command")}
                value={localInstallCommand(host.serverPlatform)}
              />
              {t("hostsConfig.localForegroundHint")}
              <CopyField
                label={t("hostsConfig.command")}
                value="keylime host"
              />
            </div>
          )}
      </div>
      <div
        className="settings-card-control"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          flexShrink: 1,
          maxWidth: "100%",
        }}
      >
        {remote && (
          <button
            type="button"
            className="ui-focus-ring"
            style={newest?.status === "different" ? primaryStyle : buttonStyle}
            aria-label={t("hostsConfig.deployReleaseTitle", { name })}
            disabled={newest?.status !== "different"}
            onClick={() => setArtifactMode("release")}
          >
            {t("hostsConfig.deployRelease")}
          </button>
        )}
        <button
          type="button"
          className="ui-focus-ring"
          style={buttonStyle}
          disabled={!host.canStageArtifact || !isLinkUp(host.status)}
          aria-label={t("hostsConfig.stageArtifactTitle", { name })}
          onClick={() => setArtifactMode("manual")}
        >
          {t("hostsConfig.stageArtifact")}
        </button>
        <button
          type="button"
          className="ui-focus-ring"
          aria-label={t("hostsConfig.renameAria", { name })}
          style={{
            ...buttonStyle,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
          onClick={onRename}
        >
          <Pencil size={13} aria-hidden="true" />
          {t("hostsConfig.rename")}
        </button>
        {remote && (
          <button
            type="button"
            className="ui-focus-ring"
            style={{
              ...buttonStyle,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
            onClick={onRevoke}
          >
            <Trash2 size={13} aria-hidden="true" />
            {t("hostsConfig.revoke")}
          </button>
        )}
      </div>
      {artifactMode && (
        <StageArtifactDialog
          host={host}
          mode={artifactMode}
          catalog={catalog}
          releaseAvailable={releaseAvailable}
          onActivationChange={(active) =>
            setActivationState(({ generation }) => ({
              active,
              generation: active ? generation : generation + 1,
            }))
          }
          onClose={() => setArtifactMode(null)}
        />
      )}
    </li>
  );
}

export function HostsConfig() {
  const { t } = useI18n();
  const { hosts, failed: loadFailed } = useHostRows();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [revoking, setRevoking] = useState<HostRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [creationHostId, setCreationHostId] = useState(LOCAL_HOST_ID);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await call("DELETE", `/api/hosts?id=${encodeURIComponent(revoking.id)}`);
      toast.success(t("hostsConfig.revoked", { name: revoking.label }));
      setRevoking(null);
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        width: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--text-muted)",
            lineHeight: 1.45,
          }}
        >
          {t("hostsConfig.subtitle")}
          {hosts?.[0] && (
            <span style={{ display: "block" }}>
              {t("hostsConfig.serverProtocol", {
                version: hosts[0].serverVersion,
              })}
            </span>
          )}
        </p>
        <button
          type="button"
          className="ui-focus-ring"
          style={{
            ...primaryStyle,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            flexShrink: 0,
          }}
          onClick={() => setDialog({ kind: "add" })}
        >
          <Plus size={14} aria-hidden="true" />
          {t("hostsConfig.add")}
        </button>
      </div>
      {loadFailed && (
        <div
          role="alert"
          style={{ fontSize: 12, color: "var(--status-error)" }}
        >
          {t("hostsConfig.loadFailed")}
        </div>
      )}
      {hosts === null ? (
        !loadFailed && (
          <div role="status" style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {t("hostsConfig.loading")}
          </div>
        )
      ) : (
        <ul
          aria-label={t("hostsConfig.title")}
          style={{ margin: 0, padding: 0 }}
        >
          {hosts.map((host) => (
            <HostCard
              key={host.id}
              host={host}
              onRename={() => setDialog({ kind: "rename", host })}
              onRevoke={() => setRevoking(host)}
            />
          ))}
          {hosts.length === 1 && (
            <li
              style={{
                listStyle: "none",
                fontSize: 12,
                color: "var(--text-dim)",
              }}
            >
              {t("hostsConfig.empty")}
            </li>
          )}
        </ul>
      )}
      <section style={{ display: "grid", gap: 12, marginTop: 24 }}>
        <h2>Host creation defaults</h2>
        <label>
          Host{" "}
          {hosts && (
            <select
              value={creationHostId}
              onChange={(event) => setCreationHostId(event.target.value)}
            >
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {hostName(t, host)} ({hostStatusText(t, host)})
                </option>
              ))}
            </select>
          )}
        </label>
        {hosts?.some(
          (host) => host.id === creationHostId && isLinkUp(host.status),
        ) ? (
          <CreationPipelineEditor
            key={creationHostId}
            hostId={creationHostId}
          />
        ) : (
          hosts && (
            <p role="status">
              Creation defaults are unavailable while this host is offline.
            </p>
          )
        )}
      </section>
      {dialog && <HostDialog dialog={dialog} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t("hostsConfig.revokeTitle", { name: revoking?.label ?? "" })}
        description={t("hostsConfig.revokeDescription")}
        confirmLabel={t("hostsConfig.revoke")}
        cancelLabel={t("hostsConfig.cancel")}
        danger
        busy={busy}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}
