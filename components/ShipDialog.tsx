"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { sendAgentCommand } from "@/lib/agent-client";
import { browserUUID } from "@/lib/browser-uuid";
import {
  EVENT_STREAM_CLOSED,
  EVENT_STREAM_OPEN,
  openEventStream,
} from "@/lib/event-stream";
import type {
  CommitPlan,
  PrDescription,
  ShipJob,
  ShipMergeMethod,
  ShipMode,
  ShipPreview,
} from "@/lib/workspace-ship-types";
import { Alert, Check, Field, Select, TextInput } from "./ui/field";
import { toast } from "./ui/toast";

interface Props {
  open: boolean;
  visible?: boolean;
  onOpenChange: (open: boolean) => void;
  host: string;
  projectPath: string;
  path: string;
  sessionId: string;
  onAskAgentToResolve: (message: string) => Promise<void>;
  onRemoved?: () => void;
}

export type ShipTarget = Pick<
  Props,
  "host" | "projectPath" | "path" | "sessionId"
>;

async function json<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

const textareaStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 9px",
  resize: "vertical",
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
};

const pathStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  lineHeight: 1.5,
  overflowWrap: "anywhere",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "6px 14px",
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 13,
};

const PLAN_STAGES: Record<string, true> = {
  "Staging workspace changes": true,
  "Inspecting staged changes": true,
  "Resolving commit model": true,
  "Running commit agent": true,
  "Preparing commit proposal": true,
  "Preparing fallback proposal": true,
  "Finalizing commit plan": true,
};

export function ShipPlanProgress({
  elapsed,
  messages,
}: {
  elapsed: number;
  messages: string[];
}) {
  const stages = messages.filter((message) =>
    Object.hasOwn(PLAN_STAGES, message),
  );
  const detail = messages.at(-1);
  return (
    <div style={{ color: "var(--text-muted)", fontSize: 12, minWidth: 0 }}>
      <p>Generating commit plan ({elapsed}s)</p>
      <ul
        style={{
          display: "grid",
          gap: 8,
          margin: 0,
          padding: 0,
          listStyle: "none",
        }}
      >
        {stages.map((stage, index) => (
          <li
            key={`${stage}-${index}`}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              lineHeight: 1.5,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "flex",
                flexShrink: 0,
                marginTop: 2,
                color:
                  index === stages.length - 1
                    ? "var(--text-dim)"
                    : "var(--status-success)",
              }}
            >
              {index === stages.length - 1 ? (
                <Loader2 size={14} />
              ) : (
                <CheckCircle2 size={14} />
              )}
            </span>
            <strong style={{ color: "var(--text)", overflowWrap: "anywhere" }}>
              {stage}
            </strong>
          </li>
        ))}
      </ul>
      {detail && !Object.hasOwn(PLAN_STAGES, detail) && (
        <div
          role="status"
          aria-live="polite"
          style={{ marginTop: 4, overflowWrap: "anywhere" }}
        >
          {detail}
        </div>
      )}
    </div>
  );
}

export function ShipDialog({
  open,
  visible = true,
  onOpenChange,
  host,
  projectPath,
  path,
  sessionId,
  onAskAgentToResolve,
  onRemoved,
}: Props) {
  const [preview, setPreview] = useState<ShipPreview | null>(null);
  const [plan, setPlan] = useState<CommitPlan | null | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<string[]>([]);
  const [mode, setMode] = useState<ShipMode>("local");
  const [rebase, setRebase] = useState(false);
  const [cleanup, setCleanup] = useState(true);
  const [monitorFeedback, setMonitorFeedback] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<ShipMergeMethod>("squash");
  const [pr, setPr] = useState<PrDescription | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const [job, setJob] = useState<ShipJob | null>(null);
  const [asking, setAsking] = useState(false);
  const askingRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setPreview(null);
    setPlan(undefined);
    setProgress([]);
    setElapsed(0);
    setMode("local");
    setCleanup(true);
    setMonitorFeedback(false);
    setPr(null);
    setPrLoading(false);
    setError(null);
    setWorking(false);
    workingRef.current = false;
    setJob(null);
    setAsking(false);
    askingRef.current = false;
    setMergeMethod("squash");
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    const query = new URLSearchParams({ host, projectPath, path });
    void json<ShipPreview>(`/api/ship?${query}`, { signal: abort.signal })
      .then(async (value) => {
        if (generation.current !== current) return;
        setPreview(value);
        setRebase(value.behind > 0);
        if (value.baseDirty && value.github.gh === "ok" && value.github.repo)
          setMode(value.pr?.state === "open" ? "pr-auto" : "pr");
        if (value.issues.length) return;
        // The session stream observes an existing wrapper; it does not start one.
        await sendAgentCommand(sessionId, { type: "get_state" });
        if (generation.current !== current || abort.signal.aborted) return;
        const requestId = browserUUID();
        let stream;
        try {
          stream = openEventStream({ kind: "commit-plan-progress", sessionId });
        } catch {
          setProgress(["Live progress is unavailable."]);
          const result = await sendAgentCommand<{ plan: CommitPlan | null }>(
            sessionId,
            {
              type: "commit_plan",
              requestId,
            },
          );
          if (generation.current === current) setPlan(result.plan);
          return;
        }
        let settled = false;
        let started = false;
        let timeout: number;
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const close = () => {
          clearTimeout(timeout);
          abort.signal.removeEventListener("abort", cancel);
          stream.close();
        };
        const cancel = () => {
          settled = true;
          close();
          resolve();
        };
        abort.signal.addEventListener("abort", cancel, { once: true });
        stream.onmessage = (event) => {
          if (settled || generation.current !== current) return;
          try {
            const frame = JSON.parse(event.data);
            if (
              frame.type !== "commit_plan_progress" ||
              frame.requestId !== requestId ||
              typeof frame.message !== "string"
            )
              return;
            const message = frame.message
              .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
              .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
              .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
              .trim()
              .slice(0, 300);
            if (message)
              setProgress((items) => [
                ...items.filter((item) => Object.hasOwn(PLAN_STAGES, item)),
                message,
              ]);
          } catch {
            // Ignore malformed and unrelated frames.
          }
        };
        const unavailable = () => {
          if (settled || started) return;
          setProgress(["Live progress is unavailable."]);
          start();
        };
        const start = () => {
          if (started || settled || abort.signal.aborted) return;
          started = true;
          clearTimeout(timeout);
          void sendAgentCommand<{ plan: CommitPlan | null }>(sessionId, {
            type: "commit_plan",
            requestId,
          }).then(
            (result) => {
              if (!settled && generation.current === current)
                setPlan(result.plan);
              settled = true;
              close();
              resolve();
            },
            (error: unknown) => {
              settled = true;
              close();
              reject(error);
            },
          );
        };
        stream.onopen = start;
        stream.onerror = () => {
          if (stream.readyState === EVENT_STREAM_CLOSED) {
            if (started && !settled)
              setProgress(["Live progress is unavailable."]);
            else unavailable();
          }
        };
        timeout = window.setTimeout(unavailable, 3000);
        if (stream.readyState === EVENT_STREAM_OPEN) start();
        else if (stream.readyState === EVENT_STREAM_CLOSED) unavailable();
        return promise;
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted && generation.current === current)
          setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      generation.current++;
      abort.abort();
      clearInterval(timer);
    };
  }, [open, host, projectPath, path, sessionId]);

  useEffect(() => {
    if (
      !open ||
      mode === "local" ||
      !preview ||
      (mode === "pr-auto" && preview.pr?.state === "open") ||
      preview.issues.length ||
      plan === undefined ||
      (plan === null && preview.ahead === 0) ||
      pr ||
      prLoading
    )
      return;
    const current = generation.current;
    setPrLoading(true);
    void sendAgentCommand<PrDescription>(sessionId, {
      type: "generate_pr_description",
      base: preview.base,
      plannedMessages: plan?.commits.map((commit) => commit.message) ?? [],
    })
      .then((value) => {
        if (generation.current === current) setPr(value);
      })
      .catch((e: unknown) => {
        if (generation.current === current) {
          setError(String(e instanceof Error ? e.message : e));
          setMode("local");
        }
      })
      .finally(() => {
        if (generation.current === current) setPrLoading(false);
      });
  }, [open, mode, preview, plan, pr, prLoading, sessionId]);

  async function ship() {
    if (
      workingRef.current ||
      !preview ||
      plan === undefined ||
      !controller.current
    )
      return;
    workingRef.current = true;
    const signal = controller.current.signal;
    const current = generation.current;
    setWorking(true);
    setError(null);
    try {
      if (plan) {
        await sendAgentCommand(sessionId, { type: "commit_apply", plan });
        // Committed: a retry after a later failure must not apply the plan again.
        if (generation.current === current) setPlan(null);
      }
      if (generation.current !== current) return;
      let next = await json<ShipJob>("/api/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host,
          input: {
            projectPath,
            path,
            mode,
            rebase,
            cleanup,
            ...(mode !== "local"
              ? {
                  mergeMethod,
                  ...(pr ? { pr } : {}),
                  ...(monitorFeedback ? { monitorSessionId: sessionId } : {}),
                }
              : {}),
          },
        }),
        signal,
      });
      setJob(next);
      while (next.status === "running") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
          }, 1000);
          const cancel = () => {
            clearTimeout(timer);
            reject(new Error("Cancelled"));
          };
          signal.addEventListener("abort", cancel, { once: true });
        });
        next = await json<ShipJob>(
          `/api/ship/${encodeURIComponent(next.id)}?${new URLSearchParams({ host })}`,
          { signal },
        );
        setJob(next);
      }
      if (next.status === "complete") {
        toast.success(
          "Ship complete",
          next.pr ? (
            <a href={next.pr.url} target="_blank" rel="noreferrer">
              PR #{next.pr.number}
            </a>
          ) : undefined,
        );
        if (
          next.steps.some(
            (step) => step.name === "removeWorkspace" && step.status === "done",
          )
        )
          onRemoved?.();
        onOpenChange(false);
      }
    } catch (e) {
      if (!signal.aborted) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (generation.current === current) {
        workingRef.current = false;
        setWorking(false);
      }
    }
  }
  async function askAgent(message: string) {
    if (askingRef.current) return;
    askingRef.current = true;
    setAsking(true);
    setError(null);
    const current = generation.current;
    try {
      await onAskAgentToResolve(message);
      if (generation.current === current) onOpenChange(false);
    } catch (e) {
      if (generation.current === current)
        setError(String(e instanceof Error ? e.message : e));
    } finally {
      askingRef.current = false;
      if (generation.current === current) setAsking(false);
    }
  }
  const githubReason = !preview?.github.repo
    ? "No GitHub repository configured"
    : preview.github.gh !== "ok"
      ? `GitHub CLI: ${preview.github.gh}`
      : null;
  const existingPr = preview?.pr?.state === "open";
  const openPrReason =
    githubReason ?? (existingPr ? "An open PR already exists" : null);
  const nothing = plan === null && preview?.ahead === 0;
  const shipDisabled =
    working ||
    !preview ||
    plan === undefined ||
    (!!nothing && !(mode === "pr-auto" && existingPr)) ||
    (mode === "local" && !!preview?.baseDirty) ||
    (mode !== "local" &&
      (!!githubReason || (!pr && !(mode === "pr-auto" && existingPr))));
  if (!open || !visible) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,
        background: "var(--overlay-backdrop)",
        backdropFilter: "blur(2px)",
      }}
    >
      <section
        role="dialog"
        aria-label="Ship workspace"
        onKeyDown={(event) => {
          if (event.key === "Escape") onOpenChange(false);
        }}
        style={{
          boxSizing: "border-box",
          width: 640,
          maxWidth: "100%",
          maxHeight: "100%",
          minHeight: 0,
          padding: 22,
          overflowY: "auto",
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-modal)",
          boxShadow: "var(--shadow-modal)",
        }}
      >
        <h2
          className="display-heading"
          style={{ fontSize: 20, margin: "0 0 12px" }}
        >
          Ship workspace
        </h2>
        {error && (
          <Alert
            variant="error"
            description={
              <div
                role="region"
                aria-label="Ship error details"
                tabIndex={0}
                style={{
                  maxHeight: "min(14rem, 30dvh)",
                  overflowY: "auto",
                  overscrollBehaviorY: "contain",
                  whiteSpace: "pre-wrap",
                }}
              >
                {error}
              </div>
            }
            style={{ marginTop: 16 }}
          />
        )}
        {plan === undefined && !error && !preview?.issues.length && (
          <ShipPlanProgress elapsed={elapsed} messages={progress} />
        )}
        {!preview && !error && (
          <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
            Loading workspace...
          </p>
        )}
        {!!preview?.issues.length && !job && (
          <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
            {preview.issues.map((issue, i) => (
              <Alert key={i} variant="warning" description={issue} />
            ))}
            <button
              type="button"
              style={{ ...secondaryButtonStyle, justifySelf: "start" }}
              disabled={asking}
              onClick={() =>
                void askAgent(
                  `Please resolve these issues preventing shipping this workspace:\n${preview.issues.map((issue) => `- ${issue}`).join("\n")}`,
                )
              }
            >
              {asking ? "Sending..." : "Ask agent to resolve"}
            </button>
          </div>
        )}
        {preview && plan !== undefined && !job && (
          <div style={{ display: "grid", gap: 14, marginTop: 16 }}>
            {nothing && !(mode === "pr-auto" && existingPr) && (
              <p
                style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}
              >
                Nothing to ship.
              </p>
            )}
            {plan === null && preview.ahead > 0 && (
              <p
                role="status"
                style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}
              >
                No uncommitted changes. Ship won't generate a new commit
                message.
              </p>
            )}
            {plan?.commits.map((commit, index) => (
              <Field
                key={index}
                label={
                  plan.commits.length > 1
                    ? `Commit ${index + 1}`
                    : "Commit message"
                }
              >
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={pathStyle}>
                    {commit.files.map((file, i) => (
                      <code key={i}>
                        {i > 0 && ", "}
                        {file}
                      </code>
                    ))}
                  </div>
                  <textarea
                    aria-label={`Commit ${index + 1} message`}
                    value={commit.message}
                    onChange={(e) =>
                      setPlan({
                        ...plan,
                        commits: plan.commits.map((item, i) =>
                          i === index
                            ? { ...item, message: e.target.value }
                            : item,
                        ),
                      })
                    }
                    rows={5}
                    style={textareaStyle}
                  />
                </div>
              </Field>
            ))}
            {plan?.changelog.length ? (
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                Changelog:{" "}
                <span style={pathStyle}>
                  {plan.changelog.map((item, i) => (
                    <code key={i}>
                      {i > 0 && ", "}
                      {item.path}
                    </code>
                  ))}
                </span>
              </div>
            ) : null}
            {plan?.warnings.map((warning, i) => (
              <Alert key={i} variant="warning" description={warning} />
            ))}
            {plan?.usedFallback && (
              <Alert
                variant="warning"
                description="Generated a fallback commit message. Review it before shipping."
              />
            )}
            <Check
              checked={rebase}
              onChange={setRebase}
              label={`Rebase first (${preview.behind} behind ${preview.base})`}
            />
            <fieldset
              disabled={working || (!!nothing && !existingPr)}
              style={{
                display: "grid",
                gap: 8,
                margin: 0,
                padding: "10px 12px 12px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-muted)",
                fontSize: 12,
              }}
            >
              <legend
                style={{
                  padding: "0 4px",
                  color: "var(--text)",
                  fontWeight: 600,
                }}
              >
                Path
              </legend>
              <label
                style={{ display: "flex", alignItems: "center", gap: 8 }}
                title={
                  preview.baseDirty
                    ? "The base workspace has uncommitted changes"
                    : undefined
                }
              >
                <input
                  type="radio"
                  checked={mode === "local"}
                  disabled={preview.baseDirty}
                  onChange={() => setMode("local")}
                />{" "}
                Land locally
                {preview.baseDirty
                  ? " (base workspace has uncommitted changes)"
                  : ""}
              </label>
              <label
                title={openPrReason ?? undefined}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <input
                  type="radio"
                  checked={mode === "pr"}
                  disabled={!!openPrReason}
                  onChange={() => setMode("pr")}
                />{" "}
                Open PR{openPrReason ? ` (${openPrReason})` : ""}
              </label>
              <label
                title={githubReason ?? undefined}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <input
                  type="radio"
                  checked={mode === "pr-auto"}
                  disabled={!!githubReason}
                  onChange={() => setMode("pr-auto")}
                />{" "}
                PR + auto-merge{githubReason ? ` (${githubReason})` : ""}
              </label>
              {mode !== "local" && (
                <>
                  <Check
                    checked={monitorFeedback}
                    onChange={setMonitorFeedback}
                    label="Monitor PR feedback"
                  />
                  <span>
                    Send new PR feedback links to this chat. This doesn't block
                    merges.
                  </span>
                </>
              )}
            </fieldset>
            {preview.github.prLookupError && (
              <Alert
                variant="warning"
                description={`${preview.github.prLookupError}. The branch may already have an open PR.`}
              />
            )}
            {mode !== "local" &&
              !(mode === "pr-auto" && existingPr) &&
              (prLoading ? (
                <p
                  role="status"
                  style={{
                    margin: 0,
                    color: "var(--text-muted)",
                    fontSize: 12,
                  }}
                >
                  Generating PR description...
                </p>
              ) : (
                pr && (
                  <>
                    <Field label="PR title">
                      <TextInput
                        value={pr.title}
                        onChange={(title) => setPr({ ...pr, title })}
                      />
                    </Field>
                    <Field label="PR description">
                      <textarea
                        aria-label="PR description"
                        value={pr.body}
                        onChange={(e) => setPr({ ...pr, body: e.target.value })}
                        rows={8}
                        style={textareaStyle}
                      />
                    </Field>
                  </>
                )
              ))}
            {mode === "pr-auto" && (
              <Field label="Merge method">
                <Select
                  value={mergeMethod}
                  onChange={(value) => setMergeMethod(value as ShipMergeMethod)}
                  options={["squash", "merge", "rebase"]}
                />
              </Field>
            )}
            <Check
              checked={cleanup}
              onChange={setCleanup}
              label={`Clean up when done: archive sessions and delete workspace and branch${mode !== "local" ? " when the PR merges" : ""}`}
            />
          </div>
        )}
        {job && (
          <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
            <ul
              style={{
                display: "grid",
                gap: 8,
                margin: 0,
                padding: 0,
                listStyle: "none",
              }}
            >
              {job.steps
                .filter((step) => step.status !== "skipped")
                .map((step) => (
                  <li
                    key={step.name}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      color:
                        step.status === "failed"
                          ? "var(--status-error)"
                          : "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        display: "flex",
                        flexShrink: 0,
                        marginTop: 2,
                        color:
                          step.status === "done"
                            ? "var(--status-success)"
                            : step.status === "failed"
                              ? "var(--status-error)"
                              : "var(--text-dim)",
                      }}
                    >
                      {step.status === "running" ? (
                        <Loader2 size={14} />
                      ) : step.status === "done" ? (
                        <CheckCircle2 size={14} />
                      ) : step.status === "failed" ? (
                        <XCircle size={14} />
                      ) : (
                        <Circle size={14} />
                      )}
                    </span>
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      <strong style={{ color: "var(--text)" }}>
                        {step.name}
                      </strong>
                      : {step.status} {step.detail}
                    </span>
                  </li>
                ))}
            </ul>
            {job.status === "conflict" && (
              <>
                <div style={{ color: "var(--status-warning)", fontSize: 12 }}>
                  Conflicts:{" "}
                  <span style={pathStyle}>
                    {job.conflictFiles?.map((file, i) => (
                      <code key={i}>
                        {i > 0 && ", "}
                        {file}
                      </code>
                    ))}
                  </span>
                </div>
                <button
                  type="button"
                  style={{ ...secondaryButtonStyle, justifySelf: "start" }}
                  disabled={asking}
                  onClick={() =>
                    void askAgent(
                      `Rebasing onto ${preview?.base} conflicts in: ${job.conflictFiles?.join(", ")}. Rebase this branch onto ${preview?.base} and resolve the conflicts, keeping both sides' intent.`,
                    )
                  }
                >
                  {asking ? "Sending..." : "Ask agent to resolve"}
                </button>
              </>
            )}
            {(job.status === "failed" || job.status === "interrupted") && (
              <>
                <Alert variant="error" description={job.error || job.status} />
                <details style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  <summary style={{ cursor: "pointer" }}>Logs</summary>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      padding: 10,
                      background: "var(--bg-subtle)",
                      borderRadius: "var(--radius-control)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                    }}
                  >
                    {job.logs}
                  </pre>
                </details>
              </>
            )}
          </div>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
          <button
            type="button"
            className="dialog-action"
            style={secondaryButtonStyle}
            onClick={() => onOpenChange(false)}
          >
            {working || job ? "Close" : "Cancel"}
          </button>
          {!job && (
            <button
              type="button"
              className="dialog-action"
              style={{
                padding: "6px 14px",
                background: "var(--accent-strong)",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: "var(--on-accent)",
                cursor: working
                  ? "wait"
                  : shipDisabled
                    ? "not-allowed"
                    : "pointer",
                opacity: shipDisabled ? 0.5 : 1,
                fontSize: 13,
                fontWeight: 600,
              }}
              disabled={shipDisabled}
              onClick={() => void ship()}
            >
              {working ? "Shipping..." : "Ship"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
