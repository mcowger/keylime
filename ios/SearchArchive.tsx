import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import {
  compileSearchQuery,
  FIRST_MESSAGE_WEIGHT,
  scoreSearchFields,
  searchField,
  TITLE_WEIGHT,
} from "../lib/session-search";
import type { operations } from "./generated/web-http";
import type { HomeSessionInfo } from "./HomeScreen";
import { KeylimeHttpError, normalizeOrigin, requestJson } from "./keylime-http";
import { nativeRequest, nativeSearchStream } from "./native-network";
import { theme } from "./theme";

type SearchBatch =
  operations["searchSessions"]["responses"][200]["content"]["application/x-ndjson"];
type ArchiveList =
  operations["listSessionArchives"]["responses"][200]["content"]["application/json"];
type Archive = ArchiveList["archives"][number];
type RestoreResponse =
  operations["restoreSessionArchive"]["responses"][200]["content"]["application/json"];
type RestoreBody =
  operations["restoreSessionArchive"]["requestBody"]["content"]["application/json"];
type SearchStatus = "idle" | "running" | "done" | "stopped" | "error";
const sessionKey = (hostId: string | undefined, id: string) =>
  JSON.stringify([hostId ?? "local", id]);
const archiveKey = (archive: Archive) =>
  sessionKey(archive.hostId, archive.key);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Matches only saved sessions returned by the server, preserving host identity. */
export function useSidebarSearch(
  origin: string,
  sessions: readonly HomeSessionInfo[] | null,
  onUnauthorized: () => void,
  visible: boolean,
) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    origin: string;
    query: string;
    scores: Map<string, number>;
    status: SearchStatus;
    error: string;
  }>({ origin: "", query: "", scores: new Map(), status: "idle", error: "" });
  const generation = useRef(0);
  const activeSearch = useRef<{
    origin: string;
    query: string;
    controller: AbortController;
  } | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const text = visible ? query.trim() : "";
  const currentIdentity = useRef({ origin, text });
  useLayoutEffect(() => {
    currentIdentity.current = { origin, text };
  }, [origin, text]);
  useEffect(() => {
    const serial = ++generation.current;
    if (!text) return;
    const controller = new AbortController();
    activeSearch.current = { origin, query: text, controller };
    setResult({
      origin,
      query: text,
      scores: new Map(),
      status: "running",
      error: "",
    });
    const timer = setTimeout(() => {
      if (controller.signal.aborted || serial !== generation.current) return;
      void (async () => {
        let buffered = "";
        const isCurrent = () =>
          serial === generation.current &&
          !controller.signal.aborted &&
          currentIdentity.current.origin === origin &&
          currentIdentity.current.text === text;
        const parse = (line: string) => {
          if (!line.trim()) return;
          const batch: SearchBatch = JSON.parse(line);
          if (!batch || !Array.isArray(batch.scores))
            throw new KeylimeHttpError("invalid-response");
          const scores = new Map<string, number>();
          for (const row of batch.scores) {
            if (
              !row ||
              typeof row.hostId !== "string" ||
              typeof row.sessionId !== "string" ||
              typeof row.score !== "number" ||
              !Number.isFinite(row.score)
            )
              throw new KeylimeHttpError("invalid-response");
            scores.set(sessionKey(row.hostId, row.sessionId), row.score);
          }
          if (scores.size && isCurrent())
            setResult((current) => {
              if (current.origin !== origin || current.query !== text)
                return current;
              const merged = new Map(current.scores);
              for (const [key, score] of scores) merged.set(key, score);
              return { ...current, scores: merged };
            });
        };
        try {
          await nativeSearchStream(
            normalizeOrigin(origin),
            `/api/sessions/search?q=${encodeURIComponent(text)}`,
            controller.signal,
            (status) => {
              if (!isCurrent()) throw new Error("Request superseded");
              if (status === 401) unauthorized.current();
              if (status < 200 || status >= 300)
                throw new KeylimeHttpError("http", status);
            },
            (chunk) => {
              if (!isCurrent()) throw new Error("Request superseded");
              buffered += chunk;
              const lines = buffered.split("\n");
              buffered = lines.pop() ?? "";
              for (const line of lines) parse(line);
            },
          );
          parse(buffered);
          if (isCurrent())
            setResult((current) =>
              current.origin === origin && current.query === text
                ? { ...current, status: "done" }
                : current,
            );
        } catch (error) {
          if (isCurrent())
            setResult((current) =>
              current.origin === origin && current.query === text
                ? { ...current, status: "error", error: message(error) }
                : current,
            );
        }
      })();
    }, 250);
    return () => {
      clearTimeout(timer);
      generation.current++;
      controller.abort();
      if (activeSearch.current?.controller === controller)
        activeSearch.current = null;
    };
  }, [origin, text]);
  const stop = useCallback(() => {
    const active = activeSearch.current;
    if (!active || active.origin !== origin || active.query !== text) return;
    active.controller.abort();
    setResult((current) =>
      current.origin === origin && current.query === text
        ? { ...current, status: "stopped" }
        : current,
    );
  }, [origin, text]);
  const matches = useMemo(() => {
    if (!text) return [];
    const compiled = compileSearchQuery(text);
    const scores =
      result.origin === origin && result.query === text
        ? result.scores
        : new Map<string, number>();
    return (sessions ?? [])
      .map((session) => {
        const title = compiled
          ? scoreSearchFields(
              [
                searchField(session.name ?? "", TITLE_WEIGHT),
                searchField(session.firstMessage, FIRST_MESSAGE_WEIGHT),
              ],
              compiled,
            )
          : 0;
        const transcript = scores.get(sessionKey(session.hostId, session.id));
        return {
          session,
          score: (title ?? 0) + (transcript ?? 0),
          matched: title !== null || transcript !== undefined,
        };
      })
      .filter((row) => row.matched)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Date.parse(b.session.modified) - Date.parse(a.session.modified),
      )
      .map((row) => row.session);
  }, [sessions, origin, text, result]);
  return {
    query,
    setQuery,
    matches,
    status: !text
      ? ("idle" as const)
      : result.origin === origin && result.query === text
        ? result.status
        : ("running" as const),
    error:
      result.origin === origin && result.query === text ? result.error : "",
    stop,
  };
}

export function SearchInput({
  query,
  setQuery,
  status,
  error,
  stop,
}: {
  query: string;
  setQuery: (value: string) => void;
  status: SearchStatus;
  error: string;
  stop: () => void;
}) {
  const light = useColorScheme() === "light";
  const colors = palette(light);
  return (
    <View style={styles.searchWrap}>
      <TextInput
        accessibilityLabel="Search repos, systems, efforts and chats"
        value={query}
        onChangeText={setQuery}
        maxLength={500}
        placeholder="Search repos, systems, efforts and chats…"
        placeholderTextColor={colors.dim}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.input,
          {
            color: colors.text,
            borderColor: colors.border,
            backgroundColor: colors.background,
          },
        ]}
      />
      <Text style={[styles.hint, { color: colors.dim }]}>
        Transcript search covers this machine only.
      </Text>
      {status === "running" && (
        <View>
          <Text style={[styles.hint, { color: colors.dim }]}>
            Searching transcripts… results may move as better matches are found
          </Text>
          <Pressable accessibilityRole="button" onPress={stop}>
            <Text style={[styles.hint, { color: colors.accent }]}>Stop</Text>
          </Pressable>
        </View>
      )}
      {status === "stopped" && (
        <Text style={[styles.hint, { color: colors.dim }]}>
          Search stopped. Transcript results may be incomplete.
        </Text>
      )}
      {status === "error" && (
        <Text
          accessibilityRole="alert"
          style={[styles.hint, { color: colors.error }]}
        >
          Transcript search failed: {error}
        </Text>
      )}
    </View>
  );
}

export interface ArchiveBrowserProps {
  origin: string;
  hosts?: readonly { id: string; label: string }[];
  onClose: () => void;
  onRestored: (sessionId: string, hostId: string, archive: Archive) => void;
  onUnauthorized: () => void;
}

// A lost reply may mean a restore is still executing. Do not offer a duplicate in this app process.
const uncertainRestores = new Set<string>();

export function ArchiveBrowser({
  origin,
  hosts = [],
  onClose,
  onRestored,
  onUnauthorized,
}: ArchiveBrowserProps) {
  const light = useColorScheme() === "light";
  const colors = palette(light);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [unavailable, setUnavailable] = useState<
    ArchiveList["unavailableHosts"]
  >([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [, setUncertain] = useState(0);
  const restoreInFlight = useRef(false);
  const serial = useRef(0);
  const authorized = useRef(onUnauthorized);
  authorized.current = onUnauthorized;
  const load = useCallback(async () => {
    const request = ++serial.current;
    setLoading(true);
    setError("");
    try {
      const data = await requestJson<ArchiveList>(
        origin,
        "/api/sessions/archive",
      );
      if (request !== serial.current) return;
      if (
        !Array.isArray(data.archives) ||
        !Array.isArray(data.unavailableHosts)
      )
        throw new KeylimeHttpError("invalid-response");
      setArchives(data.archives);
      setUnavailable(data.unavailableHosts);
      setSelected((current) =>
        current && data.archives.some((row) => archiveKey(row) === current)
          ? current
          : data.archives[0]
            ? archiveKey(data.archives[0])
            : null,
      );
    } catch (cause) {
      if (request !== serial.current) return;
      if (cause instanceof KeylimeHttpError && cause.kind === "unauthorized")
        authorized.current();
      else setError(message(cause));
    } finally {
      if (request === serial.current) setLoading(false);
    }
  }, [origin]);
  useEffect(() => {
    void load();
    return () => {
      serial.current++;
    };
  }, [load]);
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return text
      ? archives.filter((row) =>
          [
            row.name,
            row.id,
            row.cwd,
            row.firstMessage,
            row.status,
            row.hostId,
            hosts.find((host) => host.id === (row.hostId ?? "local"))?.label,
          ].some((value) => value?.toLowerCase().includes(text)),
        )
      : archives;
  }, [archives, hosts, query]);
  const selectedArchive =
    filtered.find((row) => archiveKey(row) === selected) ?? filtered[0];
  const uncertainKey = selectedArchive
    ? JSON.stringify([
        origin,
        selectedArchive.hostId ?? "local",
        selectedArchive.id,
      ])
    : "";
  const isUncertain = uncertainRestores.has(uncertainKey);
  async function restore(archive: Archive) {
    const hostId = archive.hostId ?? "local";
    const identity = JSON.stringify([origin, hostId, archive.id]);
    if (
      restoreInFlight.current ||
      archive.restorePending ||
      uncertainRestores.has(identity)
    )
      return;
    restoreInFlight.current = true;
    setRestoring(true);
    setError("");
    let outcomeKnown = false;
    try {
      const body: RestoreBody = { key: archive.key, hostId };
      const server = normalizeOrigin(origin);
      const response = await nativeRequest(server, "/api/sessions/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        authorized.current();
        return;
      }
      if (!response.ok) {
        let payload: { error?: string; code?: string } = {};
        try {
          payload = await response.json();
        } catch {
          /* The status is still meaningful. */
        }
        outcomeKnown =
          (response.status === 503 &&
            (payload.code === "host_offline" ||
              payload.code === "host_sessions_unavailable")) ||
          (response.status < 500 &&
            payload.code !== "archive_restore_unconfirmed" &&
            (response.status !== 409 || !!payload.code));
        throw new Error(
          payload.error || `Server request failed (${response.status})`,
        );
      }
      const data: RestoreResponse = await response.json();
      if (
        data.ok !== true ||
        typeof data.sessionId !== "string" ||
        !data.sessionId
      )
        throw new Error("Invalid server response");
      outcomeKnown = true;
      onRestored(data.sessionId, hostId, archive);
      onClose();
    } catch (cause) {
      if (!outcomeKnown) {
        uncertainRestores.add(identity);
        setUncertain((value) => value + 1);
      }
      setError(`Failed to restore session: ${message(cause)}`);
    } finally {
      restoreInFlight.current = false;
      setRestoring(false);
    }
  }
  const close = () => {
    if (!restoring) onClose();
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView behavior="padding" style={styles.backdrop}>
        <View
          accessibilityViewIsModal
          style={[
            styles.dialog,
            { backgroundColor: colors.background, borderColor: colors.border },
          ]}
        >
          <View style={[styles.archiveHeader, { borderColor: colors.border }]}>
            <View style={styles.headerRow}>
              <Text
                style={[
                  styles.archiveIcon,
                  { color: colors.accent, backgroundColor: colors.surface },
                ]}
              >
                ▣
              </Text>
              <View style={styles.flex}>
                <Text style={[styles.title, { color: colors.text }]}>
                  Archived Sessions
                </Text>
                <Text style={[styles.description, { color: colors.muted }]}>
                  Browse and restore sessions that have been archived.
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh archives"
                disabled={loading || restoring}
                onPress={() => void load()}
                style={[styles.iconButton, { borderColor: colors.border }]}
              >
                <Text style={[styles.iconText, { color: colors.text }]}>↻</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                disabled={restoring}
                onPress={close}
                style={[styles.iconButton, { borderColor: colors.border }]}
              >
                <Text style={[styles.iconText, { color: colors.text }]}>×</Text>
              </Pressable>
            </View>
            <TextInput
              accessibilityLabel="Search archives"
              value={query}
              onChangeText={setQuery}
              placeholder="Search archives by name, directory, or message…"
              placeholderTextColor={colors.dim}
              autoCapitalize="none"
              style={[
                styles.input,
                {
                  color: colors.text,
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                },
              ]}
            />
          </View>
          {unavailable.length > 0 && (
            <Text
              accessibilityRole="alert"
              style={[
                styles.notice,
                { color: colors.muted, borderColor: colors.border },
              ]}
            >
              Archives on {unavailable.map((row) => row.label).join(", ")} could
              not be read: the host is offline or its key lime host needs an
              update.
            </Text>
          )}
          {error ? (
            <View style={styles.errorRow}>
              <Text
                accessibilityRole="alert"
                style={{ color: colors.error, flex: 1 }}
              >
                {error}
              </Text>
              {!archives.length && !restoring && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void load()}
                >
                  <Text style={{ color: colors.accent }}>Retry</Text>
                </Pressable>
              )}
            </View>
          ) : null}
          {loading && !archives.length ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.muted} />
              <Text style={{ color: colors.muted }}>
                Loading archived sessions…
              </Text>
            </View>
          ) : !archives.length && !error ? (
            <View style={styles.empty}>
              <Text
                style={[
                  styles.emptyIcon,
                  { color: colors.dim, backgroundColor: colors.surface },
                ]}
              >
                ▣
              </Text>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                No archived sessions
              </Text>
              <Text style={[styles.emptyDescription, { color: colors.muted }]}>
                Sessions you archive from the sidebar will appear here.
              </Text>
            </View>
          ) : archives.length ? (
            <View style={styles.content}>
              <ScrollView
                style={[
                  styles.archiveList,
                  { backgroundColor: colors.panel, borderColor: colors.border },
                ]}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={[styles.count, { color: colors.dim }]}>
                  {filtered.length} archives
                </Text>
                {filtered.length ? (
                  filtered.map((row) => (
                    <Pressable
                      key={archiveKey(row)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: selectedArchive === row }}
                      onPress={() => setSelected(archiveKey(row))}
                      style={[
                        styles.archiveRow,
                        selectedArchive === row && {
                          backgroundColor: colors.surface,
                        },
                      ]}
                    >
                      <Text
                        numberOfLines={2}
                        style={[styles.rowTitle, { color: colors.text }]}
                      >
                        {row.name ||
                          row.firstMessage.trim().slice(0, 48) ||
                          row.id.slice(0, 12)}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={[styles.rowMeta, { color: colors.dim }]}
                      >
                        {row.hostId ?? "local"} ·{" "}
                        {row.archivedAt
                          ? new Date(row.archivedAt).toLocaleDateString()
                          : ""}
                      </Text>
                    </Pressable>
                  ))
                ) : (
                  <Text style={[styles.notice, { color: colors.muted }]}>
                    No matching archives. Try adjusting your search query.
                  </Text>
                )}
              </ScrollView>
              <ScrollView
                style={styles.detail}
                contentContainerStyle={styles.detailContent}
                keyboardShouldPersistTaps="handled"
              >
                {selectedArchive && (
                  <>
                    <Text style={[styles.detailTitle, { color: colors.text }]}>
                      {selectedArchive.name ||
                        selectedArchive.firstMessage.trim().slice(0, 60) ||
                        selectedArchive.id}
                    </Text>
                    <Text
                      selectable
                      style={[styles.rowMeta, { color: colors.dim }]}
                    >
                      {selectedArchive.id}
                    </Text>
                    {selectedArchive.status && (
                      <Text style={{ color: colors.muted }}>
                        {selectedArchive.status}
                      </Text>
                    )}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{
                        disabled:
                          restoring ||
                          !!selectedArchive.restorePending ||
                          isUncertain,
                      }}
                      disabled={
                        restoring ||
                        !!selectedArchive.restorePending ||
                        isUncertain
                      }
                      onPress={() => void restore(selectedArchive)}
                      style={[
                        styles.restore,
                        { backgroundColor: colors.accent },
                        (restoring ||
                          selectedArchive.restorePending ||
                          isUncertain) &&
                          styles.disabled,
                      ]}
                    >
                      <Text style={styles.restoreText}>
                        {restoring ? "Restoring…" : "Restore Session"}
                      </Text>
                    </Pressable>
                    <Text
                      style={[
                        styles.noticeBox,
                        {
                          color: colors.muted,
                          backgroundColor: colors.panel,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      {selectedArchive.restorePending || isUncertain
                        ? "This restore may still be running. Inspect the owning host before recovery; do not retry until the restore is confirmed stopped."
                        : "Restoring will move this session back into your active workspace and select it in the chat window."}
                    </Text>
                    <Metadata
                      label="Directory"
                      value={selectedArchive.cwd}
                      colors={colors}
                    />
                    <Metadata
                      label="Host"
                      value={selectedArchive.hostId ?? "local"}
                      colors={colors}
                    />
                    <Metadata
                      label="Created"
                      value={formatDate(selectedArchive.created)}
                      colors={colors}
                    />
                    <Metadata
                      label="Archived"
                      value={formatDate(selectedArchive.archivedAt)}
                      colors={colors}
                    />
                    <Metadata
                      label="Messages"
                      value={String(selectedArchive.messageCount)}
                      colors={colors}
                    />
                    <Metadata
                      label="Archive Size"
                      value={formatSize(selectedArchive.size)}
                      colors={colors}
                    />
                    <Metadata
                      label="Initial Prompt / Message"
                      value={
                        selectedArchive.firstMessage.trim() ||
                        "(No initial message)"
                      }
                      colors={colors}
                    />
                  </>
                )}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
interface Palette {
  background: string;
  panel: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  dim: string;
  accent: string;
  error: string;
}
function palette(light: boolean): Palette {
  return light
    ? {
        background: "#FAF9F6",
        panel: "#F2F0EA",
        surface: "#E7E3DB",
        border: "#D6CFC1",
        text: "#221A14",
        muted: "#625C57",
        dim: "#77716B",
        accent: "#B03E22",
        error: "#B32E3D",
      }
    : {
        background: theme.background,
        panel: theme.panel,
        surface: theme.hover,
        border: theme.border,
        text: theme.text,
        muted: theme.muted,
        dim: "#93939B",
        accent: theme.accent,
        error: "#E67070",
      };
}
function Metadata({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: Palette;
}) {
  return (
    <View
      style={[
        styles.metadata,
        { borderColor: colors.border, backgroundColor: colors.panel },
      ]}
    >
      <Text style={[styles.metaLabel, { color: colors.dim }]}>{label}</Text>
      <Text selectable style={{ color: colors.text, fontSize: 12 }}>
        {value}
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  flex: { flex: 1 },
  searchWrap: { paddingHorizontal: 10, paddingBottom: 8 },
  input: {
    minHeight: 36,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 13,
  },
  hint: { fontSize: 11, marginTop: 3 },
  backdrop: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 64,
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  dialog: { flex: 1, borderWidth: 1, borderRadius: 14, overflow: "hidden" },
  archiveHeader: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    gap: 12,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  archiveIcon: {
    fontSize: 20,
    borderRadius: 8,
    overflow: "hidden",
    padding: 6,
  },
  title: { fontSize: 17, fontWeight: "600" },
  description: { fontSize: 12, lineHeight: 18, marginTop: 3 },
  iconButton: {
    width: 30,
    height: 30,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { fontSize: 20, lineHeight: 24 },
  notice: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  errorRow: { flexDirection: "row", padding: 12, gap: 8 },
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    padding: 24,
  },
  emptyIcon: {
    fontSize: 24,
    padding: 12,
    borderRadius: 12,
    overflow: "hidden",
  },
  emptyTitle: { fontSize: 14, fontWeight: "600" },
  emptyDescription: { fontSize: 12, textAlign: "center" },
  content: { flex: 1, flexDirection: "row" },
  archiveList: { width: "40%", borderRightWidth: 1 },
  count: { padding: 10, fontSize: 11, fontWeight: "600" },
  archiveRow: { marginHorizontal: 5, padding: 8, borderRadius: 7, gap: 4 },
  rowTitle: { fontSize: 12, fontWeight: "600" },
  rowMeta: { fontSize: 11 },
  detail: { flex: 1 },
  detailContent: { padding: 12, gap: 9 },
  detailTitle: { fontSize: 16, fontWeight: "600" },
  restore: {
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 9,
    alignItems: "center",
  },
  restoreText: { color: "white", fontSize: 12, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  noticeBox: {
    fontSize: 12,
    lineHeight: 17,
    borderWidth: 1,
    borderRadius: 7,
    padding: 9,
  },
  metadata: { padding: 9, borderWidth: 1, borderRadius: 7, gap: 4 },
  metaLabel: { fontSize: 11, fontWeight: "600" },
});
