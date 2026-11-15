import { useCallback, useEffect, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import type { JobActivity, JobDetail, JobSnapshot } from "@/lib/jobs-types";

const OUTPUT_LIMIT = 256 * 1024;

type OutputTail = { text: string; cursor: number; truncated: boolean };

/** Merge an opaque-cursor delta, or replace the tail when the source reset. */
export function mergeJobOutput(
  previous: OutputTail,
  detail: JobDetail,
): OutputTail {
  const replace =
    detail.start === 0 ||
    detail.start > previous.cursor ||
    detail.cursor < previous.cursor;
  const text = (replace ? "" : previous.text) + detail.output;
  return {
    text: text.slice(-OUTPUT_LIMIT),
    cursor: detail.cursor,
    truncated:
      detail.truncated ||
      (!replace && previous.truncated) ||
      text.length > OUTPUT_LIMIT,
  };
}

const emptyTail = (): OutputTail => ({ text: "", cursor: 0, truncated: false });
const sameJob = (a: JobActivity, b: JobActivity) =>
  a.id === b.id && a.kind === b.kind && a.incarnation === b.incarnation;

export function useJobs(sessionId: string | null, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [selected, setSelected] = useState<JobActivity | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [authoritative, setAuthoritative] = useState(false);
  const current = useRef({ sessionId, enabled });
  current.current = { sessionId, enabled };
  const lifetime = useRef(0);
  const selection = useRef(0);
  const selectedRef = useRef<JobActivity | null>(null);
  const snapshotRef = useRef<JobSnapshot | null>(null);
  const authorityRef = useRef(false);
  const tail = useRef<OutputTail>(emptyTail());
  const pendingRef = useRef(false);
  const cancelAttempt = useRef<object | null>(null);
  const pendingJob = useRef<JobActivity | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  const select = useCallback((job: JobActivity | null) => {
    selection.current++;
    selectedRef.current = job;
    tail.current = emptyTail();
    setSelected(job);
    setDetail(null);
    setOutput("");
    refreshRef.current();
  }, []);

  useEffect(() => {
    // Session changes discard all retained data; hiding the panel does not.
    snapshotRef.current = null;
    authorityRef.current = false;
    setAuthoritative(false);
    selectedRef.current = null;
    tail.current = emptyTail();
    selection.current++;
    pendingRef.current = false;
    pendingJob.current = null;
    cancelAttempt.current = null;
    setSnapshot(null);
    setSelected(null);
    setDetail(null);
    setOutput("");
    setError(null);
    setPending(false);
    return () => {
      cancelAttempt.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    const token = ++lifetime.current;
    if (!sessionId || !enabled) {
      setLoading(false);
      refreshRef.current = () => {};
      return () => {
        lifetime.current++;
      };
    }
    let busy = false;
    let again = false;
    let disposed = false;
    const valid = () =>
      !disposed &&
      lifetime.current === token &&
      current.current.sessionId === sessionId &&
      current.current.enabled;
    const poll = async () => {
      if (!valid() || document.visibilityState === "hidden") return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      let outputSelection: number | null = null;
      let rosterReceived = false;
      setLoading(true);
      try {
        const next = await sendAgentCommand<JobSnapshot>(sessionId, {
          type: "get_jobs",
        });
        if (!valid()) return;
        if (!next.available) {
          authorityRef.current = false;
          setAuthoritative(false);
          if (!snapshotRef.current) {
            snapshotRef.current = next;
            setSnapshot(next);
          }
          setError("Job session is unavailable");
          return;
        }
        rosterReceived = true;
        authorityRef.current = true;
        setAuthoritative(true);
        const old = snapshotRef.current;
        if (old?.available && old.generation !== next.generation) {
          selection.current++;
          selectedRef.current = null;
          tail.current = emptyTail();
          setSelected(null);
          setDetail(null);
          setOutput("");
        }
        snapshotRef.current = next;
        setSnapshot(next);
        if (pendingJob.current) {
          const authority = [...next.jobs, ...next.services].find((job) =>
            sameJob(job, pendingJob.current!),
          );
          if (
            !authority?.canCancel ||
            (old?.available && old.generation !== next.generation)
          ) {
            pendingJob.current = null;
            pendingRef.current = false;
            cancelAttempt.current = null;
            setPending(false);
          }
        }
        setError(next.servicesError ?? null);
        const selectedJob = selectedRef.current;
        if (!selectedJob) return;
        const found = [...next.jobs, ...next.services].find((job) =>
          sameJob(job, selectedJob),
        );
        // Only known terminal jobs can be frozen as completed after eviction.
        if (!found) {
          if (
            selectedJob.endTime === undefined &&
            !["exited", "failed", "completed", "cancelled"].includes(
              selectedJob.status,
            )
          ) {
            const unavailable = {
              ...selectedJob,
              status: "unavailable",
              canCancel: false,
            };
            selectedRef.current = unavailable;
            setSelected(unavailable);
            setError(next.servicesError ?? "Job is no longer observable");
          }
          return;
        }
        selectedRef.current = found;
        setSelected(found);
        const selectedToken = selection.current;
        outputSelection = selectedToken;
        const result = await sendAgentCommand<JobDetail>(sessionId, {
          type: "get_job_output",
          kind: found.kind,
          id: found.id,
          incarnation: found.incarnation,
          generation: next.generation,
          cursor: tail.current.cursor,
        });
        if (
          !valid() ||
          selectedToken !== selection.current ||
          snapshotRef.current?.generation !== next.generation ||
          result.generation !== next.generation ||
          result.id !== found.id ||
          result.kind !== found.kind ||
          result.incarnation !== found.incarnation
        )
          return;
        tail.current = mergeJobOutput(tail.current, result);
        setOutput(tail.current.text);
        setDetail({ ...result, truncated: tail.current.truncated });
      } catch (cause) {
        if (
          valid() &&
          (outputSelection === null || outputSelection === selection.current)
        ) {
          if (!rosterReceived) {
            authorityRef.current = false;
            setAuthoritative(false);
          }
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        busy = false;
        if (valid()) {
          setLoading(false);
          if (again) {
            again = false;
            void poll();
          }
        }
      }
    };
    refreshRef.current = () => {
      void poll();
    };
    const visibility = () => {
      if (document.visibilityState !== "hidden") void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => {
      void poll();
    }, 1000);
    void poll();
    return () => {
      disposed = true;
      lifetime.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      refreshRef.current = () => {};
    };
  }, [sessionId, enabled]);

  const refresh = useCallback(() => refreshRef.current(), []);
  const cancel = useCallback(async () => {
    const job = selectedRef.current;
    const snap = snapshotRef.current;
    if (
      !sessionId ||
      !enabled ||
      !job?.canCancel ||
      !snap?.available ||
      !authorityRef.current ||
      (job.kind === "service" && snap.servicesError) ||
      pendingRef.current
    )
      return;
    const token = lifetime.current;
    const selectedToken = selection.current;
    const attempt = {};
    cancelAttempt.current = attempt;
    pendingRef.current = true;
    pendingJob.current = job;
    setPending(true);
    try {
      const result = await sendAgentCommand<{ requested: boolean }>(sessionId, {
        type: "cancel_job",
        kind: job.kind,
        id: job.id,
        incarnation: job.incarnation,
        generation: snap.generation,
      });
      if (!result.requested && cancelAttempt.current === attempt) {
        pendingJob.current = null;
        pendingRef.current = false;
        cancelAttempt.current = null;
        setPending(false);
      }
    } catch (cause) {
      if (cancelAttempt.current === attempt) {
        pendingJob.current = null;
        pendingRef.current = false;
        cancelAttempt.current = null;
        setPending(false);
      }
      if (
        lifetime.current === token &&
        current.current.sessionId === sessionId &&
        current.current.enabled &&
        selection.current === selectedToken
      )
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (
        lifetime.current === token &&
        current.current.sessionId === sessionId &&
        current.current.enabled
      ) {
        refreshRef.current();
      }
    }
  }, [sessionId, enabled]);

  return {
    snapshot,
    selected:
      selected &&
      (pending ||
        !authoritative ||
        (selected.kind === "service" && snapshot?.servicesError))
        ? { ...selected, canCancel: false }
        : selected,
    detail,
    output,
    loading,
    error,
    select,
    cancel,
    refresh,
  };
}
