"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { sendAgentCommand } from "@/lib/agent-client";
import { recoverDraft } from "@/lib/draft-store";
import type {
  CommitPlan,
  PrDescription,
  ShipJob,
  ShipMergeMethod,
  ShipMode,
  ShipPreview,
} from "@/lib/workspace-ship-types";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { Check, Field, Select, TextInput } from "./ui/field";
import { toast } from "./ui/toast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: string;
  projectPath: string;
  path: string;
  sessionId: string;
  onRemoved?: () => void;
}

async function json<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export function ShipDialog({
  open,
  onOpenChange,
  host,
  projectPath,
  path,
  sessionId,
  onRemoved,
}: Props) {
  const [preview, setPreview] = useState<ShipPreview | null>(null);
  const [plan, setPlan] = useState<CommitPlan | null | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const [mode, setMode] = useState<ShipMode>("local");
  const [rebase, setRebase] = useState(false);
  const [cleanup, setCleanup] = useState(true);
  const [mergeMethod, setMergeMethod] = useState<ShipMergeMethod>("squash");
  const [pr, setPr] = useState<PrDescription | null>(null);
  const [prLoading, setPrLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [job, setJob] = useState<ShipJob | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setPreview(null);
    setPlan(undefined);
    setElapsed(0);
    setMode("local");
    setCleanup(true);
    setPr(null);
    setPrLoading(false);
    setError(null);
    setWorking(false);
    setJob(null);
    setMergeMethod("squash");
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    const query = new URLSearchParams({ host, projectPath, path });
    void json<ShipPreview>(`/api/ship?${query}`, { signal: abort.signal })
      .then((value) => {
        if (generation.current !== current) return;
        setPreview(value);
        setRebase(value.behind > 0);
        if (value.baseDirty && value.github.gh === "ok" && value.github.repo)
          setMode("pr");
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted)
          setError(String(e instanceof Error ? e.message : e));
      });
    void sendAgentCommand<{ plan: CommitPlan | null }>(sessionId, {
      type: "commit_plan",
    })
      .then((value) => {
        if (generation.current === current) setPlan(value.plan);
      })
      .catch((e: unknown) => {
        if (generation.current === current)
          setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      generation.current++;
      abort.abort();
      clearInterval(timer);
    };
  }, [open, host, projectPath, path, sessionId]);

  useEffect(() => {
    if (!open || mode === "local" || !preview || pr || prLoading) return;
    const current = generation.current;
    setPrLoading(true);
    void sendAgentCommand<PrDescription>(sessionId, {
      type: "generate_pr_description",
      base: preview.base,
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
  }, [open, mode, preview, pr, prLoading, sessionId]);

  async function ship() {
    if (!preview || plan === undefined || !controller.current) return;
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
            ...(mode !== "local" ? { pr, mergeMethod } : {}),
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
      if (generation.current === current) setWorking(false);
    }
  }
  const githubReason = !preview?.github.repo
    ? "No GitHub repository configured"
    : preview.github.gh !== "ok"
      ? `GitHub CLI: ${preview.github.gh}`
      : null;
  const nothing = plan === null && preview?.ahead === 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        style={{
          width: 640,
          maxWidth: "95vw",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <DialogTitle>Ship workspace</DialogTitle>
        {error && (
          <p role="alert" style={{ color: "var(--status-error)" }}>
            {error}
          </p>
        )}
        {plan === undefined && !error && (
          <p>
            <Loader2 size={16} /> Generating commit plan ({elapsed}s)
          </p>
        )}
        {!preview && !error && <p>Loading workspace...</p>}
        {preview && plan !== undefined && !job && (
          <div style={{ display: "grid", gap: 12 }}>
            {nothing && <p>Nothing to ship.</p>}
            {plan?.commits.map((commit, index) => (
              <Field
                key={index}
                label={
                  plan.commits.length > 1
                    ? `Commit ${index + 1}`
                    : "Commit message"
                }
              >
                <div>
                  <small>{commit.files.join(", ")}</small>
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
                    style={{
                      width: "100%",
                      color: "var(--text)",
                      background: "var(--bg-input)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                    }}
                  />
                </div>
              </Field>
            ))}
            {plan?.changelog.length ? (
              <p>
                Changelog: {plan.changelog.map((item) => item.path).join(", ")}
              </p>
            ) : null}
            {plan?.warnings.map((warning, i) => (
              <p key={i}>{warning}</p>
            ))}
            {plan?.usedFallback && (
              <p>
                Generated a fallback commit message. Review it before shipping.
              </p>
            )}
            <Check
              checked={rebase}
              onChange={setRebase}
              label={`Rebase first (${preview.behind} behind ${preview.base})`}
            />
            <fieldset
              disabled={working || !!nothing}
              style={{ display: "grid", gap: 6 }}
            >
              <legend>Path</legend>
              <label
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
              <label title={githubReason ?? undefined}>
                <input
                  type="radio"
                  checked={mode === "pr"}
                  disabled={!!githubReason}
                  onChange={() => setMode("pr")}
                />{" "}
                Open PR{githubReason ? ` (${githubReason})` : ""}
              </label>
              <label title={githubReason ?? undefined}>
                <input
                  type="radio"
                  checked={mode === "pr-auto"}
                  disabled={!!githubReason}
                  onChange={() => setMode("pr-auto")}
                />{" "}
                PR + auto-merge
              </label>
            </fieldset>
            {mode !== "local" &&
              (prLoading ? (
                <p>Generating PR description...</p>
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
                        style={{
                          width: "100%",
                          color: "var(--text)",
                          background: "var(--bg-input)",
                          border: "1px solid var(--border)",
                        }}
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
          <div>
            <ul>
              {job.steps.map((step) => (
                <li key={step.name}>
                  {step.status === "running" ? (
                    <Loader2 size={14} />
                  ) : step.status === "done" ? (
                    <CheckCircle2 size={14} />
                  ) : step.status === "failed" ? (
                    <XCircle size={14} />
                  ) : (
                    <Circle size={14} />
                  )}{" "}
                  {step.name}: {step.status} {step.detail}
                </li>
              ))}
            </ul>
            {job.status === "conflict" && (
              <>
                <p>Conflicts: {job.conflictFiles?.join(", ")}</p>
                <button
                  type="button"
                  onClick={() => {
                    recoverDraft(sessionId, {
                      text: `Rebasing onto ${preview?.base} conflicts in: ${job.conflictFiles?.join(", ")}. Rebase this branch onto ${preview?.base} and resolve the conflicts, keeping both sides' intent.`,
                    });
                    onOpenChange(false);
                  }}
                >
                  Ask agent to resolve
                </button>
              </>
            )}
            {(job.status === "failed" || job.status === "interrupted") && (
              <>
                <p role="alert">{job.error || job.status}</p>
                <details>
                  <summary>Logs</summary>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{job.logs}</pre>
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
          <button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          {!job && (
            <button
              type="button"
              disabled={
                working ||
                !preview ||
                plan === undefined ||
                !!nothing ||
                (mode === "local" && !!preview?.baseDirty) ||
                (mode !== "local" && (!pr || !!githubReason))
              }
              onClick={() => void ship()}
            >
              {working ? "Shipping..." : "Ship"}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
