import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { ModelActivity } from "../lib/model-activity";

export function ComposerActivity({
  activity,
  color,
  accent,
}: {
  activity?: ModelActivity;
  color: string;
  accent: string;
}) {
  const kind = activity?.kind ?? "idle";
  const timed = kind === "waiting" || kind === "tools";
  const startedAt = activity?.startedAt ?? 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [timed, startedAt]);
  const value = timed
    ? (Math.max(0, now - startedAt) / 1000).toFixed(1)
    : kind === "streaming"
      ? String(Math.round(activity?.rate ?? 0))
      : null;
  const tone = kind === "tools" ? accent : color;
  const label =
    kind === "idle"
      ? "Model idle"
      : kind === "waiting"
        ? `Waiting for model, ${value} seconds`
        : kind === "tools"
          ? `Tools running, ${value} seconds`
          : `Streaming, approximately ${value} tokens per second`;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={styles.indicator}
    >
      {value !== null && (
        <Text style={[styles.number, { color: tone }]}>{value}</Text>
      )}
      {kind === "waiting" ? (
        <ActivityIndicator size="small" color={tone} />
      ) : kind === "idle" ? (
        <View style={[styles.circle, { borderColor: tone }]} />
      ) : (
        <Text style={{ color: tone }}>{kind === "tools" ? "⚒" : "ϟ"}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  indicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginRight: 8,
  },
  number: { fontSize: 11, fontVariant: ["tabular-nums"] },
  circle: { width: 12, height: 12, borderWidth: 1.5, borderRadius: 6 },
});
