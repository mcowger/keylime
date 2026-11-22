import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import type { SidebarEffort } from "./Sidebar";
import { theme } from "./theme";

export type EffortDetailsProps = {
  effort: SidebarEffort;
  onStartMemberChat: (member: SidebarEffort["members"][number]) => void;
  unavailable?: boolean;
};

const statusLabels: Record<SidebarEffort["status"], string> = {
  creating: "Creating",
  failed: "Setup failed",
  ready: "Ready",
  cleaning: "Cleaning up",
  cleanup_failed: "Cleanup failed",
  cleaned: "Cleaned up",
};

export function EffortDetails({
  effort,
  onStartMemberChat,
  unavailable = false,
}: EffortDetailsProps) {
  const [open, setOpen] = useState(false);
  const light = useColorScheme() === "light";
  const colors = light
    ? {
        background: "#FAF9F6",
        input: "#F2F0EA",
        border: "#D6CFC1",
        text: "#221A14",
        muted: "#625C57",
      }
    : {
        background: theme.background,
        input: "#0A0A0C",
        border: theme.border,
        text: theme.text,
        muted: theme.muted,
      };
  return (
    <>
      <View
        style={[
          styles.header,
          { backgroundColor: colors.background, borderColor: colors.border },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${effort.name}, Effort details`}
          onPress={() => setOpen(true)}
          style={[
            styles.button,
            { backgroundColor: colors.input, borderColor: colors.border },
          ]}
        >
          <Text
            style={[styles.buttonText, { color: colors.text }]}
            numberOfLines={1}
          >
            {effort.name} · Effort details
          </Text>
        </Pressable>
      </View>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.backdrop}>
          <View
            accessibilityViewIsModal
            style={[
              styles.dialog,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
          >
            <ScrollView contentContainerStyle={styles.body}>
              <Text
                accessibilityRole="header"
                style={[styles.title, { color: colors.text }]}
              >
                {effort.name}
              </Text>
              {unavailable && (
                <Text
                  accessibilityRole="alert"
                  style={[styles.text, styles.error]}
                >
                  Host unavailable
                </Text>
              )}
              <View style={styles.group}>
                <Text style={[styles.text, { color: colors.text }]}>
                  <Text style={styles.strong}>{effort.systemName}</Text> ·{" "}
                  {statusLabels[effort.status]}
                </Text>
                <Text selectable style={[styles.path, { color: colors.text }]}>
                  {effort.root}
                </Text>
                <Text selectable style={[styles.path, { color: colors.text }]}>
                  {effort.branch}
                </Text>
                {effort.error ? (
                  <Text
                    accessibilityRole="alert"
                    style={[styles.text, styles.error]}
                  >
                    {effort.error}
                  </Text>
                ) : null}
              </View>
              {!!effort.retainedPaths?.length && (
                <View style={[styles.card, { borderColor: colors.border }]}>
                  <Text
                    style={[styles.text, styles.strong, { color: colors.text }]}
                  >
                    Files left at the Effort root
                  </Text>
                  {effort.retainedPaths.map((path) => (
                    <Text
                      key={path}
                      selectable
                      style={[styles.path, { color: colors.text }]}
                    >
                      {path}
                    </Text>
                  ))}
                </View>
              )}
              <View style={[styles.card, { borderColor: colors.border }]}>
                <Text
                  accessibilityRole="header"
                  style={[styles.text, styles.strong, { color: colors.text }]}
                >
                  Member worktrees
                </Text>
                {effort.members.map((member) => {
                  const canOpen =
                    !unavailable &&
                    effort.status === "ready" &&
                    member.status === "complete";
                  return (
                    <View key={member.repoPath} style={styles.group}>
                      <View style={styles.row}>
                        <Text
                          style={[
                            styles.text,
                            styles.strong,
                            { color: colors.text },
                          ]}
                        >
                          {member.name}
                        </Text>
                        <Text style={[styles.text, { color: colors.muted }]}>
                          {member.status}
                          {member.stage ? ` · ${member.stage}` : ""}
                        </Text>
                        {canOpen && (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Open ${member.name}`}
                            onPress={() => {
                              setOpen(false);
                              onStartMemberChat(member);
                            }}
                            style={[
                              styles.button,
                              {
                                backgroundColor: colors.input,
                                borderColor: colors.border,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.buttonText,
                                { color: colors.text },
                              ]}
                            >
                              Open {member.name}
                            </Text>
                          </Pressable>
                        )}
                      </View>
                      <Text
                        selectable
                        style={[styles.path, { color: colors.text }]}
                      >
                        {member.path}
                      </Text>
                      {member.error ? (
                        <Text
                          accessibilityRole="alert"
                          style={[styles.text, styles.error]}
                        >
                          {member.error}
                        </Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>
              {effort.services.length > 0 && (
                <View style={[styles.card, { borderColor: colors.border }]}>
                  <Text
                    accessibilityRole="header"
                    style={[styles.text, styles.strong, { color: colors.text }]}
                  >
                    Services
                  </Text>
                  <Text style={[styles.text, { color: colors.muted }]}>
                    Running means the process is still active. It doesn't check
                    readiness.
                  </Text>
                  {effort.services.map((service) => (
                    <View key={service.id} style={styles.group}>
                      <Text style={[styles.text, { color: colors.text }]}>
                        <Text style={styles.strong}>{service.name}</Text> ·{" "}
                        {service.status}
                      </Text>
                      {service.error ? (
                        <Text
                          accessibilityRole="alert"
                          style={[styles.text, styles.error]}
                        >
                          {service.error}
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              )}
              <View style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setOpen(false)}
                  style={[
                    styles.button,
                    {
                      backgroundColor: colors.input,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.buttonText, { color: colors.text }]}>
                    Close
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 36,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
    alignItems: "flex-start",
  },
  button: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 5,
    minHeight: 28,
    justifyContent: "center",
  },
  buttonText: { fontSize: 12 },
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 16,
    backgroundColor: "rgba(0,0,0,0.75)",
  },
  dialog: {
    maxHeight: "94%",
    borderWidth: 1,
    borderRadius: 16,
    overflow: "hidden",
  },
  body: { padding: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: "700", marginBottom: 4 },
  text: { fontSize: 14, lineHeight: 21 },
  strong: { fontWeight: "700" },
  path: { fontSize: 13, lineHeight: 20, fontFamily: "Menlo" },
  card: { borderWidth: 1, borderRadius: 8, padding: 10, gap: 10 },
  group: { gap: 6 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  error: { color: "#E67070" },
});
