import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type { operations } from "./generated/web-http";
import { AuthenticatedMedia } from "./AuthenticatedMedia";
import { ChatMarkdown } from "./ChatMarkdown";
import { TranscriptIcon, type TranscriptIconName } from "./TranscriptIcons";
import { theme } from "./theme";
import type { SettingsPreferences } from "./SettingsScreen";

export type NativeTranscriptPalette = {
  background: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
};
const lightPalette: NativeTranscriptPalette = {
  background: "#FAF9F6",
  panel: "#F2F0EA",
  border: "#E2DDD2",
  text: "#2B2823",
  muted: "#69635A",
  accent: "#B03E22",
};
const PaletteContext = createContext<{
  palette: NativeTranscriptPalette;
  mediaHostId?: string;
  light: boolean;
}>({ palette: theme, light: false });

function useTranscriptStyles() {
  const { palette, light } = useContext(PaletteContext);
  return useMemo(() => transcriptStyles(palette, light), [palette, light]);
}
function TranscriptMarkdown({ text }: { text: string }) {
  const { palette } = useContext(PaletteContext);
  return <ChatMarkdown text={text} palette={palette} />;
}

export type TranscriptMessage =
  operations["getSession"]["responses"][200]["content"]["application/json"]["context"]["messages"][number];
type Assistant = Extract<TranscriptMessage, { role: "assistant" }>;
type Custom = Extract<TranscriptMessage, { role: "custom" }>;
type Block = Assistant["content"][number];
type ImageBlock = Extract<Block, { type: "image" }>;
type ToolBlock = Extract<Block, { type: "toolCall" }>;
type ToolResult = Extract<TranscriptMessage, { role: "toolResult" }>;
type MessageAction = (
  message: TranscriptMessage,
  entryId: string,
  index: number,
) => void;

export type ChatTranscriptProps = {
  messages: readonly TranscriptMessage[];
  /** Entry IDs parallel to messages; these keep paging anchors and actions stable. */
  entryIds: readonly string[];
  /** The owner reconciles this transient message with persisted history. */
  liveMessage?: Partial<TranscriptMessage> | null;
  toolResults?: Readonly<Record<string, ToolResult>>;
  historyHasMore?: boolean;
  loadingHistory?: boolean;
  onLoadOlder?: () => void | Promise<void>;
  onEdit?: MessageAction;
  onFork?: MessageAction;
  canFork?: (index: number) => boolean;
  onCopy?: (text: string) => void;
  onRead?: (text: string) => void;
  /** Web-server origin for relative image URLs, never a host filesystem path. */
  mediaOrigin?: string;
  /** Host that owns relative media in this session. */
  mediaHostId?: string;
  /** Change when selecting another host-qualified session. */
  sessionKey?: string;
  preferences?: SettingsPreferences;
  palette?: NativeTranscriptPalette;
};

type ItemRef = { message: TranscriptMessage; index: number; entryId: string };
type Piece = { ref: ItemRef; blocks?: Block[]; streaming?: boolean };
type Row =
  | {
      kind: "message";
      key: string;
      ref: ItemRef;
      blocks?: Block[];
      streaming?: boolean;
      last?: boolean;
    }
  | {
      kind: "activity";
      key: string;
      pieces: Piece[];
      toolCount: number;
      streaming?: boolean;
      unfolded?: boolean;
    };

function textOf(
  content: string | readonly { type: string; text?: string }[] | undefined,
): string {
  if (typeof content === "string") return content;
  return (
    content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n") ?? ""
  );
}

function makeRows(
  messages: readonly TranscriptMessage[],
  entryIds: readonly string[],
  liveMessage: Partial<TranscriptMessage> | null | undefined,
): { rows: Row[]; results: Map<string, ToolResult> } {
  const refs: ItemRef[] = messages.map((message, index) => ({
    message,
    index,
    entryId: entryIds[index] ?? `index-${index}`,
  }));
  if (liveMessage?.role === "assistant") {
    const live = liveMessage as Partial<Assistant>;
    refs.push({
      message: {
        role: "assistant",
        content: live.content ?? [],
        model: live.model ?? "",
        provider: live.provider ?? "",
        timestamp: live.timestamp,
        errorMessage: live.errorMessage,
      },
      index: messages.length,
      entryId: "live",
    });
  }
  const results = new Map<string, ToolResult>();
  for (const { message } of refs)
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  const rows: Row[] = [];
  let activity: Extract<Row, { kind: "activity" }> | undefined;
  const flush = () => {
    activity = undefined;
  };
  const addActivity = (piece: Piece, suffix: string) => {
    const streaming = piece.ref.entryId === "live";
    if (!activity || activity.streaming !== streaming) {
      activity = {
        kind: "activity",
        key: `activity-${piece.ref.entryId}-${suffix}`,
        pieces: [],
        toolCount: 0,
        streaming,
      };
      rows.push(activity);
    }
    activity.pieces.push(piece);
    if (activity.toolCount === 0) {
      const first = piece.blocks?.find((block) => block.type === "toolCall");
      if (first) activity.key = `activity-tool-${first.toolCallId}`;
    }
    activity.toolCount +=
      piece.blocks?.filter((block) => block.type === "toolCall").length ?? 0;
  };
  const addMessage = (
    ref: ItemRef,
    suffix: string,
    blocks?: Block[],
    last = true,
  ) => {
    flush();
    rows.push({
      kind: "message",
      key: `message-${ref.entryId}-${suffix}`,
      ref,
      blocks,
      last,
      streaming: ref.entryId === "live",
    });
  };
  const calls = new Set<string>();
  for (const ref of refs)
    if (ref.message.role === "assistant")
      for (const block of ref.message.content)
        if (block.type === "toolCall") calls.add(block.toolCallId);
  for (const ref of refs) {
    const msg = ref.message;
    if (msg.role === "toolResult") {
      // A page can begin after its corresponding call; don't hide that result.
      if (!calls.has(msg.toolCallId)) addActivity({ ref }, "result");
      continue;
    }
    if (msg.role === "user") {
      addMessage(ref, "user");
      continue;
    }
    if (
      msg.role === "custom" &&
      (msg.customType === "xdev-mount-notice" ||
        msg.customType === "passive-tool-context")
    )
      continue;
    if (
      msg.role === "custom" &&
      ((msg.customType === "advisor" && msg.display !== false) ||
        msg.customType === "compaction" ||
        msg.customType === "skill-prompt")
    ) {
      addMessage(ref, "custom");
      continue;
    }
    if (msg.role !== "assistant") {
      addActivity({ ref }, "other");
      continue;
    }
    let group: Block[] = [];
    let mode: "text" | "activity" | undefined;
    let start = 0;
    const flushBlocks = (last: boolean) => {
      if (!group.length || !mode) return;
      if (mode === "text") addMessage(ref, String(start), group, last);
      else
        addActivity(
          { ref, blocks: group, streaming: ref.entryId === "live" },
          String(start),
        );
      group = [];
      mode = undefined;
    };
    for (let index = 0; index < msg.content.length; index++) {
      const block = msg.content[index];
      if (block.type === "text" && !block.text.trim()) continue;
      if (
        block.type === "thinking" &&
        !block.thinking.trim() &&
        !block.deferred &&
        ref.entryId !== "live"
      )
        continue;
      const next =
        block.type === "text" || block.type === "image" ? "text" : "activity";
      if (mode && (mode !== next || next === "activity")) flushBlocks(false);
      if (!mode) {
        mode = next;
        start = index;
      }
      group.push(block);
    }
    const finalIsText = mode === "text";
    flushBlocks(true);
    if (msg.errorMessage?.trim() && !finalIsText)
      addMessage(ref, "error", [], true);
  }
  return { rows, results };
}

function inlineImageUri(image: ImageBlock): string | undefined {
  const value = image.url ?? image.source?.url;
  if (value)
    return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value) ? value : undefined;
  const data = image.data ?? image.source?.data;
  if (!data || data.startsWith("blob:")) return undefined;
  const mimeType = image.mimeType ?? image.source?.media_type ?? "image/png";
  return /^image\/[a-z0-9.+-]+$/i.test(mimeType)
    ? `data:${mimeType};base64,${data}`
    : undefined;
}
function Images({
  blocks,
  origin,
}: {
  blocks: readonly ImageBlock[];
  origin?: string;
}) {
  const styles = useTranscriptStyles();
  const { mediaHostId } = useContext(PaletteContext);
  return (
    <>
      {blocks.map((block, index) => {
        const value = block.url ?? block.source?.url;
        if (
          value &&
          /^\/api\/media\/[a-f0-9]{64}(?:\?[^#]*)?$/.test(value) &&
          origin
        ) {
          const [base, query] = value.split("?", 2);
          const params = new URLSearchParams(query ?? "");
          if (mediaHostId) params.set("hostId", mediaHostId);
          const path = `${base}${params.toString() ? `?${params}` : ""}`;
          return (
            <AuthenticatedMedia
              key={index}
              origin={origin}
              path={path}
              resizeMode="contain"
              style={styles.image}
              accessibilityLabel="Image attachment"
            />
          );
        }
        const uri = inlineImageUri(block);
        return uri ? (
          <Image
            key={index}
            source={{ uri }}
            resizeMode="contain"
            style={styles.image}
            accessibilityLabel="Image attachment"
          />
        ) : (
          <Text key={index} style={styles.dim}>
            Image unavailable
          </Text>
        );
      })}
    </>
  );
}
function timestamp(value?: number) {
  if (!value || !Number.isFinite(value)) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function Action({
  label,
  icon,
  symbol,
  onPress,
}: {
  label: string;
  icon?: TranscriptIconName;
  symbol?: string;
  onPress: () => void;
}) {
  const styles = useTranscriptStyles();
  const { palette } = useContext(PaletteContext);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.action}
    >
      {icon ? (
        <TranscriptIcon name={icon} color={palette.muted} />
      ) : (
        <Text style={styles.actionIcon}>{symbol}</Text>
      )}
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}
function MessageRow({
  row,
  onEdit,
  onFork,
  onCopy,
  onRead,
  mediaOrigin,
}: {
  row: Extract<Row, { kind: "message" }>;
  onEdit?: MessageAction;
  onFork?: MessageAction;
  onCopy?: (text: string) => void;
  onRead?: (text: string) => void;
  mediaOrigin?: string;
}) {
  const styles = useTranscriptStyles();
  const [showMarkdown, setShowMarkdown] = useState(false);
  const { ref, blocks, streaming, last } = row;
  const msg = ref.message;
  if (msg.role === "custom")
    return (
      <AdvisorOrSummary
        message={msg}
        onCopy={onCopy}
        mediaOrigin={mediaOrigin}
      />
    );
  if (msg.role !== "user" && msg.role !== "assistant") return null;
  const user = msg.role === "user";
  const content = user ? msg.content : (blocks ?? msg.content);
  const text = textOf(content);
  const images =
    typeof content === "string"
      ? []
      : content.filter((block): block is ImageBlock => block.type === "image");
  const showActions =
    !streaming &&
    (!!text ||
      !!images.length ||
      (msg.role === "assistant" &&
        last !== false &&
        !!msg.errorMessage &&
        !!onFork));
  const time = last !== false ? timestamp(msg.timestamp) : "";
  return (
    <View style={styles.message}>
      <View style={user ? styles.userAlign : undefined}>
        <View style={user ? styles.userBubble : undefined}>
          {!!text &&
            (user ? (
              <Text selectable style={styles.userText}>
                {text}
              </Text>
            ) : (
              <TranscriptMarkdown text={text} />
            ))}
          <Images blocks={images} origin={mediaOrigin} />
        </View>
      </View>
      {msg.role === "assistant" && last !== false && !!msg.errorMessage && (
        <View style={styles.error}>
          <Text style={styles.errorTitle}>Error</Text>
          <Text selectable style={styles.errorText}>
            {msg.errorMessage}
          </Text>
        </View>
      )}
      {showActions && (
        <View style={[styles.actions, user && styles.userActions]}>
          {!!text && onCopy && (
            <Action label="Copy" icon="copy" onPress={() => onCopy(text)} />
          )}
          {!!text && (
            <Action
              label="Markdown"
              icon="markdown"
              onPress={() => setShowMarkdown(true)}
            />
          )}
          {!!text && !user && onRead && (
            <Action label="Read" icon="read" onPress={() => onRead(text)} />
          )}
          {user && onEdit && !msg.branchSummary && (
            <Action
              label="Edit"
              icon="edit"
              onPress={() => onEdit(msg, ref.entryId, ref.index)}
            />
          )}
          {onFork && !(user && msg.branchSummary) && (
            <Action
              label="Fork"
              icon="fork"
              onPress={() => onFork(msg, ref.entryId, ref.index)}
            />
          )}
        </View>
      )}
      {!!time && <Text style={styles.time}>{time}</Text>}
      <Modal
        visible={showMarkdown}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowMarkdown(false)}
      >
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Markdown</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setShowMarkdown(false)}
            >
              <Text style={styles.modalDone}>Done</Text>
            </Pressable>
          </View>
          <ScrollView>
            <Text selectable style={styles.modalBody}>
              {text}
            </Text>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
function AdvisorOrSummary({
  message,
  onCopy,
  mediaOrigin,
}: {
  message: Custom;
  onCopy?: (text: string) => void;
  mediaOrigin?: string;
}) {
  const styles = useTranscriptStyles();
  const [jsonOpen, setJsonOpen] = useState(false);
  const details = message.details;
  const record = details && typeof details === "object" ? details : undefined;
  const notes =
    record && "notes" in record && Array.isArray(record.notes)
      ? record.notes.filter(
          (note): note is { note: string; severity?: string } =>
            !!note &&
            typeof note === "object" &&
            "note" in note &&
            typeof note.note === "string" &&
            (!("severity" in note) || typeof note.severity === "string"),
        )
      : [];
  const text = textOf(message.content);
  const isAdvisor = message.customType === "advisor";
  const skillPrompt =
    message.customType === "skill-prompt" &&
    record &&
    "prompt" in record &&
    typeof record.prompt === "string"
      ? record.prompt
      : undefined;
  return (
    <View style={isAdvisor ? styles.advisor : styles.summary}>
      <Text style={isAdvisor ? styles.advisorTitle : styles.summaryTitle}>
        {isAdvisor
          ? "Advisor"
          : message.customType === "compaction"
            ? "Compaction summary"
            : "Skill prompt"}
      </Text>
      {notes.length ? (
        notes.map((note, index) => (
          <View key={index}>
            {!!note.severity && (
              <Text style={styles.severity}>
                {note.severity[0]?.toUpperCase()}
                {note.severity.slice(1)}
              </Text>
            )}
            <TranscriptMarkdown text={note.note} />
          </View>
        ))
      ) : (
        <TranscriptMarkdown text={skillPrompt ?? text} />
      )}
      {typeof message.content !== "string" && (
        <Images
          blocks={message.content.filter(
            (block): block is ImageBlock => block.type === "image",
          )}
          origin={mediaOrigin}
        />
      )}
      {isAdvisor && (
        <View style={styles.actions}>
          {onCopy && (
            <Action
              label="Copy"
              icon="copy"
              onPress={() => onCopy(text || safeJson(details))}
            />
          )}
          {details !== undefined && (
            <Action
              label="JSON"
              symbol={jsonOpen ? "▾" : "▸"}
              onPress={() => setJsonOpen(!jsonOpen)}
            />
          )}
        </View>
      )}
      {jsonOpen && (
        <Text selectable style={styles.code}>
          {safeJson(details)}
        </Text>
      )}
    </View>
  );
}

function ActivityEntry({
  piece,
  results,
  mediaOrigin,
  preferences,
  latestThinking,
  toolOpen,
  onToolOpen,
}: {
  piece: Piece;
  results: Map<string, ToolResult>;
  mediaOrigin?: string;
  preferences?: SettingsPreferences;
  latestThinking?: Piece;
  toolOpen: ReadonlyMap<string, boolean>;
  onToolOpen: (id: string, open: boolean) => void;
}) {
  const styles = useTranscriptStyles();
  const { palette } = useContext(PaletteContext);
  const [override, setOverride] = useState<boolean>();
  const msg = piece.ref.message;
  const blocks = piece.blocks;
  const tool = blocks?.find(
    (block): block is ToolBlock => block.type === "toolCall",
  );
  const thinking = blocks
    ?.filter(
      (block): block is Extract<Block, { type: "thinking" }> =>
        block.type === "thinking",
    )
    .map(
      (block) =>
        block.thinking ||
        (block.deferred ? "Thinking content was deferred." : "Thinking…"),
    )
    .join("\n\n");
  const thinkingDefault =
    !!thinking &&
    (preferences?.expandThinkingBlocks === "all" ||
      (preferences?.expandThinkingBlocks === "latest" &&
        piece === latestThinking));
  const toolDefault =
    !!tool &&
    !(preferences?.keepToolCallsCollapsed ?? true) &&
    (piece.streaming ||
      !results.has(tool.toolCallId) ||
      !!results.get(tool.toolCallId)?.partial);
  const expanded =
    (tool ? toolOpen.get(tool.toolCallId) : override) ??
    (thinkingDefault || toolDefault);
  let title = "Activity";
  let body = "";
  if (tool) {
    const input = tool.input;
    const recipient =
      typeof input.to === "string"
        ? input.to
        : Array.isArray(input.to)
          ? input.to
              .filter((value): value is string => typeof value === "string")
              .join(", ")
          : "";
    if (tool.toolName === "hub" && input.op === "send" && recipient) {
      const value = results.get(tool.toolCallId);
      let outcome = "";
      if (
        value?.details &&
        typeof value.details === "object" &&
        "receipts" in value.details &&
        Array.isArray(value.details.receipts)
      ) {
        const receipt = value.details.receipts[0];
        if (
          receipt &&
          typeof receipt === "object" &&
          "outcome" in receipt &&
          typeof receipt.outcome === "string"
        )
          outcome = ` ${receipt.outcome}`;
      }
      title = `IRC → ${recipient}${outcome}`;
      body =
        typeof input.message === "string" ? input.message : safeJson(input);
    } else {
      title =
        tool.intent || (typeof input.i === "string" ? input.i : tool.toolName);
      body = typeof input.path === "string" ? input.path : safeJson(input);
    }
  } else if (thinking) {
    title = "Thinking";
    body = thinking;
  } else if (msg.role === "custom") {
    body = textOf(msg.content);
    const wrapper = body.match(
      /^\s*<(system-notice|system-reminder)([^>]*)>\s*([\s\S]*?)\s*<\/\1>\s*$/,
    );
    if (wrapper) {
      body = wrapper[3];
      const attributes = [...wrapper[2].matchAll(/([\w-]+)="([^"]+)"/g)].map(
        (match) => `${match[1]}=${match[2]}`,
      );
      title =
        msg.customType === "developer"
          ? [wrapper[1], ...attributes].join(" · ")
          : msg.customType;
    } else title = msg.customType;
    const irc = body.match(
      /^\s*<irc>\s*Incoming IRC message from agent `([^`]+)`:\s*([\s\S]*)$/,
    );
    if (irc) {
      title = `IRC ← ${irc[1]}`;
      body = irc[2];
    }
    if (msg.customType === "async-result" || msg.customType === "job-result") {
      title = body.split("\n")[0];
      body = body.split("\n").slice(1).join("\n");
    }
  } else if (msg.role === "developer") {
    title = "Developer";
    body = textOf(msg.content);
  } else if (msg.role === "bashExecution") {
    title = msg.command;
    body = msg.output;
  } else if (msg.role === "pythonExecution") {
    title = "Python";
    body = `${msg.code}\n${msg.output}`;
  } else if (msg.role === "toolResult") {
    title = msg.toolName ?? "Tool result";
    body = textOf(msg.content);
  } else if (msg.role === "fileMention") {
    title = "Files";
    body = msg.files.map((file) => file.path).join("\n");
  }
  return (
    <View>
      <Pressable
        onPress={() => {
          if (tool) onToolOpen(tool.toolCallId, !expanded);
          else setOverride(!expanded);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        style={styles.activityRow}
      >
        <Text style={styles.activityGlyph}>
          {tool ? "◇" : thinking ? "◌" : "◯"}
        </Text>
        <Text numberOfLines={1} style={styles.activityLine}>
          <Text style={styles.activityTitle}>{title}</Text>
          {body ? `  ${body.replace(/\s+/g, " ")}` : ""}
        </Text>
        <Text style={styles.activityArrow}>{expanded ? "⌄" : "›"}</Text>
      </Pressable>
      {expanded && (
        <View style={styles.activityBody}>
          {!blocks && !!body && <TranscriptMarkdown text={body} />}
          {blocks?.map((block, index) => {
            if (block.type === "thinking")
              return (
                <View key={index}>
                  <Text style={styles.dim}>Thinking</Text>
                  <TranscriptMarkdown
                    text={
                      block.thinking ||
                      (block.deferred
                        ? "Thinking content was deferred."
                        : "Thinking…")
                    }
                  />
                </View>
              );
            if (block.type !== "toolCall") return null;
            const value = results.get(block.toolCallId);
            return (
              <View key={block.toolCallId || index}>
                <Text style={styles.activityTitle}>
                  {block.intent || block.toolName}
                </Text>
                <Text selectable style={styles.code}>
                  {safeJson(block.input)}
                </Text>
                {value && (
                  <>
                    <Text
                      style={value.isError ? styles.errorTitle : styles.dim}
                    >
                      {value.partial
                        ? "Running"
                        : value.isError
                          ? "Error"
                          : "Result"}
                    </Text>
                    <TranscriptMarkdown text={textOf(value.content)} />
                    <Images
                      blocks={value.content.filter(
                        (item): item is ImageBlock => item.type === "image",
                      )}
                      origin={mediaOrigin}
                    />
                    {!!value.passiveContext && (
                      <Text style={styles.dim}>{value.passiveContext}</Text>
                    )}
                    {value.partial && (
                      <ActivityIndicator color={palette.accent} />
                    )}
                  </>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
function ProcessRow({
  row,
  results,
  mediaOrigin,
  preferences,
  latestThinking,
  groupOpen,
  onGroupOpen,
  toolOpen,
  onToolOpen,
}: {
  row: Extract<Row, { kind: "activity" }>;
  results: Map<string, ToolResult>;
  mediaOrigin?: string;
  preferences?: SettingsPreferences;
  latestThinking?: Piece;
  groupOpen: ReadonlyMap<string, boolean>;
  onGroupOpen: (ids: readonly string[], open: boolean) => void;
  toolOpen: ReadonlyMap<string, boolean>;
  onToolOpen: (id: string, open: boolean) => void;
}) {
  const styles = useTranscriptStyles();
  const { palette } = useContext(PaletteContext);
  const [override, setOverride] = useState<boolean>();
  const containsThinking = row.pieces.some(
    (piece) =>
      piece.blocks?.some((block) => block.type === "thinking") &&
      (preferences?.expandThinkingBlocks === "all" ||
        (preferences?.expandThinkingBlocks === "latest" &&
          piece === latestThinking)),
  );
  const automaticallyOpen =
    !!row.unfolded ||
    (!!row.streaming && preferences?.hideToolActivityWhileWorking === false) ||
    containsThinking;
  const ids = row.pieces.flatMap(
    (piece) =>
      piece.blocks?.flatMap((block) =>
        block.type === "toolCall" ? [block.toolCallId] : [],
      ) ?? [],
  );
  const explicit = ids.some((id) => groupOpen.get(id) === true)
    ? true
    : ids.some((id) => groupOpen.get(id) === false)
      ? false
      : override;
  const open = row.unfolded || (explicit ?? automaticallyOpen);
  const count = row.pieces.length;
  return (
    <View style={styles.process}>
      {!row.unfolded && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !!open }}
          onPress={() => {
            if (ids.length) onGroupOpen(ids, !open);
            else setOverride(!open);
          }}
          style={styles.processToggle}
        >
          <TranscriptIcon name="layers" color={palette.accent} />
          <TranscriptIcon
            name="chevron"
            color={palette.muted}
            expanded={!!open}
          />
          <Text style={styles.processLabel}>
            Process details · {count} {count === 1 ? "message" : "messages"}
            {row.toolCount
              ? ` · ${row.toolCount} tool ${row.toolCount === 1 ? "call" : "calls"}`
              : ""}
          </Text>
        </Pressable>
      )}
      {open &&
        row.pieces.map((piece, index) => (
          <ActivityEntry
            key={
              piece.blocks?.find((block) => block.type === "toolCall")
                ?.toolCallId ?? `${piece.ref.entryId}-${index}`
            }
            piece={piece}
            results={results}
            mediaOrigin={mediaOrigin}
            preferences={preferences}
            latestThinking={latestThinking}
            toolOpen={toolOpen}
            onToolOpen={onToolOpen}
          />
        ))}
    </View>
  );
}

export function ChatTranscript({
  toolResults,
  messages,
  entryIds,
  liveMessage,
  historyHasMore = false,
  loadingHistory = false,
  onLoadOlder,
  onEdit,
  onFork,
  canFork,
  onCopy,
  onRead,
  mediaOrigin,
  mediaHostId,
  sessionKey,
  preferences,
  palette,
}: ChatTranscriptProps) {
  const light = useColorScheme() === "light";
  const colors = palette ?? (light ? lightPalette : theme);
  const context = useMemo(
    () => ({ palette: colors, light, mediaHostId }),
    [colors, light, mediaHostId],
  );
  const styles = useMemo(
    () => transcriptStyles(colors, light),
    [colors, light],
  );
  const { rows, results: savedResults } = useMemo(
    () => makeRows(messages, entryIds, liveMessage),
    [messages, entryIds, liveMessage],
  );
  // Only call rows already present in the transcript consume transient results.
  const results = useMemo(() => {
    if (!toolResults || Object.keys(toolResults).length === 0)
      return savedResults;
    const combined = new Map(Object.entries(toolResults));
    for (const [id, saved] of savedResults) combined.set(id, saved);
    return combined;
  }, [savedResults, toolResults]);
  const displayRows = useMemo(() => {
    if (
      !preferences?.neverFoldToolActivity &&
      !preferences?.showToolCallsOutsideProcessDetails
    )
      return rows;
    return rows.flatMap((row): Row[] => {
      if (row.kind !== "activity") return [row];
      const groups: Extract<Row, { kind: "activity" }>[] = [];
      row.pieces.forEach((piece, index) => {
        const toolCount =
          piece.blocks?.filter((block) => block.type === "toolCall").length ??
          0;
        const unfolded =
          !!preferences?.neverFoldToolActivity ||
          (!!preferences?.showToolCallsOutsideProcessDetails && toolCount > 0);
        const previous = groups[groups.length - 1];
        if (!unfolded && previous && !previous.unfolded) {
          previous.pieces.push(piece);
          previous.toolCount += toolCount;
        } else
          groups.push({
            kind: "activity",
            key: `${row.key}-${index}`,
            pieces: [piece],
            toolCount,
            streaming: row.streaming,
            unfolded,
          });
      });
      return groups;
    });
  }, [
    rows,
    preferences?.neverFoldToolActivity,
    preferences?.showToolCallsOutsideProcessDetails,
  ]);
  const latestThinking = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind !== "activity") continue;
      for (let j = row.pieces.length - 1; j >= 0; j--)
        if (row.pieces[j].blocks?.some((block) => block.type === "thinking"))
          return row.pieces[j];
    }
    return undefined;
  }, [rows]);
  const list = useRef<FlatList<Row>>(null);
  const following = useRef(true);
  const interacted = useRef(false);
  const requested = useRef<string | undefined>(undefined);
  const positioned = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const [groupOpen, setGroupOpen] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [toolOpen, setToolOpen] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const lastSession = useRef(sessionKey);
  if (lastSession.current !== sessionKey) {
    lastSession.current = sessionKey;
    following.current = true;
    interacted.current = false;
    requested.current = undefined;
    positioned.current = false;
    setGroupOpen(new Map());
    setToolOpen(new Map());
  }
  const firstId = entryIds[0];
  const loadOlder = useCallback(
    (force = false) => {
      if (
        !historyHasMore ||
        loadingHistory ||
        !onLoadOlder ||
        !firstId ||
        (!force && requested.current === firstId)
      )
        return;
      requested.current = firstId;
      try {
        const pending = onLoadOlder();
        if (pending && typeof pending.then === "function")
          void pending.catch(() => {
            requested.current = undefined;
          });
      } catch {
        requested.current = undefined;
      }
    },
    [firstId, historyHasMore, loadingHistory, onLoadOlder],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;
      if (!positioned.current) return;
      const atBottom =
        contentSize.height - layoutMeasurement.height - contentOffset.y < 48;
      following.current = atBottom;
      setShowLatest(!atBottom);
      if (interacted.current && contentOffset.y < 40 && !atBottom) loadOlder();
    },
    [loadOlder],
  );
  return (
    <PaletteContext.Provider value={context}>
      <View style={styles.container}>
        <FlatList
          key={sessionKey}
          ref={list}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={displayRows}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) =>
            item.kind === "message" ? (
              <MessageRow
                row={item}
                onEdit={
                  item.ref.entryId.startsWith("live-user:") ? undefined : onEdit
                }
                onFork={
                  canFork && !canFork(item.ref.index) ? undefined : onFork
                }
                onCopy={onCopy}
                onRead={onRead}
                mediaOrigin={mediaOrigin}
              />
            ) : (
              <ProcessRow
                row={item}
                results={results}
                mediaOrigin={mediaOrigin}
                preferences={preferences}
                latestThinking={latestThinking}
                groupOpen={groupOpen}
                onGroupOpen={(ids, open) =>
                  setGroupOpen((previous) => {
                    const next = new Map(previous);
                    for (const id of ids) next.set(id, open);
                    return next;
                  })
                }
                toolOpen={toolOpen}
                onToolOpen={(id, open) =>
                  setToolOpen((previous) => new Map(previous).set(id, open))
                }
              />
            )
          }
          ListHeaderComponent={
            historyHasMore ? (
              <Pressable
                accessibilityRole="button"
                disabled={loadingHistory || !onLoadOlder}
                onPress={() => loadOlder(true)}
                style={styles.loadOlder}
              >
                {loadingHistory ? (
                  <ActivityIndicator color={colors.muted} />
                ) : (
                  <Text style={styles.dim}>Load older messages</Text>
                )}
              </Pressable>
            ) : undefined
          }
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onScrollBeginDrag={() => {
            interacted.current = true;
          }}
          onScroll={onScroll}
          scrollEventThrottle={16}
          onContentSizeChange={() => {
            if (!positioned.current || following.current) {
              positioned.current = true;
              requestAnimationFrame(() => {
                if (following.current)
                  list.current?.scrollToEnd({ animated: false });
              });
            }
          }}
          keyboardShouldPersistTaps="handled"
        />
        {showLatest && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jump to latest message"
            onPress={() => {
              following.current = true;
              setShowLatest(false);
              list.current?.scrollToEnd({ animated: true });
            }}
            style={styles.jump}
          >
            <Text style={styles.jumpText}>⌄</Text>
          </Pressable>
        )}
      </View>
    </PaletteContext.Provider>
  );
}

const transcriptStyles = (colors: NativeTranscriptPalette, light: boolean) =>
  StyleSheet.create({
    container: { flex: 1 },
    jump: {
      position: "absolute",
      alignSelf: "center",
      bottom: 2,
      paddingHorizontal: 14,
      paddingVertical: 4,
      borderRadius: 16,
      backgroundColor: colors.panel,
    },
    jumpText: { color: colors.muted, fontSize: 17 },
    list: { flex: 1, backgroundColor: colors.background },
    listContent: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 12 },
    message: { marginBottom: 18 },
    userAlign: { alignItems: "flex-end" },
    userBubble: {
      backgroundColor: light ? "#EFE8DF" : "#171318",
      borderLeftColor: colors.accent,
      borderLeftWidth: 3,
      borderRadius: 11,
      paddingHorizontal: 13,
      paddingVertical: 11,
      maxWidth: "90%",
    },
    userText: { color: colors.text, fontSize: 14, lineHeight: 19 },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 14,
      marginTop: 7,
    },
    userActions: { justifyContent: "flex-end" },
    action: {
      paddingVertical: 2,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    actionText: { color: colors.muted, fontSize: 11 },
    actionIcon: { color: colors.muted, fontSize: 14 },
    time: {
      color: colors.muted,
      fontSize: 10,
      alignSelf: "flex-end",
      marginTop: 13,
    },
    image: { width: 220, height: 160, maxWidth: "100%", marginVertical: 5 },
    advisor: {
      borderWidth: 1,
      borderColor: colors.border,
      borderLeftColor: light ? "#777800" : "#adae00",
      borderLeftWidth: 3,
      borderRadius: 11,
      padding: 14,
      marginBottom: 10,
      backgroundColor: colors.panel,
    },
    advisorTitle: {
      color: light ? "#696900" : "#b1b200",
      fontSize: 11,
      fontWeight: "600",
      marginBottom: 8,
    },
    severity: {
      color: light ? "#795600" : "#f2c66e",
      fontSize: 11,
      fontWeight: "600",
      marginBottom: 6,
    },
    summary: {
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
      marginBottom: 10,
    },
    summaryTitle: {
      color: colors.muted,
      fontSize: 11,
      fontWeight: "600",
      marginBottom: 6,
    },
    process: { marginBottom: 8 },
    processToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      paddingVertical: 4,
    },
    processLabel: {
      color: colors.muted,
      fontSize: 12,
      fontWeight: "500",
      flexShrink: 1,
    },
    activityRow: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: 28,
      gap: 8,
    },
    activityGlyph: {
      color: light ? "#26777D" : "#86d9e1",
      fontSize: 15,
      width: 13,
    },
    activityLine: {
      flex: 1,
      color: colors.muted,
      fontFamily: "Menlo",
      fontSize: 11,
    },
    activityTitle: {
      color: colors.accent,
      fontFamily: "Menlo",
      fontSize: 11,
      fontWeight: "600",
    },
    activityArrow: { color: colors.muted, fontSize: 18 },
    activityBody: {
      marginLeft: 20,
      padding: 8,
      borderLeftColor: colors.border,
      borderLeftWidth: 1,
    },
    code: {
      color: colors.muted,
      fontFamily: "Menlo",
      fontSize: 11,
      lineHeight: 17,
      marginVertical: 5,
    },
    dim: { color: colors.muted, fontSize: 11 },
    error: {
      borderWidth: 1,
      borderColor: light ? "#D99999" : "#71474a",
      backgroundColor: light ? "#FBEDEC" : "#1a0f10",
      borderRadius: 8,
      padding: 10,
      marginVertical: 6,
    },
    errorTitle: {
      color: light ? "#A12D35" : "#f19d99",
      fontSize: 12,
      fontWeight: "600",
    },
    errorText: {
      color: light ? "#A12D35" : "#f19d99",
      fontSize: 12,
      lineHeight: 18,
    },
    loadOlder: { padding: 10, alignItems: "center" },
    modal: { flex: 1, backgroundColor: colors.background, padding: 16 },
    modalHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingBottom: 16,
    },
    modalTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
    modalDone: { color: colors.accent, fontSize: 16 },
    modalBody: {
      color: colors.text,
      fontFamily: "Menlo",
      fontSize: 13,
      lineHeight: 20,
    },
  });
