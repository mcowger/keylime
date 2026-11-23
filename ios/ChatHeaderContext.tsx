import { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import {
  formatCompactNumber,
  formatPercent,
  getCacheHitRate,
} from "../lib/format";
import type { BrowserLink, BrowserLinkStatus } from "./browser-link";
import {
  formatCacheHitRate,
  formatContextMetrics,
  formatSessionCosts,
  type SessionContextStatistics,
  type ContextStats,
} from "./chat-context-stats";
import type { ChatSessionView } from "./useChatSession";
import type { operations } from "./generated/web-http";
import { KeylimeHttpError, requestJson } from "./keylime-http";
import { copyText } from "./native-network";

type Usage = NonNullable<
  NonNullable<ChatSessionView["state"]>["state"]
>["contextUsage"];
type State =
  operations["getSessionState"]["responses"][200]["content"]["application/json"];
type History =
  operations["listSessionSubagents"]["responses"][200]["content"]["application/json"];
type Catalog =
  operations["getModels"]["responses"][200]["content"]["application/json"];
type ModelIdentity = NonNullable<NonNullable<State["state"]>["model"]>;

type Props = {
  origin: string;
  link: BrowserLink;
  linkStatus: BrowserLinkStatus;
  hostId: string;
  sessionId: string;
  usage: Usage;
  model?: string;
  modelIdentity: ModelIdentity | null;
  busy: boolean;
  running: boolean;
  colors: { panel: string; border: string; text: string; muted: string };
};

export function ChatHeaderContext(props: Props) {
  return (
    <ContextContent
      key={JSON.stringify([props.origin, props.hostId, props.sessionId])}
      {...props}
    />
  );
}

function ContextContent({
  origin,
  link,
  hostId,
  sessionId,
  usage,
  model,
  modelIdentity,
  busy,
  running,
  colors,
}: Props) {
  const light = useColorScheme() === "light";
  const [open, setOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<ContextStats | null>(null);
  const [costs, setCosts] = useState<History["costs"]>();
  const [liveContext, setLiveContext] = useState<Usage>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [costsLoading, setCostsLoading] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [savedModel, setSavedModel] =
    useState<SessionContextStatistics["model"]>(null);
  const [speed, setSpeed] = useState<{
    current: number | null;
    average: number | null;
  }>({ current: null, average: null });
  const samples = useRef<number[]>([]);
  const historySamples = useRef<number[]>([]);
  const pendingStats = useRef<Promise<SessionContextStatistics> | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const lastSpeed = useRef<number | null>(null);
  const [copied, setCopied] = useState<"file" | "id" | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(copyTimer.current);
    },
    [],
  );
  const copy = (field: "file" | "id", value: string) => {
    void copyText(value)
      .then(() => {
        clearTimeout(copyTimer.current);
        setCopied(field);
        copyTimer.current = setTimeout(() => setCopied(null), 1400);
      })
      .catch(() => {});
  };
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setStats(null);
    setCosts(undefined);
    setLiveContext(null);
    setHistoryLoading(true);
    setStatsError(null);
    setCostsLoading(true);
    setCatalog(null);
    setSavedModel(null);
    samples.current = [];
    historySamples.current = [];
    lastSpeed.current = null;
    setSpeed({ current: null, average: null });
    const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const query = `hostId=${encodeURIComponent(hostId)}`;
    const averageSpeed = () => {
      const all = [...historySamples.current, ...samples.current].slice(-32);
      return all.length
        ? all.reduce((sum, value) => sum + value, 0) / all.length
        : null;
    };
    let statsPending = false;
    const refreshStats = () => {
      if (statsPending) return;
      statsPending = true;
      const pending =
        pendingStats.current ??
        requestJson<SessionContextStatistics>(
          origin,
          `${sessionPath}/context-stats?${query}`,
        );
      pendingStats.current = pending;
      void pending
        .then((result) => {
          if (disposed) return;
          setStatsError(null);
          setStats(result.stats);
          setSavedModel(result.model);
          historySamples.current = result.speedSamples;
          setSpeed((previous) => ({ ...previous, average: averageSpeed() }));
        })
        .catch((cause) => {
          if (disposed) return;
          setStatsError(
            cause instanceof KeylimeHttpError && cause.status === 501
              ? "Update the session's host daemon to show statistics."
              : "Session statistics unavailable",
          );
          setStats(null);
          setSavedModel(null);
          historySamples.current = [];
          setSpeed((previous) => ({ ...previous, average: averageSpeed() }));
        })
        .finally(() => {
          if (pendingStats.current === pending) pendingStats.current = null;
          statsPending = false;
          if (!disposed) setHistoryLoading(false);
        });
    };
    refreshStats();
    let costsPending = false;
    const refreshCosts = () => {
      if (costsPending) return;
      costsPending = true;
      void requestJson<History>(origin, `${sessionPath}/subagents?${query}`)
        .then((history) => {
          if (!disposed) setCosts(history.costs);
        })
        .catch(() => {})
        .finally(() => {
          costsPending = false;
          if (!disposed) setCostsLoading(false);
        });
    };
    refreshCosts();
    void requestJson<Catalog>(origin, `/api/models?${query}`)
      .then((result) => {
        if (!disposed) setCatalog(result);
      })
      .catch(() => {});
    let samplePending = false;
    const sample = () => {
      if (samplePending) return;
      samplePending = true;
      void requestJson<State>(origin, `${sessionPath}/state?${query}`)
        .then((result) => {
          if (disposed) return;
          setLiveContext(result.state?.contextUsage ?? null);
          const value = result.state?.tokensPerSecond;
          if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value <= 0
          ) {
            lastSpeed.current = null;
            setSpeed((previous) => ({ ...previous, current: null }));
            return;
          }
          const current = Math.round(value * 10) / 10;
          if (lastSpeed.current === current) return;
          lastSpeed.current = current;
          samples.current = [...samples.current, current].slice(-32);
          setSpeed({ current, average: averageSpeed() });
        })
        .catch(() => {})
        .finally(() => {
          samplePending = false;
        });
    };
    sample();
    const timer = setInterval(() => {
      if (runningRef.current) sample();
    }, 2000);
    const refreshTimer = setInterval(() => {
      if (!runningRef.current) return;
      refreshStats();
      refreshCosts();
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearInterval(refreshTimer);
    };
  }, [open, origin, sessionId, hostId]);
  const context = usage ?? liveContext ?? stats?.contextUsage ?? null;
  const percent = context?.percent ?? null;
  const fraction = Math.max(0, Math.min(1, (percent ?? 0) / 100));
  const color =
    percent !== null && percent > 90
      ? light
        ? "#B42318"
        : "#FF9B92"
      : percent !== null && percent > 70
        ? light
          ? "#8A5A00"
          : "#F0C36A"
        : colors.muted;
  const selectedModel = modelIdentity
    ? { provider: modelIdentity.provider, id: modelIdentity.id }
    : savedModel
      ? { provider: savedModel.provider, id: savedModel.modelId }
      : null;
  const capacity = selectedModel
    ? catalog?.modelList.find(
        (item) =>
          item.provider === selectedModel.provider &&
          item.id === selectedModel.id,
      )
    : undefined;
  const cacheRate = stats
    ? getCacheHitRate(stats.tokens.input, stats.tokens.cacheRead)
    : null;
  const metrics = formatContextMetrics(
    context?.contextWindow || capacity?.contextWindow,
    capacity?.maxTokens,
    speed.current,
    speed.average,
  );
  const formattedCosts = costs ? formatSessionCosts(costs) : null;
  const statRow = (label: string, value: string, field?: "file" | "id") => (
    <View key={label} style={styles.row}>
      <Text style={[styles.statText, { color: colors.muted }]}>{label}</Text>
      <View style={styles.statValue}>
        <Text numberOfLines={1} style={[styles.value, { color: colors.text }]}>
          {value}
        </Text>
        {field && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied === field ? "Copied" : `Copy ${label}`}
            onPress={() => copy(field, value)}
            hitSlop={6}
          >
            <Text style={[styles.statText, { color: colors.muted }]}>
              {copied === field ? "Copied" : "Copy"}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
  const compact = async () => {
    setCompacting(true);
    setError("");
    try {
      const reply = await link.command(sessionId, hostId, { type: "compact" });
      if (!("success" in reply.data) || !reply.data.success)
        throw new Error(
          "error" in reply.data
            ? reply.data.error
            : "Could not compact context",
        );
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCompacting(false);
    }
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          percent === null
            ? "Session context"
            : `Session context, ${Math.round(percent)} percent used`
        }
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={styles.trigger}
      >
        <View style={[styles.ring, { borderColor: colors.border }]}>
          {percent !== null && (
            <>
              <View style={styles.leftClip}>
                <View
                  style={[
                    styles.arc,
                    {
                      left: -10,
                      borderTopColor: color,
                      borderRightColor: color,
                      transform: [
                        { rotate: `${180 + Math.min(fraction, 0.5) * 360}deg` },
                      ],
                    },
                  ]}
                />
              </View>
              {fraction > 0.5 && (
                <View style={styles.rightClip}>
                  <View
                    style={[
                      styles.arc,
                      {
                        left: 0,
                        borderTopColor: color,
                        borderRightColor: color,
                        transform: [{ rotate: `${(fraction - 0.5) * 360}deg` }],
                      },
                    ]}
                  />
                </View>
              )}
              <Text style={[styles.percent, { color }]}>
                {Math.round(percent)}
              </Text>
            </>
          )}
        </View>
      </Pressable>
      <Modal
        transparent
        visible={open}
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel="Close session context"
            onPress={() => setOpen(false)}
          />
          <SafeAreaView pointerEvents="box-none" style={styles.safeArea}>
            <View pointerEvents="box-none" style={styles.panelArea}>
              <ScrollView
                accessibilityViewIsModal
                style={[
                  styles.panel,
                  { backgroundColor: colors.panel, borderColor: colors.border },
                ]}
                contentContainerStyle={styles.panelContent}
              >
                <View style={styles.row}>
                  <Text style={[styles.title, { color: colors.text }]}>
                    Context
                  </Text>
                  {percent !== null && (
                    <Text style={[styles.statText, { color: colors.text }]}>
                      {formatPercent(percent)}
                    </Text>
                  )}
                </View>
                {context?.contextWindow ? (
                  <View style={styles.section}>
                    <Text style={[styles.usage, { color: colors.text }]}>
                      {context.tokens == null
                        ? "?"
                        : formatCompactNumber(context.tokens)}{" "}
                      / {formatCompactNumber(context.contextWindow)}
                      {percent === null ? "" : ` (${formatPercent(percent)})`}
                    </Text>
                    <View
                      style={[styles.bar, { backgroundColor: colors.border }]}
                    >
                      <View
                        style={{
                          width: `${fraction * 100}%`,
                          height: 5,
                          backgroundColor: color,
                        }}
                      />
                    </View>
                  </View>
                ) : (
                  <Text style={[styles.note, { color: colors.muted }]}>
                    Context usage unavailable
                  </Text>
                )}
                {!!metrics && (
                  <Text style={[styles.note, { color: colors.muted }]}>
                    {metrics}
                  </Text>
                )}
                <View style={styles.section}>
                  <Text style={[styles.sectionTitle, { color: colors.text }]}>
                    Session Info
                  </Text>
                  {stats?.sessionName
                    ? statRow("Name", stats.sessionName)
                    : null}
                  {statRow(
                    "File",
                    stats?.sessionFile ?? (stats ? "In-memory" : "Unavailable"),
                    stats?.sessionFile ? "file" : undefined,
                  )}
                  {statRow("ID", stats?.sessionId ?? sessionId, "id")}
                  {model ? statRow("Model", model) : null}
                </View>
                {stats ? (
                  <>
                    <View style={styles.section}>
                      <Text
                        style={[styles.sectionTitle, { color: colors.text }]}
                      >
                        Messages
                      </Text>
                      {statRow("User", stats.userMessages.toLocaleString())}
                      {statRow(
                        "Assistant",
                        stats.assistantMessages.toLocaleString(),
                      )}
                      {statRow("Tool Calls", stats.toolCalls.toLocaleString())}
                      {statRow(
                        "Tool Results",
                        stats.toolResults.toLocaleString(),
                      )}
                      {statRow("Total", stats.totalMessages.toLocaleString())}
                    </View>
                    <View style={styles.section}>
                      <Text
                        style={[styles.sectionTitle, { color: colors.text }]}
                      >
                        Tokens
                      </Text>
                      {statRow("Input", stats.tokens.input.toLocaleString())}
                      {statRow("Output", stats.tokens.output.toLocaleString())}
                      {stats.tokens.cacheRead > 0 &&
                        statRow(
                          "Cache Read",
                          stats.tokens.cacheRead.toLocaleString(),
                        )}
                      {stats.tokens.cacheWrite > 0 &&
                        statRow(
                          "Cache Write",
                          stats.tokens.cacheWrite.toLocaleString(),
                        )}
                      {statRow("Total", stats.tokens.total.toLocaleString())}
                      {cacheRate !== null &&
                        statRow("Cache Hit", formatCacheHitRate(cacheRate))}
                    </View>
                  </>
                ) : (
                  <Text style={[styles.note, { color: colors.muted }]}>
                    {historyLoading
                      ? "Loading session statistics…"
                      : (statsError ?? "Session statistics unavailable")}
                  </Text>
                )}
                {formattedCosts ? (
                  <View style={styles.section}>
                    {statRow("Agent Cost", formattedCosts.agent)}
                    {statRow("Sub Cost", formattedCosts.subagents)}
                    {statRow("Total Cost", formattedCosts.total)}
                    <Text style={[styles.note, { color: colors.muted }]}>
                      Reported usage from the full session file, including
                      branches. Costs refresh as history is committed and may
                      omit unavailable or nested usage.
                    </Text>
                  </View>
                ) : (
                  <Text style={[styles.note, { color: colors.muted }]}>
                    {costsLoading
                      ? "Loading session costs…"
                      : "Session costs unavailable"}
                  </Text>
                )}
                {!!error && (
                  <Text
                    accessibilityRole="alert"
                    style={[
                      styles.error,
                      { color: light ? "#B42318" : "#FF9B92" },
                    ]}
                  >
                    {error}
                  </Text>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || compacting }}
                  disabled={busy || compacting}
                  onPress={() => void compact()}
                  style={[
                    styles.compact,
                    { borderColor: colors.border },
                    (busy || compacting) && { opacity: 0.45 },
                  ]}
                >
                  <Text style={{ color: colors.text }}>
                    {compacting ? "Compacting…" : "Compact context"}
                  </Text>
                </Pressable>
              </ScrollView>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2.5,
    alignItems: "center",
    justifyContent: "center",
  },
  leftClip: {
    position: "absolute",
    width: 10,
    height: 20,
    top: -2.5,
    left: 7.5,
    overflow: "hidden",
  },
  rightClip: {
    position: "absolute",
    width: 10,
    height: 20,
    top: -2.5,
    left: -2.5,
    overflow: "hidden",
  },
  arc: {
    position: "absolute",
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: "transparent",
  },
  percent: { fontSize: 7, fontWeight: "700" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  safeArea: { flex: 1 },
  panelArea: {
    flex: 1,
    paddingTop: 56,
    paddingBottom: 8,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  panel: {
    borderWidth: 1,
    borderRadius: 12,
    width: "100%",
    maxWidth: 420,
    maxHeight: "100%",
    flexGrow: 0,
    flexShrink: 1,
  },
  panelContent: { padding: 12, gap: 10 },
  section: { gap: 3 },
  sectionTitle: {
    fontFamily: "Menlo",
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 1,
  },
  statText: { fontFamily: "Menlo", fontSize: 11 },
  statValue: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: 5,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    alignItems: "center",
  },
  title: { fontSize: 13, fontWeight: "700" },
  usage: { fontFamily: "Menlo", fontSize: 13, fontWeight: "700" },
  note: { fontFamily: "Menlo", fontSize: 10 },
  value: { fontFamily: "Menlo", flexShrink: 1, fontSize: 11 },
  bar: { height: 5, borderRadius: 3, overflow: "hidden" },
  compact: {
    height: 36,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  error: { fontSize: 12 },
});
