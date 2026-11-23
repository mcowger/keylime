import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { stripAnsi } from "../lib/ansi";
import { isRecord } from "../lib/type-guards";
import {
  mergeSubagentRoster,
  parseSubagentLifecycle,
  parseSubagentProgress,
  parseSubagentSnapshot,
  type SubagentInfo,
} from "../lib/subagent-types";
import type {
  BrowserCommand,
  BrowserLink,
  BrowserLinkStatus,
} from "./browser-link";
import { ChatMarkdown } from "./ChatMarkdown";
import type { NativeTranscriptPalette } from "./ChatTranscript";
import type { components } from "./generated/browser-link";
import type { operations } from "./generated/web-http";
import { requestJson } from "./keylime-http";
import { lightTheme, theme } from "./theme";

type State =
  operations["getSessionState"]["responses"][200]["content"]["application/json"];
type Session =
  operations["getSession"]["responses"][200]["content"]["application/json"];
type History =
  operations["listSessionSubagents"]["responses"][200]["content"]["application/json"];
type Phase = Session["context"]["todoPhases"][number];
type Jobs = Extract<
  components["schemas"]["BrowserReply_get_jobs"]["data"],
  { success: true }
>["data"];
type Job = Jobs["jobs"][number];
type Detail = Extract<
  components["schemas"]["BrowserReply_get_job_output"]["data"],
  { success: true }
>["data"];
type CompletionResponse =
  operations["getSessionSubagent"]["responses"][200]["content"]["application/json"];

type Props = {
  origin: string;
  hostId: string;
  sessionId: string | null;
  link: BrowserLink;
  linkStatus?: BrowserLinkStatus;
  kind: "activity" | "jobs";
  initialAgent?: string[];
};

type ViewState = {
  phases: Phase[];
  subagents: SubagentInfo[];
  jobs: Jobs | null;
  selected: Job | null;
  detail: Detail | null;
  output: string;
  loading: boolean;
  error: string | null;
  cancelling: boolean;
};
const initial = (): ViewState => ({
  phases: [],
  subagents: [],
  jobs: null,
  selected: null,
  detail: null,
  output: "",
  loading: true,
  error: null,
  cancelling: false,
});
const sameJob = (a: Job, b: Job) =>
  a.id === b.id && a.kind === b.kind && a.incarnation === b.incarnation;
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function SessionActivity(props: Props) {
  return (
    <ActivityContent
      key={JSON.stringify([
        props.origin,
        props.hostId,
        props.sessionId,
        props.kind,
      ])}
      {...props}
    />
  );
}

function ActivityContent({
  origin,
  hostId,
  sessionId,
  link,
  linkStatus,
  kind,
  initialAgent,
}: Props) {
  const [view, setView] = useState<ViewState>(initial);
  const [selectedAgent, setSelectedAgent] = useState<string | string[] | null>(
    initialAgent ?? null,
  );
  const [completionRevision, setCompletionRevision] = useState(0);
  const actions = useRef<{
    refresh(): void;
    select(job: Job | null): void;
    cancel(): void;
  } | null>(null);
  const dark = useColorScheme() !== "light";
  const colors = dark ? theme : lightTheme;

  useEffect(() => {
    if (!sessionId) {
      setView({ ...initial(), loading: false });
      actions.current = null;
      return;
    }
    let alive = true;
    let opened = false;
    let sessionEpoch = 0;
    let state = initial();
    let revision = 0;
    let agentRevision = 0;
    let selectionRevision = 0;
    let refreshBusy = false;
    let refreshAgain = false;
    let outputCursor = 0;
    let truncated = false;
    const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const query = `hostId=${encodeURIComponent(hostId)}`;
    const publish = () => {
      if (alive) setView({ ...state });
    };
    const report = (cause: unknown) => {
      if (!alive) return;
      state.error = message(cause);
      state.loading = false;
      publish();
    };
    async function command<T>(body: BrowserCommand): Promise<T> {
      if (!alive || !opened) throw new Error("Session is not managed");
      const reply = await link.command(sessionId!, hostId, body);
      if (!("success" in reply.data) || !reply.data.success) {
        throw new Error(
          "error" in reply.data ? reply.data.error : "Command failed",
        );
      }
      // The generated reply is an uncorrelated union; the command fixes its result type.
      return reply.data.data as T;
    }
    async function refreshActivity() {
      const started = ++revision;
      const rosterVersion = agentRevision;
      const [live, saved, history, roster] = await Promise.allSettled([
        requestJson<State>(origin, `${sessionPath}/state?${query}`),
        requestJson<Session>(
          origin,
          `${sessionPath}?${query}&tail=1&deferThinking=1&deferMedia=1`,
        ),
        requestJson<History>(origin, `${sessionPath}/subagents?${query}`),
        opened
          ? command<{ subagents: unknown[] }>({ type: "get_subagents" })
          : Promise.resolve(null),
      ]);
      if (!alive || started !== revision) return;
      if (
        live.status === "fulfilled" &&
        live.value.state?.todoPhases !== undefined
      ) {
        state.phases = live.value.state.todoPhases;
      } else if (saved.status === "fulfilled") {
        state.phases = saved.value.context.todoPhases;
      }
      if (history.status === "fulfilled") {
        const entries: SubagentInfo[] = history.value.subagents.map((item) => ({
          ...item,
          source: "history" as const,
          progress: {
            tokens: item.tokens,
            cost: item.cost,
            contextTokens: item.contextTokens,
            contextWindow: item.contextWindow,
            durationMs: item.durationMs,
            lastIntent: item.lastIntent,
            resolvedModel: item.resolvedModel,
          },
        }));
        state.subagents = mergeSubagentRoster(state.subagents, entries);
      }
      if (
        roster.status === "fulfilled" &&
        roster.value &&
        rosterVersion === agentRevision
      ) {
        const snapshots = roster.value.subagents
          .map(parseSubagentSnapshot)
          .filter((item): item is SubagentInfo => item !== undefined);
        const ids = new Set(snapshots.map((item) => item.id));
        state.subagents = mergeSubagentRoster(
          state.subagents.filter(
            (item) =>
              item.source === "history" ||
              item.status !== "started" ||
              ids.has(item.id),
          ),
          snapshots,
        );
      }
      state.loading = false;
      state.error =
        live.status === "rejected" && saved.status === "rejected"
          ? message(live.reason)
          : history.status === "rejected" &&
              !(
                live.status === "fulfilled" &&
                live.value.running &&
                saved.status === "rejected"
              )
            ? message(history.reason)
            : roster.status === "rejected"
              ? message(roster.reason)
              : null;
      publish();
    }
    async function refreshOutput(job: Job, generation: string) {
      const selectedAt = selectionRevision;
      const openedAt = sessionEpoch;
      const detail = await command<Detail>({
        type: "get_job_output",
        kind: job.kind,
        id: job.id,
        incarnation: job.incarnation,
        generation,
        cursor: outputCursor,
      });
      if (
        !alive ||
        openedAt !== sessionEpoch ||
        selectedAt !== selectionRevision ||
        state.jobs?.generation !== generation ||
        !state.selected ||
        !sameJob(state.selected, job) ||
        detail.generation !== generation ||
        detail.id !== job.id ||
        detail.kind !== job.kind ||
        detail.incarnation !== job.incarnation
      )
        return;
      const replace =
        detail.start === 0 ||
        detail.start > outputCursor ||
        detail.cursor < outputCursor;
      let text = (replace ? "" : state.output) + detail.output;
      truncated = (replace ? false : truncated) || detail.truncated;
      if (text.length > 256 * 1024) {
        text = text.slice(-256 * 1024);
        truncated = true;
      }
      outputCursor = detail.cursor;
      state.output = text;
      state.detail = { ...detail, truncated };
      publish();
    }
    async function refreshJobs() {
      if (!opened) {
        state.loading = false;
        state.error = "Job session is unavailable";
        publish();
        return;
      }
      const openedAt = sessionEpoch;
      const snapshot = await command<Jobs>({ type: "get_jobs" });
      if (!alive || !opened || openedAt !== sessionEpoch) return;
      if (
        state.jobs?.available &&
        snapshot.generation !== state.jobs.generation
      ) {
        selectionRevision++;
        state.selected = null;
        state.detail = null;
        state.output = "";
        outputCursor = 0;
        truncated = false;
      }
      state.jobs = snapshot;
      state.loading = false;
      state.error = snapshot.available
        ? (snapshot.servicesError ?? null)
        : "Job session is unavailable";
      if (state.selected && snapshot.available) {
        const found = [...snapshot.jobs, ...snapshot.services].find((item) =>
          sameJob(item, state.selected!),
        );
        if (found) state.selected = found;
        else if (
          state.selected.endTime === undefined &&
          !["exited", "failed", "completed", "cancelled"].includes(
            state.selected.status,
          )
        ) {
          state.selected = {
            ...state.selected,
            status: "unavailable",
            canCancel: false,
          };
          state.error = snapshot.servicesError ?? "Job is no longer observable";
        }
        publish();
        if (found) await refreshOutput(found, snapshot.generation);
      }
      publish();
    }
    async function refresh() {
      if (!alive) return;
      if (refreshBusy) {
        refreshAgain = true;
        return;
      }
      refreshBusy = true;
      try {
        do {
          refreshAgain = false;
          try {
            if (kind === "activity") await refreshActivity();
            else await refreshJobs();
          } catch (cause) {
            report(cause);
          }
        } while (alive && refreshAgain);
      } finally {
        refreshBusy = false;
      }
    }
    function select(job: Job | null) {
      selectionRevision++;
      outputCursor = 0;
      truncated = false;
      state.selected = job;
      state.detail = null;
      state.output = "";
      state.error = null;
      publish();
      if (job && opened) void refresh();
    }
    async function cancel() {
      const job = state.selected;
      const snapshot = state.jobs;
      if (
        !opened ||
        !job?.canCancel ||
        !snapshot?.available ||
        state.cancelling ||
        (job.kind === "service" && snapshot.servicesError)
      )
        return;
      const selectedAt = selectionRevision;
      state.cancelling = true;
      publish();
      let failure: unknown;
      try {
        await command<{ requested: boolean }>({
          type: "cancel_job",
          kind: job.kind,
          id: job.id,
          incarnation: job.incarnation,
          generation: snapshot.generation,
        });
      } catch (cause) {
        failure = cause;
      } finally {
        if (alive) {
          state.cancelling = false;
          publish();
          await refresh();
          if (failure && alive && selectedAt === selectionRevision)
            report(failure);
        }
      }
    }
    actions.current = {
      refresh: () => {
        void refresh();
      },
      select,
      cancel: () => {
        void cancel();
      },
    };
    let subscribed = false;
    let releaseSession: (() => void) | undefined;
    function subscribeSession() {
      if (!alive || subscribed) return;
      subscribed = true;
      releaseSession = link.subscribe(
        { kind: "session", hostId, sessionId: sessionId! },
        {
          onOpen() {
            sessionEpoch++;
            opened = true;
            void refresh();
          },
          onEnd(reason, code) {
            sessionEpoch++;
            opened = false;
            selectionRevision++;
            if (kind === "jobs") {
              state.jobs = null;
              state.selected = null;
              state.detail = null;
              state.output = "";
              outputCursor = 0;
              truncated = false;
            }
            if (code) {
              subscribed = false;
              releaseSession = undefined;
            }
            if (code === "session_not_managed") {
              if (kind === "jobs") {
                state.loading = false;
                state.error = "Job session is unavailable";
                publish();
              } else {
                agentRevision++;
                state.subagents = state.subagents.filter(
                  (item) => item.source === "history",
                );
                void refresh();
              }
            } else report(new Error(reason));
          },
          onEvent(event) {
            if (!alive || !isRecord(event)) return;
            if (kind === "activity" && event.type === "agent_end") {
              agentRevision++;
              state.subagents = state.subagents.filter(
                (item) => item.source === "history",
              );
              publish();
            }
            if (kind === "activity" && event.type === "subagent_lifecycle") {
              const info = parseSubagentLifecycle(event.payload);
              if (info) {
                agentRevision++;
                state.subagents = mergeSubagentRoster(state.subagents, [info]);
                publish();
              }
            } else if (
              kind === "activity" &&
              event.type === "subagent_progress" &&
              isRecord(event.payload)
            ) {
              const progress = parseSubagentProgress(event.payload.progress);
              if (progress?.id) {
                agentRevision++;
                state.subagents = state.subagents.map((agent) =>
                  agent.id === progress.id
                    ? {
                        ...agent,
                        progress: { ...agent.progress, ...progress },
                        lastUpdate: Date.now(),
                      }
                    : agent,
                );
                publish();
              }
            }
            if (
              event.type === "agent_end" ||
              event.type === "agent_start" ||
              event.type === "tool_execution_start" ||
              event.type === "tool_execution_end" ||
              event.type === "todo_reminder" ||
              event.type === "todo_auto_clear"
            )
              void refresh();
          },
        },
      );
    }
    subscribeSession();
    const releaseJobs =
      kind === "jobs"
        ? link.subscribe(
            { kind: "workspace-jobs", hostId },
            {
              onOpen() {
                if (opened) void refresh();
              },
              onEvent(event) {
                if (
                  alive &&
                  opened &&
                  isRecord(event) &&
                  event.type === "workspace_jobs_changed" &&
                  event.scope === "runner" &&
                  (event.sessionId === undefined ||
                    event.sessionId === sessionId)
                )
                  void refresh();
              },
            },
          )
        : undefined;
    const releaseRunning = link.subscribe(
      { kind: "running" },
      {
        onEvent(data) {
          if (!alive || !isRecord(data)) return;
          if (
            data.type === "running" &&
            Array.isArray(data.runningSessions) &&
            data.runningSessions.some(
              (item) =>
                isRecord(item) &&
                item.hostId === hostId &&
                item.id === sessionId,
            )
          )
            subscribeSession();
          if (
            kind === "activity" &&
            data.type === "sessions-changed" &&
            Array.isArray(data.sessions) &&
            data.sessions.some(
              (item) =>
                isRecord(item) &&
                item.hostId === hostId &&
                item.sessionId === sessionId,
            )
          )
            void refresh();
        },
      },
    );
    if (kind === "activity") void refresh();
    return () => {
      alive = false;
      actions.current = null;
      releaseSession?.();
      releaseJobs?.();
      releaseRunning();
    };
  }, [origin, hostId, sessionId, link, kind]);
  useEffect(() => {
    if (kind === "jobs" && linkStatus === "open") actions.current?.refresh();
  }, [kind, linkStatus]);

  const button = (label: string, onPress: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        { borderColor: colors.border, opacity: disabled ? 0.5 : 1 },
      ]}
    >
      <Text style={{ color: colors.text }}>{label}</Text>
    </Pressable>
  );
  const title = (text: string) => (
    <Text style={[styles.title, { color: colors.text }]}>{text}</Text>
  );
  const muted = (text: string) => (
    <Text style={[styles.muted, { color: colors.muted }]}>{text}</Text>
  );
  const error = view.error ? (
    <Text accessibilityRole="alert" style={{ color: colors.accent }}>
      {view.error}
    </Text>
  ) : null;
  const field = (label: string, value: string | number | undefined) =>
    value === undefined || value === "" ? null : (
      <Text style={{ color: colors.text }}>
        <Text style={{ color: colors.muted }}>{label}: </Text>
        {value}
      </Text>
    );
  const selected = view.selected;
  const candidates = Array.isArray(selectedAgent)
    ? selectedAgent
    : selectedAgent
      ? [selectedAgent]
      : [];
  const agent: SubagentInfo | undefined =
    candidates
      .map((id) => view.subagents.find((item) => item.id === id))
      .find((item) => item !== undefined) ??
    (candidates.length
      ? {
          id: candidates[candidates.length - 1],
          agent: candidates[candidates.length - 1],
          status: "completed",
          index: 0,
          source: "history",
        }
      : undefined);
  const cleanOutput = stripAnsi(view.output).replace(
    /[\x00-\x08\x0B-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
    "",
  );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
    >
      {!sessionId
        ? muted("Select a session")
        : view.loading
          ? muted("Loading…")
          : null}
      {sessionId && kind === "activity" && !view.loading && (
        <>
          {agent ? (
            <View style={styles.gap}>
              {button("Back", () => setSelectedAgent(null))}
              {title(agent.description || agent.agent)}
              {field("Status", agent.status)}
              {field("Agent", agent.agent)}
              {field("Task", agent.task)}
              {field("Assignment", agent.assignment)}
              {field("Current tool", agent.progress?.currentTool)}
              {field("Activity", agent.progress?.lastIntent)}
              {field("Model", agent.progress?.resolvedModel)}
              {field("Error", agent.result?.error)}
              <SubagentCompletion
                key={agent.id}
                origin={origin}
                hostId={hostId}
                sessionId={sessionId}
                agentId={agent.id}
                status={agent.status}
                revision={completionRevision}
                colors={colors}
              />
            </View>
          ) : (
            <>
              {view.phases.length === 0 &&
              view.subagents.length === 0 &&
              !view.error
                ? muted("No activity yet")
                : null}
              {view.phases.length > 0 && (
                <View
                  style={[
                    styles.card,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.panel,
                    },
                  ]}
                >
                  {title(
                    `Tasks · ${view.phases.flatMap((phase) => phase.tasks).filter((task) => task.status === "completed").length}/${view.phases.flatMap((phase) => phase.tasks).length}`,
                  )}
                  {view.phases.map((phase, index) => (
                    <View
                      key={phase.id ?? `${phase.name}-${index}`}
                      style={styles.gap}
                    >
                      {muted(phase.name)}
                      {phase.tasks.map((task, taskIndex) => (
                        <View
                          key={task.id ?? `${task.content}-${taskIndex}`}
                          style={styles.task}
                        >
                          <Text
                            style={{
                              color:
                                task.status === "in_progress" ||
                                task.status === "completed"
                                  ? colors.accent
                                  : colors.muted,
                            }}
                          >
                            {task.status === "completed"
                              ? "✓"
                              : task.status === "in_progress"
                                ? "◉"
                                : task.status === "blocked"
                                  ? "!"
                                  : task.status === "abandoned"
                                    ? "–"
                                    : "○"}
                          </Text>
                          <View style={{ flex: 1 }}>
                            <Text
                              accessibilityLabel={`${task.status.replace("_", " ")}: ${task.content}`}
                              style={{
                                color: colors.text,
                                textDecorationLine:
                                  task.status === "completed" ||
                                  task.status === "abandoned"
                                    ? "line-through"
                                    : "none",
                              }}
                            >
                              {task.content}
                            </Text>
                            {task.blocker
                              ? muted(`Blocked: ${task.blocker}`)
                              : null}
                          </View>
                        </View>
                      ))}
                    </View>
                  ))}
                </View>
              )}
              {view.subagents.length > 0 && (
                <View
                  style={[
                    styles.card,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.panel,
                    },
                  ]}
                >
                  {title(`Subagents · ${view.subagents.length}`)}
                  {view.subagents.map((item) => (
                    <Pressable
                      key={item.id}
                      accessibilityRole="button"
                      onPress={() => setSelectedAgent(item.id)}
                      style={[styles.row, { borderColor: colors.border }]}
                    >
                      <Text style={{ color: colors.text, fontWeight: "600" }}>
                        {item.description || item.task || item.agent}
                      </Text>
                      {muted(
                        `${item.agent} · ${item.status}${item.progress?.currentTool ? ` · ${item.progress.currentTool}` : ""}`,
                      )}
                    </Pressable>
                  ))}
                </View>
              )}
            </>
          )}
          {error}
          {button("Refresh", () => {
            actions.current?.refresh();
            if (selectedAgent)
              setCompletionRevision((revision) => revision + 1);
          })}
        </>
      )}
      {sessionId &&
        kind === "jobs" &&
        !view.loading &&
        (selected ? (
          <View style={styles.gap}>
            {button("Back", () => actions.current?.select(null))}
            {title(selected.label)}
            {muted(selected.status)}
            {field("Command", view.detail?.command ?? selected.command)}
            {field("Working directory", view.detail?.cwd)}
            {field("Owner", selected.ownerId)}
            {field(
              "PIDs",
              view.detail?.pids.length
                ? view.detail.pids.join(", ")
                : undefined,
            )}
            {field("Started", new Date(selected.startTime).toLocaleString())}
            {field(
              "Ended",
              selected.endTime === undefined
                ? undefined
                : new Date(selected.endTime).toLocaleString(),
            )}
            {field("Exit code", view.detail?.exitCode)}
            {selected.endTime !== undefined && selected.kind !== "service"
              ? muted("Output retained after completion")
              : null}
            {selected.canCancel
              ? button(
                  view.cancelling
                    ? "Requesting…"
                    : selected.kind === "service"
                      ? "Stop"
                      : "Cancel",
                  () => actions.current?.cancel(),
                  view.cancelling || !view.jobs?.available,
                )
              : null}
            {button("Refresh", () => actions.current?.refresh())}
            {error}
            {title("Output")}
            {view.detail?.truncated ? muted("Output truncated") : null}
            <Text
              selectable
              style={[
                styles.output,
                {
                  color: colors.text,
                  backgroundColor: colors.panel,
                  borderColor: colors.border,
                },
              ]}
            >
              {cleanOutput}
            </Text>
          </View>
        ) : (
          <View style={styles.gap}>
            <View style={styles.header}>
              {title("Jobs")}
              {button("Refresh", () => actions.current?.refresh())}
            </View>
            {view.jobs?.available ? (
              <>
                {view.jobs.jobs.length
                  ? view.jobs.jobs.map((job) => (
                      <Pressable
                        key={`${job.kind}:${job.id}:${job.incarnation}`}
                        accessibilityRole="button"
                        onPress={() => actions.current?.select(job)}
                        style={[styles.row, { borderColor: colors.border }]}
                      >
                        <View style={styles.header}>
                          <Text
                            style={{
                              color: colors.text,
                              fontWeight: "600",
                              flex: 1,
                            }}
                          >
                            {job.label}
                          </Text>
                          {muted(job.status)}
                        </View>
                        {job.command ? muted(job.command) : null}
                        {job.ownerId ? muted(`Owner: ${job.ownerId}`) : null}
                      </Pressable>
                    ))
                  : muted("No jobs")}
                {title("Services")}
                {view.jobs.servicesError
                  ? muted(`Services unavailable: ${view.jobs.servicesError}`)
                  : view.jobs.services.length
                    ? view.jobs.services.map((job) => (
                        <Pressable
                          key={`${job.kind}:${job.id}:${job.incarnation}`}
                          accessibilityRole="button"
                          onPress={() => actions.current?.select(job)}
                          style={[styles.row, { borderColor: colors.border }]}
                        >
                          <View style={styles.header}>
                            <Text
                              style={{
                                color: colors.text,
                                fontWeight: "600",
                                flex: 1,
                              }}
                            >
                              {job.label}
                            </Text>
                            {muted(job.status)}
                          </View>
                          {job.command ? muted(job.command) : null}
                        </Pressable>
                      ))
                    : muted("No services")}
              </>
            ) : (
              muted("Job session is unavailable")
            )}
            {error}
          </View>
        ))}
    </ScrollView>
  );
}

function SubagentCompletion({
  origin,
  hostId,
  sessionId,
  agentId,
  status,
  revision,
  colors,
}: {
  origin: string;
  hostId: string;
  sessionId: string;
  agentId: string;
  status: SubagentInfo["status"];
  revision: number;
  colors: NativeTranscriptPalette;
}) {
  const [result, setResult] = useState<
    | { state: "loading" }
    | { state: "error"; message: string }
    | { state: "ready"; completion: string | null; truncated: boolean }
  >({ state: "loading" });

  useEffect(() => {
    let current = true;
    setResult({ state: "loading" });
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}?mode=completion&hostId=${encodeURIComponent(hostId)}`;
    void requestJson<CompletionResponse>(origin, path).then(
      (response) => {
        if (
          !isRecord(response) ||
          !("completion" in response) ||
          (response.completion !== null &&
            typeof response.completion !== "string") ||
          typeof response.truncated !== "boolean"
        ) {
          setResult({ state: "error", message: "Invalid completion response" });
          return;
        }
        setResult({
          state: "ready",
          completion: response.completion,
          truncated: response.truncated,
        });
      },
      (cause: unknown) => {
        if (current) setResult({ state: "error", message: message(cause) });
      },
    );
    return () => {
      current = false;
    };
  }, [origin, hostId, sessionId, agentId, status, revision]);

  return (
    <View
      style={[
        styles.card,
        { borderColor: colors.border, backgroundColor: colors.panel },
      ]}
    >
      <Text style={[styles.title, { color: colors.text }]}>Result</Text>
      {result.state === "loading" ? (
        <Text style={[styles.muted, { color: colors.muted }]}>
          Loading result…
        </Text>
      ) : result.state === "error" ? (
        <Text accessibilityRole="alert" style={{ color: colors.accent }}>
          {result.message}
        </Text>
      ) : (
        <>
          {result.truncated ? (
            <Text style={[styles.muted, { color: colors.muted }]}>
              Output truncated
            </Text>
          ) : null}
          {result.completion ? (
            <ChatMarkdown text={result.completion} palette={colors} />
          ) : (
            <Text style={[styles.muted, { color: colors.muted }]}>
              No final output yet
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 12, gap: 12 },
  gap: { gap: 8 },
  card: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 10 },
  title: { fontSize: 14, fontWeight: "600" },
  muted: { fontSize: 12 },
  row: {
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  task: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  button: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    alignSelf: "flex-start",
  },
  output: {
    fontFamily: "Menlo",
    fontSize: 12,
    borderWidth: 1,
    padding: 8,
    minHeight: 80,
  },
});
