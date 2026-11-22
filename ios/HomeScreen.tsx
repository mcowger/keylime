import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { operations } from "./generated/web-http";
import { HomeIcon } from "./HomeIcons";
import { theme } from "./theme";

export type HomeSessionInfo =
  operations["listSessions"]["responses"][200]["content"]["application/json"]["sessions"][number];

// This is a presentation projection, not a second session wire contract.
export type HomeSession = {
  session: HomeSessionInfo;
  status: "Awaiting input" | "Running" | "Not running";
  hostName: string;
  place?: string;
};

export type HomeScreenProps = {
  active: readonly HomeSession[];
  recent: readonly HomeSession[];
  onSelectSession?: (session: HomeSessionInfo) => void;
  onNewWorkspace?: () => void;
  onNewEffort?: () => void;
};

function titleFor(session: HomeSessionInfo): string {
  const name = session.name?.trim();
  if (name) return name;
  const firstMessage = session.firstMessage.trim();
  return firstMessage && firstMessage !== "(no messages)"
    ? firstMessage.replace(/\s+/g, " ")
    : "New chat";
}

function locationFor(row: HomeSession): string {
  const cwd = row.session.cwd;
  const fileName = cwd.replace(/\/+$/, "").split("/").pop();
  return `${row.place || fileName || cwd} · ${row.hostName}`;
}

function Action({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: "folder-plus" | "layers";
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        pressed && styles.pressed,
        !onPress && styles.disabled,
      ]}
    >
      <HomeIcon name={icon} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

function SessionRow({
  row,
  onSelect,
}: {
  row: HomeSession;
  onSelect?: (session: HomeSessionInfo) => void;
}) {
  const title = titleFor(row.session);
  const modified = Date.parse(row.session.modified) || 0;
  const date =
    modified > 0
      ? new Date(modified).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : undefined;
  const content = (
    <>
      <HomeIcon
        name={
          row.status === "Awaiting input"
            ? "question"
            : row.status === "Running"
              ? "bot"
              : "message"
        }
      />
      <View style={styles.sessionContent}>
        <Text style={styles.sessionTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.sessionContext} numberOfLines={1}>
          {locationFor(row)}
        </Text>
      </View>
      <View style={styles.sessionMeta}>
        <Text
          style={[
            styles.sessionStatus,
            row.status === "Awaiting input" && styles.awaiting,
          ]}
        >
          {row.status}
        </Text>
        {date && <Text style={styles.sessionDate}>{date}</Text>}
      </View>
    </>
  );
  if (!onSelect) return <View style={styles.session}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${locationFor(row)}, ${row.status}${date ? `, ${date}` : ""}`}
      onPress={() => onSelect(row.session)}
      style={({ pressed }) => [styles.session, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

function SessionList({
  rows,
  onSelect,
}: {
  rows: readonly HomeSession[];
  onSelect?: (session: HomeSessionInfo) => void;
}) {
  return (
    <View style={styles.sessionList}>
      {rows.map((row, index) => (
        <View
          key={JSON.stringify([row.session.hostId ?? "local", row.session.id])}
          style={index > 0 && styles.sessionDivider}
        >
          <SessionRow row={row} onSelect={onSelect} />
        </View>
      ))}
    </View>
  );
}

export function HomeScreen({
  active,
  recent,
  onSelectSession,
  onNewWorkspace,
  onNewEffort,
}: HomeScreenProps) {
  const newestFirst = (a: HomeSession, b: HomeSession) =>
    (Date.parse(b.session.modified) || 0) -
    (Date.parse(a.session.modified) || 0);
  const sortedActive = [...active].sort(
    (a, b) =>
      Number(b.status === "Awaiting input") -
        Number(a.status === "Awaiting input") || newestFirst(a, b),
  );
  const sortedRecent = [...recent].sort(newestFirst).slice(0, 5);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.inner}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.heading}>
            Home
          </Text>
          <View style={styles.actions}>
            <Action
              label="New workspace"
              icon="folder-plus"
              onPress={onNewWorkspace}
            />
            <Action label="New effort" icon="layers" onPress={onNewEffort} />
          </View>
        </View>
        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.sectionHeading}>
            Active agents
          </Text>
          {sortedActive.length > 0 ? (
            <SessionList rows={sortedActive} onSelect={onSelectSession} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No active agents</Text>
            </View>
          )}
        </View>
        {sortedRecent.length > 0 && (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.sectionHeading}>
              Recent chats
            </Text>
            <SessionList rows={sortedRecent} onSelect={onSelectSession} />
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  scrollContent: { flexGrow: 1 },
  inner: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    paddingTop: 22,
    paddingHorizontal: 16,
    paddingBottom: 36,
  },
  header: { gap: 16 },
  heading: {
    color: theme.text,
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 27,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  action: {
    minHeight: 36,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    backgroundColor: theme.panel,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  actionText: {
    color: theme.text,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  disabled: { opacity: 0.5 },
  pressed: { backgroundColor: theme.hover },
  section: { marginTop: 28 },
  sectionHeading: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 16,
    marginBottom: 10,
  },
  empty: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 18,
  },
  emptyText: { color: theme.muted, fontSize: 13, lineHeight: 16 },
  sessionList: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    overflow: "hidden",
  },
  sessionDivider: { borderTopWidth: 1, borderTopColor: theme.border },
  session: {
    minHeight: 64,
    backgroundColor: theme.panel,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
  sessionContent: { flex: 1, minWidth: 0, gap: 4 },
  sessionTitle: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 16,
  },
  sessionContext: { color: theme.muted, fontSize: 11, lineHeight: 14 },
  sessionMeta: { alignItems: "flex-end", gap: 4, flexShrink: 0 },
  sessionStatus: { color: theme.muted, fontSize: 11, lineHeight: 14 },
  awaiting: { color: theme.accent, fontWeight: "600" },
  sessionDate: { color: theme.muted, fontSize: 11, lineHeight: 14 },
});
