import { useMemo, type ReactNode } from "react";
import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  type TextStyle,
} from "react-native";
import { theme } from "./theme";
import type { NativeTranscriptPalette } from "./ChatTranscript";

const lightPalette: NativeTranscriptPalette = {
  background: "#FAF9F6",
  panel: "#F2F0EA",
  border: "#E2DDD2",
  text: "#2B2823",
  muted: "#69635A",
  accent: "#B03E22",
};

// Render the common Markdown constructs as native text so selection, dynamic
// type and VoiceOver remain available. URLs are opened by the OS, not a web view.
type InlineStyles = {
  link: TextStyle;
  inlineCode: TextStyle;
  bold: TextStyle;
  strike: TextStyle;
  italic: TextStyle;
};
function inline(
  source: string,
  styles: InlineStyles,
  keyPrefix = "inline",
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(!?\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|\\([\\`*_[\]{}()#+.!>-]))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match.index > last) nodes.push(source.slice(last, match.index));
    const key = `${keyPrefix}-${match.index}`;
    if (match[2] && match[3]) {
      const url = match[3];
      if (/^(https?:|mailto:)/i.test(url) && !match[0].startsWith("!")) {
        nodes.push(
          <Text
            key={key}
            style={styles.link}
            accessibilityRole="link"
            onPress={() => {
              void Linking.openURL(url).catch(() => {});
            }}
          >
            {match[2]}
          </Text>,
        );
      } else {
        nodes.push(match[2]);
      }
    } else if (match[4])
      nodes.push(
        <Text key={key} style={styles.inlineCode}>
          {match[4]}
        </Text>,
      );
    else if (match[5] || match[6])
      nodes.push(
        <Text key={key} style={styles.bold}>
          {inline(match[5] || match[6], styles, key)}
        </Text>,
      );
    else if (match[7])
      nodes.push(
        <Text key={key} style={styles.strike}>
          {inline(match[7], styles, key)}
        </Text>,
      );
    else if (match[8] || match[9])
      nodes.push(
        <Text key={key} style={styles.italic}>
          {inline(match[8] || match[9], styles, key)}
        </Text>,
      );
    else nodes.push(match[10] ?? match[0]);
    last = pattern.lastIndex;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

type Block = {
  kind: "paragraph" | "heading" | "quote" | "list" | "code" | "rule" | "table";
  text: string;
  level?: number;
  marker?: string;
  rows?: string[][];
};

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (line: string) =>
    /^\s*(`{3,}|~{3,}|#{1,6}\s|>\s?|(?:[-+*]|\d+[.)])\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(
      line,
    );
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const nextLine = lines[i + 1] ?? "";
    if (
      line.includes("|") &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)
    ) {
      const tableLines = [line];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|"))
        tableLines.push(lines[i++]);
      const rows = tableLines.map((value) =>
        value
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split(/(?<!\\)\|/)
          .map((cell) => cell.trim().replace(/\\\|/g, "|")),
      );
      blocks.push({ kind: "table", text: "", rows });
      continue;
    }
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (
        i < lines.length &&
        !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(
          lines[i],
        )
      )
        body.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({
        kind: "code",
        text: body.join("\n"),
        marker: fence[2].trim(),
      });
      continue;
    }
    if (/^\s*(?:=+|-+)\s*$/.test(nextLine)) {
      blocks.push({
        kind: "heading",
        text: line.trim(),
        level: nextLine.trim().startsWith("=") ? 1 : 2,
      });
      i += 2;
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        text: heading[2],
        level: heading[1].length,
      });
      i++;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "rule", text: "" });
      i++;
      continue;
    }
    const list = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
    if (list) {
      blocks.push({
        kind: "list",
        marker: /^\d/.test(list[2]) ? list[2] : "•",
        text: list[3],
        level: Math.floor(list[1].length / 2),
      });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]))
      paragraph.push(lines[i++]);
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

export function ChatMarkdown({
  text,
  style,
  palette,
}: {
  text: string;
  style?: TextStyle;
  palette?: NativeTranscriptPalette;
}) {
  const light = useColorScheme() === "light";
  const colors = palette ?? (light ? lightPalette : theme);
  const styles = useMemo(() => markdownStyles(colors, light), [colors, light]);
  const blocks = useMemo(() => parse(text), [text]);
  return (
    <View>
      {blocks.map((block, index) => {
        if (block.kind === "rule")
          return <View key={index} style={styles.rule} />;
        if (block.kind === "table")
          return (
            <ScrollView horizontal key={index} style={styles.table}>
              <View>
                {block.rows?.map((row, rowIndex) => (
                  <View key={rowIndex} style={styles.tableRow}>
                    {row.map((cell, cellIndex) => (
                      <Text
                        selectable
                        key={cellIndex}
                        style={[
                          styles.text,
                          styles.tableCell,
                          rowIndex === 0 && styles.bold,
                        ]}
                      >
                        {inline(cell, styles)}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          );
        if (block.kind === "code")
          return (
            <View key={index} style={styles.codeBox}>
              {!!block.marker && (
                <Text style={styles.codeLanguage}>{block.marker}</Text>
              )}
              <ScrollView horizontal>
                <Text selectable style={styles.code}>
                  {block.text}
                </Text>
              </ScrollView>
            </View>
          );
        if (block.kind === "list")
          return (
            <View
              key={index}
              style={[styles.list, { marginLeft: (block.level ?? 0) * 14 }]}
            >
              <Text style={[styles.text, style, styles.marker]}>
                {block.marker}
              </Text>
              <Text selectable style={[styles.text, style, styles.listText]}>
                {inline(block.text, styles)}
              </Text>
            </View>
          );
        return (
          <Text
            key={index}
            selectable
            style={[
              styles.text,
              style,
              block.kind === "heading" && styles.heading,
              block.kind === "heading" && {
                fontSize: Math.max(17, 24 - (block.level ?? 1) * 2),
              },
              block.kind === "quote" && styles.quote,
            ]}
          >
            {inline(block.text, styles)}
          </Text>
        );
      })}
    </View>
  );
}

const markdownStyles = (colors: NativeTranscriptPalette, light: boolean) =>
  StyleSheet.create({
    text: { color: colors.text, fontSize: 14, lineHeight: 21, marginBottom: 5 },
    bold: { fontWeight: "700" },
    italic: { fontStyle: "italic" },
    strike: { textDecorationLine: "line-through" },
    link: { color: colors.accent, textDecorationLine: "underline" },
    inlineCode: {
      fontFamily: "Menlo",
      fontSize: 12,
      backgroundColor: light ? "#E7E3DB" : "#202024",
    },
    heading: { fontWeight: "700", marginTop: 8 },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: colors.border,
      paddingLeft: 10,
      color: colors.muted,
    },
    list: { flexDirection: "row", alignItems: "flex-start" },
    marker: { width: 22 },
    listText: { flex: 1 },
    table: { marginVertical: 6 },
    tableRow: { flexDirection: "row" },
    tableCell: {
      width: 140,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 6,
      marginBottom: 0,
    },
    codeBox: {
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      marginVertical: 6,
      padding: 10,
    },
    codeLanguage: { color: colors.muted, fontSize: 11, marginBottom: 5 },
    code: {
      color: colors.text,
      fontFamily: "Menlo",
      fontSize: 12,
      lineHeight: 18,
    },
    rule: { height: 1, backgroundColor: colors.border, marginVertical: 12 },
  });
