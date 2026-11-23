import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { BrowserLink } from "./browser-link";
import type { ChatSessionView } from "./useChatSession";
import type { components } from "./generated/browser-link";

type Usage = NonNullable<NonNullable<ChatSessionView["state"]>["state"]>["contextUsage"];
type Stats = Extract<components["schemas"]["BrowserReply_get_session_stats"]["data"], { success: true }>["data"];

export function ChatHeaderContext({
  link, hostId, sessionId, usage, model, busy, running, colors,
}: {
  link: BrowserLink;
  hostId: string;
  sessionId: string;
  usage: Usage;
  model?: string;
  busy: boolean;
  running: boolean;
  colors: { panel: string; border: string; text: string; muted: string };
}) {
  const [open, setOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    if (!open || !running) return;
    let disposed = false;
    void link.command(sessionId, hostId, { type: "get_session_stats" }).then((reply) => {
      if (!disposed && "success" in reply.data && reply.data.success && "data" in reply.data)
        setStats(reply.data.data as Stats);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [open, running, link, sessionId, hostId]);
  const context = usage ?? stats?.contextUsage ?? null;
  const percent = context?.percent ?? null;
  const fraction = Math.max(0, Math.min(1, (percent ?? 0) / 100));
  const color = percent !== null && percent > 90 ? "#E67070" : percent !== null && percent > 70 ? "#D9A65B" : colors.muted;
  const compact = async () => {
    setCompacting(true);
    setError("");
    try {
      const reply = await link.command(sessionId, hostId, { type: "compact" });
      if (!("success" in reply.data) || !reply.data.success)
        throw new Error("error" in reply.data ? reply.data.error : "Could not compact context");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCompacting(false);
    }
  };
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={percent === null ? "Session context" : `Session context, ${Math.round(percent)} percent used`} accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={styles.trigger}>
        <View style={[styles.ring, { borderColor: colors.border }]}>
          {percent !== null && <>
            <View style={styles.leftClip}><View style={[styles.arc, { left: -10, borderTopColor: color, borderRightColor: color, transform: [{ rotate: `${180 + Math.min(fraction, 0.5) * 360}deg` }] }]} /></View>
            {fraction > 0.5 && <View style={styles.rightClip}><View style={[styles.arc, { left: 0, borderTopColor: color, borderRightColor: color, transform: [{ rotate: `${(fraction - 0.5) * 360}deg` }] }]} /></View>}
            <Text style={[styles.percent, { color }]}>{Math.round(percent)}</Text>
          </>}
        </View>
      </Pressable>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.overlay}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close session context" onPress={() => setOpen(false)} />
          <ScrollView accessibilityViewIsModal style={[styles.panel, { backgroundColor: colors.panel, borderColor: colors.border }]} contentContainerStyle={styles.panelContent}>
            <View style={styles.row}><Text style={[styles.title, { color: colors.text }]}>Session context</Text>{percent !== null && <Text style={{ color }}>{percent.toFixed(1)}%</Text>}</View>
            {context?.contextWindow ? <>
              <Text style={[styles.usage, { color: colors.text }]}>{context.tokens?.toLocaleString() ?? "?"} / {context.contextWindow.toLocaleString()} tokens</Text>
              <View style={[styles.bar, { backgroundColor: colors.border }]}><View style={{ width: `${fraction * 100}%`, height: 5, backgroundColor: color }} /></View>
            </> : <Text style={[styles.note, { color: colors.muted }]}>Context usage unavailable</Text>}
            <View style={styles.row}><Text style={{ color: colors.muted }}>Session ID</Text><Text numberOfLines={1} style={[styles.value, { color: colors.text }]}>{sessionId}</Text></View>
            {model && <View style={styles.row}><Text style={{ color: colors.muted }}>Model</Text><Text numberOfLines={1} style={[styles.value, { color: colors.text }]}>{model}</Text></View>}
            {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            {stats && <>
              {stats.sessionFile && <View style={styles.row}><Text style={{ color: colors.muted }}>Session file</Text><Text numberOfLines={1} style={[styles.value, { color: colors.text }]}>{stats.sessionFile}</Text></View>}
              <Text style={[styles.title, { color: colors.text }]}>Messages</Text>
              {[["User", stats.userMessages], ["Assistant", stats.assistantMessages], ["Tool calls", stats.toolCalls], ["Tool results", stats.toolResults], ["Total", stats.totalMessages]].map(([label, value]) => <View key={label} style={styles.row}><Text style={{ color: colors.muted }}>{label}</Text><Text style={{ color: colors.text }}>{value.toLocaleString()}</Text></View>)}
              <Text style={[styles.title, { color: colors.text }]}>Tokens</Text>
              {[["Input", stats.tokens.input], ["Output", stats.tokens.output], ["Cache read", stats.tokens.cacheRead], ["Cache write", stats.tokens.cacheWrite], ["Total", stats.tokens.total]].map(([label, value]) => <View key={label} style={styles.row}><Text style={{ color: colors.muted }}>{label}</Text><Text style={{ color: colors.text }}>{value.toLocaleString()}</Text></View>)}
            </>}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || compacting }} disabled={busy || compacting} onPress={() => void compact()} style={[styles.compact, { borderColor: colors.border }, (busy || compacting) && { opacity: 0.45 }]}><Text style={{ color: colors.text }}>{compacting ? "Compacting…" : "Compact context"}</Text></Pressable>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  ring: { width: 20, height: 20, borderRadius: 10, borderWidth: 2.5, alignItems: "center", justifyContent: "center" },
  leftClip: { position: "absolute", width: 10, height: 20, top: -2.5, left: 7.5, overflow: "hidden" },
  rightClip: { position: "absolute", width: 10, height: 20, top: -2.5, left: -2.5, overflow: "hidden" },
  arc: { position: "absolute", width: 20, height: 20, borderRadius: 10, borderWidth: 2.5, borderColor: "transparent" },
  percent: { fontSize: 7, fontWeight: "700" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", paddingHorizontal: 8, paddingTop: 100 },
  panel: { borderWidth: 1, borderRadius: 12, maxHeight: "85%" },
  panelContent: { padding: 12, gap: 10 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 8, alignItems: "center" },
  title: { fontSize: 13, fontWeight: "700" },
  usage: { fontSize: 13, fontWeight: "700" },
  note: { fontSize: 12 },
  value: { flexShrink: 1, fontSize: 12 },
  bar: { height: 5, borderRadius: 3, overflow: "hidden" },
  compact: { height: 36, borderWidth: 1, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  error: { color: "#E67070", fontSize: 12 },
});
