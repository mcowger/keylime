"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import {
  clusterJoinBlock,
  clusterOf,
  isClusterMember,
} from "@/lib/hosts/cluster";
import type { HostRow } from "@/lib/hosts/hub";
import type { HostPool } from "@/lib/hosts/pools";
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

type Dialogs =
  | { kind: "add" }
  | { kind: "rename"; host: HostRow }
  | { kind: "renameCluster"; pool: HostPool }
  | null;

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

/** Name form shared by "Add host" and "Rename" (a host or the cluster); adding ends in the one-time token view. */
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
    dialog.kind === "rename"
      ? dialog.host.label
      : dialog.kind === "renameCluster"
        ? dialog.pool.label
        : "",
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
      } else if (dialog.kind === "renameCluster") {
        await call("PATCH", "/api/hosts", { poolId: dialog.pool.id, label });
        onClose();
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
      : dialog.kind === "renameCluster"
        ? t("hostsConfig.renameClusterTitle")
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
            {adding && <p>{t("hostsConfig.linkTrustNotice")}</p>}
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

type ClusterState = {
  pools: HostPool[];
  masterFailed: boolean;
};

const joinBlock = (row: HostRow) =>
  clusterJoinBlock({
    status: row.status,
    ompVersion: row.ompVersion,
    supports: (operation) => row.workspaceOps.includes(operation),
  });

function HostCard({
  host,
  cluster,
  onRename,
  onRevoke,
}: {
  host: HostRow;
  cluster: ClusterState;
  onRename: () => void;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  const name = hostName(t, host);
  const linked = isLocalRow(host) ? null : host;
  const member = isClusterMember(cluster.pools, host.id);
  const details = [
    host.platform,
    host.hostVersion !== null &&
      host.status !== "needs-upgrade" &&
      t("hostsConfig.protocol", { version: host.hostVersion }),
    linked &&
      (host.lastSeenAt
        ? t("hostsConfig.lastSeen", {
            time: new Date(host.lastSeenAt).toLocaleString(),
          })
        : t("hostsConfig.neverSeen")),
  ]
    .filter(Boolean)
    .join(" · ");
  const memberBlock = linked ? joinBlock(host) : null;
  const outdated = memberBlock === "upgrade" || memberBlock === "needs-upgrade";
  const config = !outdated ? linked?.clusterConfig : undefined;
  const updating = cluster.masterFailed
    ? null
    : t("hostsConfig.configUpdating");
  const configLine =
    !linked || host.status === "offline"
      ? null
      : outdated
        ? t("hostsConfig.joinUpgrade")
        : !config
          ? updating
          : config.version !== null && !config.owned
            ? t("hostsConfig.configHeldElsewhere")
            : config.error
              ? t("hostsConfig.configFailed", { reason: config.error })
              : config.current
                ? t("hostsConfig.configCurrent")
                : updating;

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
        {configLine && (
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: "var(--text-muted)",
              overflowWrap: "anywhere",
            }}
          >
            {configLine}
          </div>
        )}
        {configLine && config?.missingCommands.length ? (
          <div
            style={{
              marginTop: 2,
              fontSize: 11,
              color: "var(--text-muted)",
              overflowWrap: "anywhere",
            }}
          >
            {t("hostsConfig.configMissing", {
              commands: config.missingCommands.join(", "),
            })}
          </div>
        ) : null}
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
              <CopyField label={t("hostsConfig.command")} value="keylime host" />
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
        {isLocalRow(host) && member && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("hostsConfig.clusterMaster")}
          </span>
        )}
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
        {linked && (
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
    </li>
  );
}

export function HostsConfig() {
  const { t } = useI18n();
  const {
    hosts,
    pools,
    failed: loadFailed,
    masterConfigError,
  } = useHostRows();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [revoking, setRevoking] = useState<HostRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [creationHostId, setCreationHostId] = useState(LOCAL_HOST_ID);
  const cluster = clusterOf(pools);
  const hasLinkedHosts = hosts?.some((host) => !isLocalRow(host));

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
      {cluster && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: "var(--text)",
              fontWeight: 500,
              overflowWrap: "anywhere",
            }}
          >
            {t("hostsConfig.clusterName", { name: cluster.label })}
          </span>
          <button
            type="button"
            className="ui-focus-ring"
            style={{
              ...buttonStyle,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
            }}
            onClick={() => setDialog({ kind: "renameCluster", pool: cluster })}
          >
            <Pencil size={13} aria-hidden="true" />
            {t("hostsConfig.renameCluster")}
          </button>
        </div>
      )}
      {loadFailed && (
        <div
          role="alert"
          style={{ fontSize: 12, color: "var(--status-error)" }}
        >
          {t("hostsConfig.loadFailed")}
        </div>
      )}
      {masterConfigError && hasLinkedHosts && (
        <div
          role="alert"
          style={{
            fontSize: 12,
            color: "var(--status-error)",
            overflowWrap: "anywhere",
          }}
        >
          {t("hostsConfig.masterConfigFailed", {
            reason: masterConfigError.message,
          })}
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
              cluster={{
                pools,
                masterFailed: masterConfigError !== null,
              }}
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
