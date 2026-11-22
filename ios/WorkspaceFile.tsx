import { useEffect, useState } from "react";
import {
  DynamicColorIOS,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { operations } from "./generated/web-http";
import type { BrowserLink } from "./browser-link";
import { requestJson } from "./keylime-http";
import { ChatMarkdown } from "./ChatMarkdown";
import { theme as darkTheme } from "./theme";

type FileResponse =
  operations["workspaceFilesGet"]["responses"][200]["content"]["application/json"];
type TextFile = Extract<FileResponse, { content: string }>;
const theme = {
  background: DynamicColorIOS({ dark: darkTheme.background, light: "#FAF9F6" }),
  panel: DynamicColorIOS({ dark: darkTheme.panel, light: "#F2F0EA" }),
  border: DynamicColorIOS({ dark: darkTheme.border, light: "#D6CFC1" }),
  text: DynamicColorIOS({ dark: darkTheme.text, light: "#221A14" }),
  muted: DynamicColorIOS({ dark: darkTheme.muted, light: "#625C57" }),
};

export function workspaceFileUrl(
  path: string,
  type: "list" | "read",
  hostId: string,
  sessionId?: string | null,
  root?: string,
): string {
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const query = new URLSearchParams({ type, hostId });
  if (sessionId) query.set("sessionId", sessionId);
  if (root !== undefined) query.set("root", root);
  return `/api/files/${encoded}?${query.toString()}`;
}

export function WorkspaceFile({
  origin,
  hostId,
  sessionId,
  path,
  link,
}: {
  origin: string;
  hostId: string;
  sessionId?: string | null;
  path: string;
  link?: BrowserLink | null;
}) {
  const [data, setData] = useState<TextFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const name = path.replace(/\/+$/, "").split("/").pop() || path;
  const markdown = /\.(md|markdown|mdown|mkd)$/i.test(name);

  useEffect(() => {
    let current = true;
    let requestId = 0;
    setData(null);
    setError(null);
    setPreview(false);
    const load = () => {
      if (!current) return;
      const id = ++requestId;
      requestJson<FileResponse>(
        origin,
        workspaceFileUrl(path, "read", hostId, sessionId),
      )
        .then((response) => {
          if (!current || id !== requestId) return;
          if ("content" in response && typeof response.content === "string") {
            setData(response);
            setError(null);
          } else setError("This file cannot be displayed as text.");
        })
        .catch((reason: unknown) => {
          if (current && id === requestId)
            setError(
              reason instanceof Error ? reason.message : "Could not load file",
            );
        });
    };
    load();
    const unsubscribe = link?.subscribe(
      { kind: "file", path, hostId, sessionId: sessionId ?? null },
      {
        onEvent: (event) => {
          if (
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "change"
          )
            load();
        },
        // A fresh subscription follows a failed resume and may have missed changes.
        onOpen: load,
      },
    );
    return () => {
      current = false;
      requestId++;
      unsubscribe?.();
    };
  }, [origin, hostId, sessionId, path, link]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.filename} numberOfLines={1}>
          {name}
        </Text>
        {markdown && (
          <View style={styles.segment}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: !preview }}
              onPress={() => setPreview(false)}
              style={[styles.segmentButton, !preview && styles.selected]}
            >
              <Text style={styles.segmentText}>Source</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: preview }}
              onPress={() => setPreview(true)}
              style={[styles.segmentButton, preview && styles.selected]}
            >
              <Text style={styles.segmentText}>Preview</Text>
            </Pressable>
          </View>
        )}
      </View>
      {error ? (
        <Text style={styles.message}>{error}</Text>
      ) : !data ? (
        <Text style={styles.message}>Loading file…</Text>
      ) : preview && markdown ? (
        <ScrollView contentContainerStyle={styles.preview}>
          <ChatMarkdown text={data.content} style={styles.previewText} />
        </ScrollView>
      ) : (
        <ScrollView>
          <ScrollView horizontal>
            <View style={styles.source}>
              {data.content.split("\n").map((line, index) => (
                <View key={index} style={styles.line}>
                  <Text style={styles.lineNumber}>{index + 1}</Text>
                  <Text selectable style={styles.code}>
                    {line || " "}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  header: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 13,
    borderBottomWidth: 1,
    borderColor: theme.border,
    gap: 8,
  },
  filename: { color: theme.text, fontSize: 12, fontWeight: "600", flex: 1 },
  segment: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    overflow: "hidden",
  },
  segmentButton: { paddingVertical: 5, paddingHorizontal: 9 },
  selected: {
    backgroundColor: DynamicColorIOS({ dark: "#1d1d23", light: "#E7E3DB" }),
  },
  segmentText: { color: theme.text, fontSize: 12 },
  message: { color: theme.muted, padding: 16, fontSize: 13 },
  preview: { paddingHorizontal: 33, paddingTop: 35 },
  previewText: { fontSize: 14, lineHeight: 22 },
  source: { minWidth: "100%" },
  line: { flexDirection: "row", minHeight: 21 },
  lineNumber: {
    width: 48,
    paddingRight: 10,
    textAlign: "right",
    color: DynamicColorIOS({ dark: "#88888e", light: "#6A6458" }),
    backgroundColor: theme.panel,
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 21,
    borderRightWidth: 1,
    borderColor: theme.border,
  },
  code: {
    color: theme.text,
    fontFamily: "Menlo",
    fontSize: 13,
    lineHeight: 21,
    paddingLeft: 2,
  },
});
