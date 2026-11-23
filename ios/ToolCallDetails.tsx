import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { parseUnifiedPatch } from "../lib/patch";
import {
  formatCost,
  formatDuration,
  formatTokens,
  shortModel,
} from "../lib/subagent-format";
import { isRecord } from "../lib/type-guards";
import { ChatMarkdown } from "./ChatMarkdown";
import { getNativeToolPresentation } from "./tool-presentation";
import type {
  ChatTranscriptProps,
  NativeTranscriptPalette,
} from "./ChatTranscript";

type Message = ChatTranscriptProps["messages"][number];
type ToolBlock = Extract<
  Extract<Message, { role: "assistant" }>["content"][number],
  { type: "toolCall" }
>;
type ToolResult = Extract<Message, { role: "toolResult" }>;

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function command(block: ToolBlock): string {
  const input = block.input;
  if (typeof input.command === "string") return input.command;
  if (block.toolName.toLowerCase() === "hub" && typeof input.op === "string") {
    const to =
      typeof input.to === "string"
        ? input.to
        : Array.isArray(input.to)
          ? input.to
              .filter((v): v is string => typeof v === "string")
              .join(", ")
          : "";
    return `hub ${input.op}${input.op === "send" && to ? ` → ${to}` : ""}`;
  }
  for (const key of ["path", "file_path", "query"] as const) {
    if (typeof input[key] === "string")
      return `${block.toolName} ${input[key]}`;
  }
  return `${block.toolName} ${json(input)}`;
}

function TaskSummary({
  details,
  colors,
}: {
  details: unknown;
  colors: NativeTranscriptPalette;
}) {
  if (!isRecord(details)) return null;
  const rows = (
    Array.isArray(details.results) && details.results.length
      ? details.results
      : Array.isArray(details.progress)
        ? details.progress
        : []
  ).filter(isRecord);
  const asyncInfo = isRecord(details.async) ? details.async : null;
  if (!rows.length && !asyncInfo) return null;
  const items = rows.length
    ? rows
    : asyncInfo && typeof asyncInfo.jobId === "string"
      ? [{ id: asyncInfo.jobId }]
      : [];
  return (
    <View style={[styles.summary, { borderColor: colors.border }]}>
      <Text style={[styles.summaryTitle, { color: colors.text }]}>
        Subagents · {items.length}
        {asyncInfo ? " ⤴" : ""}
      </Text>
      {items.map((row, index) => {
        const status =
          row.aborted === true || row.status === "aborted"
            ? "aborted"
            : row.error ||
                row.status === "failed" ||
                (typeof row.exitCode === "number" && row.exitCode !== 0)
              ? "failed"
              : row.status === "completed" || row.exitCode === 0
                ? "completed"
                : "started";
        const metrics = [
          formatTokens(typeof row.tokens === "number" ? row.tokens : undefined),
          formatCost(typeof row.cost === "number" ? row.cost : undefined),
          formatDuration(
            typeof row.durationMs === "number" ? row.durationMs : undefined,
          ),
          shortModel(
            typeof row.resolvedModel === "string"
              ? row.resolvedModel
              : undefined,
          ),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <Text
            key={typeof row.id === "string" ? row.id : index}
            style={[styles.summaryLine, { color: colors.muted }]}
          >
            <Text
              style={{ color: status === "failed" ? "#f19d99" : colors.accent }}
            >
              {typeof row.id === "string" ? row.id : "subagent"}
            </Text>
            {` · ${status}${typeof row.agent === "string" ? ` · ${row.agent}` : ""}${typeof row.task === "string" ? ` · ${row.task}` : typeof row.assignment === "string" ? ` · ${row.assignment}` : ""}${metrics ? ` · ${metrics}` : ""}`}
          </Text>
        );
      })}
    </View>
  );
}

function HubSummary({
  input,
  details,
  colors,
}: {
  input: ToolBlock["input"];
  details: unknown;
  colors: NativeTranscriptPalette;
}) {
  if (input.op === "send") {
    const recipients =
      typeof input.to === "string"
        ? input.to
        : Array.isArray(input.to)
          ? input.to
              .filter((v): v is string => typeof v === "string")
              .join(", ")
          : "";
    if (!recipients) return null;
    const receipts =
      isRecord(details) && Array.isArray(details.receipts)
        ? details.receipts.filter(isRecord)
        : [];
    return (
      <View style={[styles.summary, { borderColor: colors.border }]}>
        <Text
          style={[styles.summaryTitle, { color: colors.text }]}
        >{`IRC → ${recipients}${receipts.length ? ` · ${receipts.map((r) => (typeof r.outcome === "string" ? r.outcome : "sent")).join(" · ")}` : ""}`}</Text>
        {typeof input.message === "string" && (
          <ChatMarkdown text={input.message} palette={colors} />
        )}
      </View>
    );
  }
  if (input.op !== "jobs" || !isRecord(details) || !Array.isArray(details.jobs))
    return null;
  const jobs = details.jobs.filter(isRecord);
  return (
    <View style={[styles.summary, { borderColor: colors.border }]}>
      <Text
        style={[styles.summaryTitle, { color: colors.text }]}
      >{`Jobs · ${jobs.length}`}</Text>
      {jobs.map((job, i) => (
        <Text
          key={typeof job.id === "string" ? job.id : i}
          style={[styles.summaryLine, { color: colors.muted }]}
        >{`[${typeof job.type === "string" ? job.type : "job"}] ${typeof job.label === "string" ? job.label : typeof job.id === "string" ? job.id : ""} · ${typeof job.status === "string" ? job.status : "running"}`}</Text>
      ))}
    </View>
  );
}

function Diff({
  patch,
  colors,
  light,
}: {
  patch: string;
  colors: NativeTranscriptPalette;
  light: boolean;
}) {
  const files = parseUnifiedPatch(patch);
  if (!files)
    return (
      <Text selectable style={[styles.output, { color: colors.text }]}>
        {patch}
      </Text>
    );
  return (
    <ScrollView horizontal>
      <View>
        {files.map((file, index) => (
          <View key={index}>
            <Text style={[styles.summaryTitle, { color: colors.muted }]}>
              {file.newPath ?? file.oldPath ?? "Diff"}
            </Text>
            {file.rows.map((row, i) =>
              row.type === "hunk" ? (
                <Text key={i} style={[styles.output, { color: colors.muted }]}>
                  {row.text}
                </Text>
              ) : (
                <View key={i} style={styles.diffRow}>
                  {[row.left, row.right].map((cell, side) => (
                    <Text
                      selectable
                      key={side}
                      style={[
                        styles.diffCell,
                        { color: colors.text },
                        cell.type === "removed" && {
                          backgroundColor: light ? "#FBEDEC" : "#32191c",
                        },
                        cell.type === "added" && {
                          backgroundColor: light ? "#E4F4E8" : "#173327",
                        },
                      ]}
                    >{`${cell.lineNo ?? ""} ${cell.text}`}</Text>
                  ))}
                </View>
              ),
            )}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function ToolCallDetails({
  block,
  result,
  colors,
  light,
  images,
}: {
  block: ToolBlock;
  result?: ToolResult;
  colors: NativeTranscriptPalette;
  light: boolean;
  images?: ReactNode;
}) {
  const [inputOpen, setInputOpen] = useState(false);
  const details = isRecord(result?.details) ? result.details : null;
  const patch =
    !result?.isError && details
      ? typeof details.patch === "string"
        ? details.patch
        : typeof details.diff === "string"
          ? details.diff
          : null
      : null;
  const raw = result
    ? result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
    : "";
  const isRead = /^(?:read|file_read)$|(?:\.read|_read)$/i.test(block.toolName);
  const formatted = isRead
    ? raw
        .split("\n")
        .map((line) => line.replace(/^\s*\d+:\s?/, ""))
        .join("\n")
    : raw;
  const hubRecipients =
    typeof block.input.to === "string"
      ? block.input.to.trim()
      : Array.isArray(block.input.to)
        ? block.input.to
            .filter((item) => typeof item === "string" && item.trim())
            .join(", ")
        : "";
  const semanticHub =
    block.toolName.toLowerCase() === "hub" &&
    ((block.input.op === "send" && !!hubRecipients) ||
      (block.input.op === "jobs" &&
        details?.op === "jobs" &&
        Array.isArray(details.jobs) &&
        details.jobs.length > 0));
  const agentMessage =
    block.toolName.toLowerCase() === "write" &&
    typeof block.input.path === "string" &&
    /^agent:\/\//i.test(block.input.path) &&
    typeof block.input.content === "string";
  const deliveredAgentMessage =
    agentMessage &&
    !result?.partial &&
    !result?.isError &&
    /^Delivered to .+\.$/.test(raw.trim());
  const commandText = command(block).replace(/\s+/g, " ").trim();
  const commandPreview =
    commandText.length > 160 ? `${commandText.slice(0, 160)}…` : commandText;
  return (
    <View
      style={[
        styles.root,
        {
          borderColor: result?.isError
            ? light
              ? "#D99999"
              : "#71474a"
            : colors.border,
          backgroundColor: colors.panel,
        },
      ]}
    >
      <View style={styles.command}>
        <Text
          selectable
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.commandText, { color: colors.text }]}
        >
          <Text style={{ color: colors.accent }}>$ </Text>
          {commandPreview}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: inputOpen }}
          onPress={() => setInputOpen((open) => !open)}
        >
          <Text style={[styles.toggle, { color: colors.muted }]}>
            {inputOpen ? "Hide full input" : "Show full input"}
          </Text>
        </Pressable>
      </View>
      {inputOpen && (
        <View style={[styles.input, { borderColor: colors.border }]}>
          {Object.entries(block.input).map(([key, value]) => (
            <View key={key}>
              <Text style={[styles.inputKey, { color: colors.muted }]}>
                {key === "i" ? "intent" : key}
              </Text>
              <Text selectable style={[styles.output, { color: colors.text }]}>
                {typeof value === "string" ? value : json(value)}
              </Text>
            </View>
          ))}
        </View>
      )}
      {agentMessage && (
        <Text selectable style={[styles.output, { color: colors.text }]}>
          {String(block.input.content)}
        </Text>
      )}
      {block.toolName.toLowerCase() === "todo" && (
        <Text style={[styles.summaryLine, { color: colors.accent }]}>
          {getNativeToolPresentation(block, result).preview}
        </Text>
      )}
      {block.toolName.toLowerCase() === "task" && (
        <TaskSummary details={result?.details} colors={colors} />
      )}
      {block.toolName.toLowerCase() === "hub" && (
        <HubSummary
          input={block.input}
          details={result?.details}
          colors={colors}
        />
      )}
      {images}
      {result?.partial && !raw.trim() ? (
        <Text style={[styles.output, { color: colors.muted }]}>
          Running tool…
        </Text>
      ) : patch ? (
        <Diff patch={patch} colors={colors} light={light} />
      ) : result &&
        (!semanticHub || result.isError) &&
        !deliveredAgentMessage ? (
        <Text
          selectable
          style={[
            styles.output,
            {
              color: result.isError
                ? light
                  ? "#A12D35"
                  : "#f19d99"
                : colors.text,
            },
          ]}
        >
          {formatted.trim() || (!images ? "(no output)" : "")}
        </Text>
      ) : null}
      {!!result?.passiveContext && (
        <Text
          selectable
          style={[styles.context, { color: colors.muted }]}
        >{`↳ ${result.passiveContext}`}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginLeft: 20,
    marginVertical: 3,
    borderWidth: 1,
    borderRadius: 5,
    padding: 8,
    gap: 6,
  },
  command: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  commandText: { flex: 1, fontFamily: "Menlo", fontSize: 11, lineHeight: 16 },
  toggle: { fontSize: 10 },
  input: { borderTopWidth: 1, paddingTop: 6, gap: 5 },
  inputKey: { fontFamily: "Menlo", fontSize: 10 },
  output: { fontFamily: "Menlo", fontSize: 11, lineHeight: 16 },
  context: { fontSize: 10, lineHeight: 15 },
  summary: { borderTopWidth: 1, paddingTop: 6, gap: 4 },
  summaryTitle: { fontSize: 11, fontWeight: "600" },
  summaryLine: { fontFamily: "Menlo", fontSize: 10, lineHeight: 15 },
  diffRow: { flexDirection: "row" },
  diffCell: { width: 250, fontFamily: "Menlo", fontSize: 10, lineHeight: 15 },
});
