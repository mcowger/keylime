"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, RefreshCw } from "lucide-react";
import { stripAnsi } from "@/lib/ansi";
import { useI18n } from "@/lib/i18n";
import type { JobActivity } from "@/lib/jobs-types";
import { useJobs } from "@/hooks/useJobs";

const buttonStyle = {
  cursor: "pointer",
  color: "var(--text)",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  padding: "5px 8px",
} as const;

function elapsed(job: JobActivity, now: number) {
  const seconds = Math.max(
    0,
    Math.floor(((job.endTime ?? now) - job.startTime) / 1000),
  );
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours}h ${minutes}m`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`;
}

export function JobsPanel({
  sessionId,
  enabled,
  isMobile,
}: {
  sessionId: string | null;
  enabled: boolean;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const {
    snapshot,
    selected,
    detail,
    output,
    loading,
    error,
    select,
    cancel,
    refresh,
  } = useJobs(sessionId, enabled);
  const [follow, setFollow] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const outputRef = useRef<HTMLPreElement>(null);
  const clean = stripAnsi(output).replace(
    /[\x00-\x08\x0B-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
    "",
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  useEffect(() => {
    setFollow(true);
    setActionError(null);
  }, [sessionId, selected?.id, selected?.kind, selected?.incarnation]);
  useEffect(() => {
    if (follow && outputRef.current)
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [clean, follow, selected?.id, selected?.kind, selected?.incarnation]);

  const rows = (items: JobActivity[]) =>
    items.map((job) => (
      <button
        key={`${job.kind}:${job.id}:${job.incarnation}`}
        type="button"
        onClick={() => select(job)}
        aria-pressed={
          selected?.kind === job.kind &&
          selected.id === job.id &&
          selected.incarnation === job.incarnation
        }
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "9px 10px",
          border: 0,
          borderBottom: "1px solid var(--border)",
          background:
            selected?.kind === job.kind &&
            selected.id === job.id &&
            selected.incarnation === job.incarnation
              ? "var(--bg-hover)"
              : "transparent",
          color: "var(--text)",
          cursor: "pointer",
        }}
      >
        <span
          style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
        >
          <strong style={{ overflowWrap: "anywhere" }}>{job.label}</strong>
          <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>
            {job.status}
          </span>
        </span>
        {job.command && (
          <span
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text-muted)",
              fontFamily: "monospace",
            }}
            title={job.command}
          >
            {job.command}
          </span>
        )}
        <span
          style={{
            display: "block",
            color: "var(--text-muted)",
            fontSize: "var(--text-xs)",
          }}
        >
          {job.ownerId ? `${t("jobs.owner")}: ${job.ownerId} · ` : ""}
          {t("jobs.elapsed", { time: elapsed(job, now) })}
        </span>
      </button>
    ));
  const field = (label: string, value: string | number | undefined) =>
    value === undefined || value === "" ? null : (
      <div>
        <dt style={{ color: "var(--text-muted)" }}>{label}</dt>
        <dd
          style={{
            margin: "2px 0 8px",
            overflowWrap: "anywhere",
            whiteSpace: "pre-wrap",
          }}
        >
          {value}
        </dd>
      </div>
    );
  const retained =
    selected && selected.kind !== "service" && selected.endTime !== undefined;

  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        color: "var(--text)",
        fontSize: "var(--text-sm)",
      }}
    >
      <div
        style={{
          display: isMobile && selected ? "none" : "flex",
          flexDirection: "column",
          width: selected && !isMobile ? "40%" : "100%",
          minWidth: 0,
          overflow: "auto",
          borderRight:
            selected && !isMobile ? "1px solid var(--border)" : undefined,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: 10,
          }}
        >
          <strong>{t("jobs.title")}</strong>
          <button
            type="button"
            style={buttonStyle}
            onClick={refresh}
            aria-label={t("jobs.refresh")}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {!sessionId ? (
          <p style={{ padding: 10 }}>{t("jobs.selectSession")}</p>
        ) : loading && !snapshot ? (
          <p style={{ padding: 10 }}>{t("jobs.loading")}</p>
        ) : !snapshot?.available ? (
          <p style={{ padding: 10 }}>{t("jobs.unavailable")}</p>
        ) : (
          <>
            {snapshot.jobs.length ? (
              rows(snapshot.jobs)
            ) : (
              <p style={{ padding: "0 10px", color: "var(--text-muted)" }}>
                {t("jobs.empty")}
              </p>
            )}
            <strong style={{ padding: 10 }}>{t("jobs.services")}</strong>
            {snapshot.servicesError ? (
              <p role="alert" style={{ padding: "0 10px" }}>
                {t("jobs.servicesError", { error: snapshot.servicesError })}
              </p>
            ) : snapshot.services.length ? (
              rows(snapshot.services)
            ) : (
              <p style={{ padding: "0 10px", color: "var(--text-muted)" }}>
                {t("jobs.servicesEmpty")}
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" style={{ padding: 10 }}>
            {error}
          </p>
        )}
      </div>
      {selected && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            padding: 10,
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => select(null)}
              aria-label={t("jobs.back")}
            >
              <ArrowLeft size={14} />
            </button>
            <strong style={{ overflowWrap: "anywhere", flex: 1 }}>
              {selected.label}
            </strong>
            <span>{selected.status}</span>
          </div>
          <div style={{ overflow: "auto", flexShrink: 1 }}>
            <dl style={{ margin: 0 }}>
              {field(t("jobs.command"), detail?.command ?? selected.command)}
              {field(t("jobs.cwd"), detail?.cwd)}
              {field(t("jobs.owner"), selected.ownerId)}
              {field(
                t("jobs.pids"),
                detail?.pids.length ? detail.pids.join(", ") : undefined,
              )}
              {field(
                t("jobs.started"),
                new Date(selected.startTime).toLocaleString(),
              )}
              {field(
                t("jobs.ended"),
                selected.endTime !== undefined
                  ? new Date(selected.endTime).toLocaleString()
                  : undefined,
              )}
              {field(t("jobs.exit"), detail?.exitCode)}
            </dl>
            {retained && (
              <p style={{ color: "var(--text-muted)" }}>{t("jobs.retained")}</p>
            )}
            {selected.canCancel && (
              <button type="button" style={buttonStyle} onClick={cancel}>
                {t(selected.kind === "service" ? "jobs.stop" : "jobs.cancel")}
              </button>
            )}
            {(actionError || error) && (
              <p role="alert">{actionError || error}</p>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong style={{ flex: 1 }}>{t("jobs.output")}</strong>
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />{" "}
              {t("jobs.follow")}
            </label>
            <button
              type="button"
              style={buttonStyle}
              aria-label={t("jobs.copy")}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(clean);
                } catch {
                  setActionError(t("jobs.copyFailed"));
                }
              }}
            >
              <Copy size={14} />
            </button>
          </div>
          {detail?.truncated && (
            <div style={{ color: "var(--text-muted)" }}>
              {t("jobs.truncated")}
            </div>
          )}
          <pre
            ref={outputRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight > 8)
                setFollow(false);
            }}
            style={{
              margin: 0,
              padding: 8,
              flex: 1,
              minHeight: 80,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
            }}
          >
            {clean}
          </pre>
        </div>
      )}
    </div>
  );
}
