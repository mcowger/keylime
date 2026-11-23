import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import type { operations } from "./generated/web-http";
import { theme } from "./theme";

export type WorkspaceSessionInfo =
  operations["listSessions"]["responses"][200]["content"]["application/json"]["sessions"][number];

// A tab may represent a new chat that has not yet created a session.
export type WorkspaceTab = {
  key: string;
  title: string;
  session?: WorkspaceSessionInfo;
};

export type WorkspaceTabsProps = {
  openTabs: readonly WorkspaceTab[];
  activeTabKey?: string;
  projectName?: string;
  workspaceName?: string;
  // The caller supplies only sessions belonging to this host and workspace.
  savedSessions: readonly WorkspaceSessionInfo[];
  savedState?: "loading" | "ready" | "unavailable";
  onSelectTab: (tab: WorkspaceTab) => void;
  onCloseTab: (tab: WorkspaceTab) => void;
  onSelectSaved: (session: WorkspaceSessionInfo) => void;
  onNewChat?: () => void;
};

const stopWords: Record<string, true> = {
  a: true,
  an: true,
  and: true,
  are: true,
  as: true,
  at: true,
  be: true,
  can: true,
  could: true,
  do: true,
  for: true,
  from: true,
  how: true,
  i: true,
  in: true,
  is: true,
  it: true,
  me: true,
  my: true,
  of: true,
  on: true,
  or: true,
  please: true,
  the: true,
  this: true,
  to: true,
  we: true,
  what: true,
  when: true,
  with: true,
  you: true,
};

function savedTitle(session: WorkspaceSessionInfo): string {
  if (session.name) return session.name;
  if (!session.messageCount || session.firstMessage === "(no messages)")
    return "Untitled chat";
  const words =
    session.firstMessage.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];
  const chosen: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    const key = word.toLocaleLowerCase("en");
    if (Object.hasOwn(stopWords, key) || seen.has(key)) continue;
    seen.add(key);
    chosen.push(Array.from(word).slice(0, 24).join(""));
    if (chosen.length === 4) break;
  }
  return chosen.join(" · ") || "Untitled chat";
}

export function WorkspaceTabs({
  openTabs,
  activeTabKey,
  projectName,
  workspaceName,
  savedSessions,
  savedState = "ready",
  onSelectTab,
  onCloseTab,
  onSelectSaved,
  onNewChat,
}: WorkspaceTabsProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const dark = useColorScheme() !== "light";
  const colors = dark
    ? {
        background: theme.background,
        panel: theme.panel,
        border: theme.border,
        text: theme.text,
        muted: theme.muted,
        accent: theme.accent,
        placeholder: "#85858C",
      }
    : {
        background: "#FAF9F6",
        panel: "#F2F0EA",
        border: "#D6CFC1",
        text: "#221A14",
        muted: "#625C57",
        accent: "#B03E22",
        placeholder: "#77716B",
      };
  const active = openTabs.find((tab) => tab.key === activeTabKey);
  const filtered = savedSessions.filter(
    (session) =>
      !openTabs.some(
        (tab) =>
          tab.session &&
          tab.session.id === session.id &&
          (tab.session.hostId ?? "local") === (session.hostId ?? "local"),
      ) &&
      `${session.name ?? ""} ${session.firstMessage}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );

  function dismiss() {
    setOpen(false);
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Workspace tabs, ${openTabs.length} open`}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
        style={[
          styles.trigger,
          { borderColor: colors.border, backgroundColor: colors.panel },
        ]}
      >
        <Text
          numberOfLines={1}
          style={[styles.triggerText, { color: colors.text }]}
        >
          {[active?.title || "Workspace", projectName, workspaceName]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        <Text style={[styles.triggerCount, { color: colors.text }]}>
          {` · ${openTabs.length} tabs`}
        </Text>
      </Pressable>
      <Modal
        transparent
        visible={open}
        animationType="fade"
        onRequestClose={dismiss}
      >
        <KeyboardAvoidingView
          style={styles.overlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={dismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss workspace tabs"
          />
          <View
            accessibilityViewIsModal
            style={[
              styles.sheet,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.sheetHeader}>
              <Text
                accessibilityRole="header"
                style={[styles.heading, { color: colors.text }]}
              >
                Workspace tabs
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close workspace tabs"
                onPress={dismiss}
                hitSlop={8}
                style={styles.close}
              >
                <Text style={[styles.closeText, { color: colors.text }]}>
                  ×
                </Text>
              </Pressable>
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.content}
            >
              {openTabs.map((tab) => {
                const isActive = tab.key === activeTabKey;
                return (
                  <View
                    key={tab.key}
                    style={[styles.row, { borderBottomColor: colors.border }]}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: isActive }}
                      onPress={() => {
                        dismiss();
                        onSelectTab(tab);
                      }}
                      style={styles.tabButton}
                    >
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.rowText,
                          { color: isActive ? colors.accent : colors.text },
                          isActive && styles.activeText,
                        ]}
                      >
                        {tab.title}
                        {isActive ? " · Active" : ""}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Close ${tab.title}`}
                      onPress={() => onCloseTab(tab)}
                      hitSlop={6}
                      style={styles.close}
                    >
                      <Text
                        style={[styles.rowCloseText, { color: colors.text }]}
                      >
                        ×
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
              {onNewChat && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    dismiss();
                    onNewChat();
                  }}
                  style={[
                    styles.newChat,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.panel,
                    },
                  ]}
                >
                  <Text style={[styles.rowText, { color: colors.text }]}>
                    New chat
                  </Text>
                </Pressable>
              )}
              <Text
                accessibilityRole="header"
                style={[styles.savedHeading, { color: colors.text }]}
              >
                Saved chats
              </Text>
              <TextInput
                accessibilityLabel="Search saved chats"
                value={query}
                onChangeText={setQuery}
                placeholder="Search saved chats"
                placeholderTextColor={colors.placeholder}
                autoCorrect={false}
                style={[
                  styles.search,
                  {
                    color: colors.text,
                    backgroundColor: colors.panel,
                    borderColor: colors.border,
                  },
                ]}
              />
              {savedState === "loading" ? (
                <Text style={[styles.empty, { color: colors.muted }]}>
                  Loading chats…
                </Text>
              ) : savedState === "unavailable" ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.empty, { color: colors.muted }]}
                >
                  Chats unavailable.
                </Text>
              ) : filtered.length === 0 ? (
                <Text style={[styles.empty, { color: colors.muted }]}>
                  No saved chats found.
                </Text>
              ) : (
                filtered.map((session) => (
                  <Pressable
                    key={`${session.hostId ?? "local"}:${session.id}`}
                    accessibilityRole="button"
                    onPress={() => {
                      dismiss();
                      onSelectSaved(session);
                    }}
                    style={[
                      styles.savedRow,
                      { borderBottomColor: colors.border },
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[styles.rowText, { color: colors.text }]}
                    >
                      {savedTitle(session)}
                    </Text>
                  </Pressable>
                ))
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    minHeight: 38,
    width: "100%",
    maxWidth: 220,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  triggerText: { fontSize: 14, flexShrink: 1 },
  triggerCount: { fontSize: 14, flexShrink: 0 },
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.76)",
  },
  sheet: {
    maxHeight: "85%",
    borderWidth: 1,
    borderBottomWidth: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 20,
    paddingHorizontal: 20,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  heading: { fontSize: 20, fontWeight: "600" },
  close: {
    width: 32,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  closeText: { fontSize: 25, lineHeight: 30, fontWeight: "300" },
  rowCloseText: { fontSize: 23, lineHeight: 27, fontWeight: "300" },
  content: { paddingBottom: 32 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    minHeight: 46,
  },
  tabButton: {
    flex: 1,
    minHeight: 46,
    justifyContent: "center",
    paddingLeft: 4,
  },
  rowText: { fontSize: 14 },
  activeText: { fontWeight: "600" },
  newChat: {
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  savedHeading: { fontSize: 14, marginTop: 26, marginBottom: 12 },
  search: {
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  empty: { fontSize: 14, marginTop: 10 },
  savedRow: {
    minHeight: 44,
    justifyContent: "center",
    borderBottomWidth: 1,
    paddingHorizontal: 4,
  },
});
