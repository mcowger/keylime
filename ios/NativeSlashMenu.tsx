import {
  type ComponentRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import {
  buildSlashInsertText,
  extractSlashQuery,
} from "../lib/slash-autocomplete";
import { WEB_SLASH_COMMANDS } from "../lib/web-slash-commands";
import type { BrowserLink } from "./browser-link";
import type { components } from "./generated/browser-link";
import { theme } from "./theme";

type CommandReply = components["schemas"]["BrowserReply_get_commands"];
type CommandData = Extract<CommandReply["data"], { success: true }>["data"];
export type NativeSlashCommand = Pick<
  CommandData["commands"][number],
  "name" | "source" | "description" | "input"
>;
export type NativeTextSelection = { start: number; end: number };

// The native composer does not implement the web client's command dispatcher.
// Do not advertise those commands, even if an extension has the same name.
const clientCommands = new Set([
  ...WEB_SLASH_COMMANDS.map((command) => command.name),
  "btw",
  "compact",
  "reload",
  "name",
  "session",
  "copy",
]);

const sourceLabels: Record<NativeSlashCommand["source"], string> = {
  builtin: "Built-in",
  extension: "Extensions",
  custom: "Commands",
  mcp_prompt: "MCP prompts",
  file: "Files",
  skill: "Skills",
};
const sourceOrder: Record<NativeSlashCommand["source"], number> = {
  builtin: 0,
  extension: 1,
  custom: 2,
  mcp_prompt: 3,
  file: 4,
  skill: 5,
};

function commandData(
  value: unknown,
): value is { commands: NativeSlashCommand[] } {
  if (!value || typeof value !== "object" || !("commands" in value))
    return false;
  const commands = value.commands;
  return (
    Array.isArray(commands) &&
    commands.every((command: unknown) => {
      if (!command || typeof command !== "object") return false;
      const item = command as Record<string, unknown>;
      return (
        typeof item.name === "string" &&
        typeof item.source === "string" &&
        [
          "builtin",
          "skill",
          "extension",
          "custom",
          "mcp_prompt",
          "file",
        ].includes(item.source) &&
        (item.description === undefined ||
          typeof item.description === "string") &&
        (item.input === undefined ||
          (typeof item.input === "object" &&
            item.input !== null &&
            (!("hint" in item.input) || typeof item.input.hint === "string")))
      );
    })
  );
}

function usableCommands(data: {
  commands: NativeSlashCommand[];
}): NativeSlashCommand[] {
  const names = new Set<string>();
  return data.commands.filter((command) => {
    const name = command.name.toLowerCase();
    if (
      !/^[^\s/]+$/.test(command.name) ||
      clientCommands.has(name) ||
      names.has(name)
    )
      return false;
    // OMP's builtin registry also contains TUI-only commands. Without an ACP
    // capability flag they cannot safely be offered as RPC prompt commands.
    if (
      !["extension", "skill", "custom", "mcp_prompt", "file"].includes(
        command.source,
      )
    )
      return false;
    names.add(name);
    return true;
  });
}

export type NativeSlashMenuOptions = {
  link: BrowserLink;
  hostId: string;
  sessionId: string | null;
  ready: boolean;
  running: boolean;
  draft: string;
  selection: NativeTextSelection;
  onReplaceDraft: (draft: string, selection: NativeTextSelection) => void;
};

export type NativeSlashMenuModel = {
  open: boolean;
  items: NativeSlashCommand[];
  index: number;
  loading: boolean;
  shouldPreserveDraft: boolean;
  select: (command: NativeSlashCommand) => void;
  blockedReason:
    "client-command" | "commands-unavailable" | "session-running" | null;
  dismiss: () => void;
  handleKey: (key: string) => boolean;
};

type Loaded = { key: string; commands: NativeSlashCommand[] };
/** The caller owns the TextInput and routes its hardware key and submit events here. */
export function useNativeSlashMenu({
  link,
  hostId,
  sessionId,
  ready,
  running,
  draft,
  selection,
  onReplaceDraft,
}: NativeSlashMenuOptions): NativeSlashMenuModel {
  const start = Math.max(0, Math.min(selection.start, draft.length));
  const end = Math.max(start, Math.min(selection.end, draft.length));
  const match = extractSlashQuery(draft.slice(0, start));
  const token = match ? `${draft}\u0000${start}\u0000${end}` : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const key = sessionId ? JSON.stringify([hostId, sessionId]) : null;
  const open = !!match && token !== dismissed && !running;

  useEffect(() => {
    setActiveIndex(0);
  }, [token]);

  useEffect(() => {
    if (!open || !ready || !sessionId || !key) return;
    let current = true;
    setLoadingKey(key);
    setLoaded(null);
    void link.command(sessionId, hostId, { type: "get_commands" }).then(
      (reply) => {
        if (!current) return;
        const data: unknown =
          "success" in reply.data && reply.data.success
            ? reply.data.data
            : null;
        setLoaded({
          key,
          commands: commandData(data) ? usableCommands(data) : [],
        });
        setLoadingKey(null);
      },
      () => {
        if (!current) return;
        setLoaded({ key, commands: [] });
        setLoadingKey(null);
      },
    );
    return () => {
      current = false;
    };
  }, [open, ready, sessionId, key, hostId, link]);

  const available = open && ready && loaded?.key === key ? loaded.commands : [];
  const items = useMemo(() => {
    if (!match) return [];
    const query = match.query;
    const rank = (command: NativeSlashCommand) => {
      const name = (
        match.mode === "mid-prompt"
          ? command.name.replace(/^skill:/i, "")
          : command.name
      ).toLowerCase();
      if (name === query) return 0;
      if (name.startsWith(query)) return 1;
      if (name.includes(query)) return 2;
      return 3;
    };
    return available
      .filter((command) => {
        if (
          match.mode === "mid-prompt" &&
          command.source !== "skill" &&
          !command.name.startsWith("skill:")
        )
          return false;
        return (
          command.name.toLowerCase().includes(query) ||
          (match.mode === "mid-prompt" &&
            command.name
              .replace(/^skill:/i, "")
              .toLowerCase()
              .includes(query)) ||
          (command.description?.toLowerCase().includes(query) ?? false)
        );
      })
      .sort(
        (a, b) =>
          sourceOrder[a.source] - sourceOrder[b.source] ||
          rank(a) - rank(b) ||
          a.name.localeCompare(b.name),
      );
  }, [available, match?.mode, match?.query]);
  const index = Math.min(activeIndex, Math.max(0, items.length - 1));
  const loading = open && !!key && ready && loadingKey === key;
  // An unavailable or empty registry must never turn selection/submit into a
  // replacement or accidental prompt. A successful registry with no matches
  // retains the PWA's normal submit behavior.
  const leadingName = /^\s*\/([^\s/]+)/.exec(draft)?.[1]?.toLowerCase();
  const slashInput =
    !!match || /^\s*\//.test(draft) || /(?:^|\s)\/skill:[^\s/]*/i.test(draft);
  const blockedReason =
    leadingName && clientCommands.has(leadingName)
      ? ("client-command" as const)
      : slashInput && running
        ? ("session-running" as const)
        : slashInput &&
            (!ready ||
              !key ||
              !loaded ||
              loaded.key !== key ||
              loaded.commands.length === 0)
          ? ("commands-unavailable" as const)
          : null;
  const shouldPreserveDraft = blockedReason !== null;
  const dismiss = useCallback(() => {
    setDismissed(token);
    setActiveIndex(0);
  }, [token]);
  const select = useCallback(
    (command: NativeSlashCommand) => {
      if (!match || !open || !items.includes(command)) return;
      const insert = buildSlashInsertText(command.name, match.mode);
      const next = draft.slice(0, match.start) + insert + draft.slice(end);
      const cursor = match.start + insert.length;
      onReplaceDraft(next, { start: cursor, end: cursor });
      setDismissed(null);
      setActiveIndex(0);
    },
    [match, open, items, draft, end, onReplaceDraft],
  );
  const handleKey = useCallback(
    (keyName: string): boolean => {
      if (!open)
        return (
          (keyName === "Enter" || keyName === "Tab") && shouldPreserveDraft
        );
      if (keyName === "Escape") {
        dismiss();
        return true;
      }
      if (
        items.length &&
        (keyName === "ArrowDown" || keyName === "ArrowRight")
      ) {
        setActiveIndex((current) => Math.min(items.length - 1, current + 1));
        return true;
      }
      if (items.length && (keyName === "ArrowUp" || keyName === "ArrowLeft")) {
        setActiveIndex((current) => Math.max(0, current - 1));
        return true;
      }
      if (keyName === "Enter" || keyName === "Tab") {
        if (items[index]) {
          select(items[index]);
          return true;
        }
        if (shouldPreserveDraft) return true;
      }
      return false;
    },
    [open, dismiss, items, index, select, shouldPreserveDraft],
  );

  return {
    open,
    items,
    index,
    loading,
    shouldPreserveDraft,
    blockedReason,
    select,
    dismiss,
    handleKey,
  };
}

/** Render directly above the composer; tapping a row only inserts its slash token. */
export function NativeSlashMenu({ menu }: { menu: NativeSlashMenuModel }) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const positions = useRef<number[]>([]);
  useEffect(() => {
    const y = positions.current[menu.index];
    if (menu.open && y !== undefined)
      scroll.current?.scrollTo({ y, animated: false });
  }, [menu.index, menu.open]);
  const dark = useColorScheme() !== "light";
  const colors = dark
    ? {
        panel: theme.panel,
        border: theme.border,
        text: theme.text,
        muted: theme.muted,
        selected: theme.hover,
        accent: theme.accent,
      }
    : {
        panel: "#F2F0EA",
        border: "#D6CFC1",
        text: "#221A14",
        muted: "#746D66",
        selected: "#E8E4DC",
        accent: "#B03E22",
      };
  if (!menu.open) return null;
  return (
    <View
      style={[
        styles.menu,
        { backgroundColor: colors.panel, borderColor: colors.border },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.meta, { color: colors.muted }]}>
          {menu.loading
            ? "Loading commands…"
            : `Slash commands · ${menu.items.length} matches`}
        </Text>
        <Text style={[styles.meta, { color: colors.muted }]}>
          ↑↓ Tab / Enter
        </Text>
      </View>
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="always"
        style={styles.list}
      >
        {!menu.loading && menu.items.length === 0 ? (
          <Text style={[styles.empty, { color: colors.muted }]}>
            No commands found
          </Text>
        ) : (
          menu.items.map((command, index) => (
            <View
              key={`${command.source}:${command.name}`}
              onLayout={(event) => {
                positions.current[index] = event.nativeEvent.layout.y;
                if (index === menu.index && index > 0) {
                  scroll.current?.scrollTo({
                    y: event.nativeEvent.layout.y,
                    animated: false,
                  });
                }
              }}
            >
              {(index === 0 ||
                menu.items[index - 1].source !== command.source) && (
                <Text style={[styles.group, { color: colors.muted }]}>
                  {sourceLabels[command.source]}
                </Text>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`/${command.name}${command.description ? `, ${command.description}` : ""}`}
                accessibilityState={{ selected: index === menu.index }}
                onPress={() => menu.select(command)}
                style={[
                  styles.item,
                  {
                    backgroundColor:
                      index === menu.index ? colors.selected : colors.panel,
                    borderColor:
                      index === menu.index ? colors.accent : colors.border,
                  },
                ]}
              >
                <Text style={[styles.name, { color: colors.text }]}>
                  /{command.name}
                  {command.input?.hint ? (
                    <Text style={[styles.meta, { color: colors.muted }]}>
                      {" "}
                      {command.input.hint}
                    </Text>
                  ) : null}
                </Text>
                {command.description ? (
                  <Text
                    numberOfLines={2}
                    style={[styles.description, { color: colors.muted }]}
                  >
                    {command.description}
                  </Text>
                ) : null}
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  menu: { borderWidth: 1, borderRadius: 8, overflow: "hidden", maxHeight: 320 },
  header: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  meta: { fontSize: 11 },
  list: { paddingHorizontal: 10, paddingTop: 8 },
  empty: { fontSize: 12, paddingBottom: 10 },
  group: {
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    paddingTop: 4,
    paddingBottom: 6,
  },
  item: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginBottom: 8,
    minHeight: 54,
    justifyContent: "center",
    gap: 4,
  },
  name: { fontSize: 13, fontFamily: "monospace" },
  description: { fontSize: 11, lineHeight: 15 },
});
