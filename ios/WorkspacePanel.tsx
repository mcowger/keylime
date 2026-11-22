import { useEffect, useRef, useState } from "react";
import {
  DynamicColorIOS,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { operations } from "./generated/web-http";
import type { BrowserLink } from "./browser-link";
import { requestJson } from "./keylime-http";
import { theme as darkTheme } from "./theme";
import { WorkspaceFile, workspaceFileUrl } from "./WorkspaceFile";

type FileResponse =
  operations["workspaceFilesGet"]["responses"][200]["content"]["application/json"];
type Listing = Extract<FileResponse, { entries: unknown }>;
type Entry = Listing["entries"][number];
type GitStatus =
  operations["workspaceGitStatus"]["responses"][200]["content"]["application/json"];
type GitDiff =
  operations["workspaceGitDiff"]["responses"][200]["content"]["application/json"];
const theme = {
  background: DynamicColorIOS({ dark: darkTheme.background, light: "#FAF9F6" }),
  panel: DynamicColorIOS({ dark: darkTheme.panel, light: "#F2F0EA" }),
  border: DynamicColorIOS({ dark: darkTheme.border, light: "#D6CFC1" }),
  text: DynamicColorIOS({ dark: darkTheme.text, light: "#221A14" }),
  muted: DynamicColorIOS({ dark: darkTheme.muted, light: "#625C57" }),
  accent: DynamicColorIOS({ dark: darkTheme.accent, light: "#A4246D" }),
};

import { SessionActivity } from "./SessionActivity";
export type WorkspacePanelProps = {
  origin: string;
  hostId: string;
  cwd: string;
  sessionId?: string | null;
  link?: BrowserLink | null;
  onClose: () => void;
  onMention?: (path: string, isDirectory: boolean) => void;
};

type Scope = Pick<
  WorkspacePanelProps,
  "origin" | "hostId" | "cwd" | "sessionId"
>;
function query(scope: Scope, extra?: Record<string, string>): string {
  const params = new URLSearchParams({
    cwd: scope.cwd,
    hostId: scope.hostId,
    ...extra,
  });
  if (scope.sessionId) params.set("sessionId", scope.sessionId);
  return params.toString();
}
function nameOf(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}
function relative(path: string, root: string): string {
  const prefix = root.replace(/\/$/, "") + "/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

// Keying the panel by the full owner prevents file tabs or in-flight reads from crossing workspaces.
export function WorkspacePanel(props: WorkspacePanelProps) {
  return (
    <Panel
      key={JSON.stringify([
        props.origin,
        props.hostId,
        props.cwd,
        props.sessionId ?? null,
      ])}
      {...props}
    />
  );
}

function Panel(props: WorkspacePanelProps) {
  const [view, setView] = useState("explorer");
  const [files, setFiles] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const open = (path: string) => {
    setFiles((old) => (old.includes(path) ? old : [...old, path]));
    setView(`file:${path}`);
  };
  const closeFile = (path: string) => {
    setFiles((old) => old.filter((item) => item !== path));
    if (view === `file:${path}`) setView("explorer");
  };
  return (
    <View style={styles.panel}>
      <View style={styles.tabsRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabs}
        >
          <Tab
            label="▱  Explorer"
            active={view === "explorer"}
            onPress={() => setView("explorer")}
          />
          <Tab
            label="⑂  Git"
            active={view === "git"}
            onPress={() => setView("git")}
          />
          {props.sessionId && props.link && (
            <>
              <Tab
                label="Activity"
                active={view === "activity"}
                onPress={() => setView("activity")}
              />
              <Tab
                label="Jobs"
                active={view === "jobs"}
                onPress={() => setView("jobs")}
              />
            </>
          )}
          {files.map((path) => (
            <View
              key={path}
              style={[
                styles.fileTab,
                view === `file:${path}` && styles.activeTab,
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: view === `file:${path}` }}
                onPress={() => setView(`file:${path}`)}
              >
                <Text style={styles.tabText} numberOfLines={1}>
                  ▤ {nameOf(path)}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Close ${nameOf(path)}`}
                onPress={() => closeFile(path)}
                hitSlop={8}
              >
                <Text style={styles.dim}>×</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close workspace panel"
          onPress={props.onClose}
          style={styles.close}
        >
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </View>
      {view === "explorer" ? (
        <Explorer
          {...props}
          refresh={refresh}
          onRefresh={() => setRefresh((v) => v + 1)}
          onOpen={open}
        />
      ) : view === "git" ? (
        <Git
          {...props}
          refresh={refresh}
          onRefresh={() => setRefresh((v) => v + 1)}
        />
      ) : view === "activity" || view === "jobs" ? (
        props.sessionId && props.link ? (
          <SessionActivity
            origin={props.origin}
            hostId={props.hostId}
            sessionId={props.sessionId}
            link={props.link}
            kind={view}
          />
        ) : null
      ) : (
        <WorkspaceFile
          origin={props.origin}
          hostId={props.hostId}
          sessionId={props.sessionId}
          path={view.slice(5)}
          link={props.link}
        />
      )}
    </View>
  );
}

function Tab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.tab, active && styles.activeTab]}
    >
      <Text style={[styles.tabText, active && styles.activeText]}>{label}</Text>
    </Pressable>
  );
}

type ExplorerProps = WorkspacePanelProps & {
  refresh: number;
  onRefresh: () => void;
  onOpen: (path: string) => void;
};
function Explorer({
  origin,
  hostId,
  cwd,
  sessionId,
  onMention,
  onOpen,
  refresh,
  onRefresh,
}: ExplorerProps) {
  const [open, setOpen] = useState<Set<string>>(new Set([cwd]));
  const [listings, setListings] = useState<Record<string, Entry[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    const requestGeneration = ++generation.current;
    setListings({});
    setErrors({});
    setOpen(new Set([cwd]));
    setLoading(new Set([cwd]));
    requestJson<FileResponse>(
      origin,
      workspaceFileUrl(cwd, "list", hostId, sessionId, cwd),
    )
      .then((data) => {
        if (!active) return;
        if (!("entries" in data)) throw new Error("Invalid directory listing");
        setListings({ [cwd]: data.entries });
      })
      .catch((error: unknown) => {
        if (active) setErrors({ [cwd]: errorMessage(error) });
      })
      .finally(() => {
        if (active) setLoading(new Set());
      });
    return () => {
      active = false;
      if (generation.current === requestGeneration) generation.current++;
    };
  }, [origin, hostId, cwd, sessionId, refresh]);

  function toggle(path: string) {
    if (open.has(path)) {
      setOpen((old) => {
        const next = new Set(old);
        next.delete(path);
        return next;
      });
      return;
    }
    setOpen((old) => new Set(old).add(path));
    if (listings[path] || loading.has(path)) return;
    setLoading((old) => new Set(old).add(path));
    setErrors((old) => {
      const next = { ...old };
      delete next[path];
      return next;
    });
    const requestGeneration = generation.current;
    requestJson<FileResponse>(
      origin,
      workspaceFileUrl(path, "list", hostId, sessionId, cwd),
    )
      .then((data) => {
        if (!("entries" in data)) throw new Error("Invalid directory listing");
        const entries = data.entries;
        if (generation.current === requestGeneration)
          setListings((old) => ({ ...old, [path]: entries }));
      })
      .catch((error: unknown) => {
        if (generation.current === requestGeneration)
          setErrors((old) => ({ ...old, [path]: errorMessage(error) }));
      })
      .finally(() => {
        if (generation.current === requestGeneration)
          setLoading((old) => {
            const next = new Set(old);
            next.delete(path);
            return next;
          });
      });
  }
  function rows(directory: string, depth: number): React.ReactNode {
    return (
      <View key={directory}>
        {loading.has(directory) && (
          <Text style={[styles.hint, { paddingLeft: 18 + depth * 17 }]}>
            Loading…
          </Text>
        )}
        {!!errors[directory] && (
          <Text style={[styles.hint, { paddingLeft: 18 + depth * 17 }]}>
            {errors[directory]}
          </Text>
        )}
        {(listings[directory] ?? []).map((entry) => {
          const path = `${directory.replace(/\/$/, "")}/${entry.name}`;
          return (
            <View key={path}>
              <View style={[styles.entry, { paddingLeft: 14 + depth * 17 }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${entry.isDir ? "Folder" : "File"} ${entry.name}${entry.outsideRoot ? ", outside workspace" : ""}`}
                  accessibilityState={
                    entry.isDir
                      ? {
                          expanded: open.has(path),
                          disabled: !!entry.outsideRoot,
                        }
                      : { disabled: !!entry.outsideRoot }
                  }
                  disabled={entry.outsideRoot}
                  onPress={() => (entry.isDir ? toggle(path) : onOpen(path))}
                  style={styles.entryMain}
                >
                  <Text style={styles.entryIcon}>
                    {entry.isDir ? (open.has(path) ? "⌄  ▱" : "›  ▱") : "   ▤"}
                  </Text>
                  <Text numberOfLines={1} style={styles.entryName}>
                    {entry.name}
                  </Text>
                </Pressable>
                {onMention && !entry.outsideRoot && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Mention ${entry.name}`}
                    onPress={() => onMention(relative(path, cwd), entry.isDir)}
                    style={styles.mention}
                  >
                    <Text style={styles.mentionText}>@</Text>
                  </Pressable>
                )}
              </View>
              {entry.isDir && open.has(path) && rows(path, depth + 1)}
            </View>
          );
        })}
      </View>
    );
  }
  return (
    <View style={styles.body}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setOpen(new Set([cwd]))}
          style={styles.tool}
        >
          <Text style={styles.toolText}>⌃ Collapse all folders</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh files"
          onPress={onRefresh}
          style={styles.tool}
        >
          <Text style={styles.toolText}>↻</Text>
        </Pressable>
      </View>
      <ScrollView>
        <View style={styles.root}>
          <Text style={styles.rootIcon}>▱</Text>
          <View style={styles.rootText}>
            <Text style={styles.rootName}>{nameOf(cwd)}</Text>
            <Text numberOfLines={1} style={styles.rootPath}>
              {cwd}
            </Text>
          </View>
        </View>
        {rows(cwd, 0)}
      </ScrollView>
    </View>
  );
}

function Git({
  origin,
  hostId,
  cwd,
  sessionId,
  link,
  refresh,
  onRefresh,
}: WorkspacePanelProps & { refresh: number; onRefresh: () => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setStatus(null);
    setError(null);
    setSelected(null);
    requestJson<GitStatus>(
      origin,
      `/api/git/status?${query({ origin, hostId, cwd, sessionId })}`,
    )
      .then((data) => {
        if (active) setStatus(data);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [origin, hostId, cwd, sessionId, refresh]);
  const visible =
    status?.files.filter((file) =>
      relative(file.filePath, cwd).toLowerCase().includes(filter.toLowerCase()),
    ) ?? [];
  return (
    <View style={styles.body}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh Git status"
          onPress={onRefresh}
          style={styles.tool}
        >
          <Text style={styles.toolText}>↻</Text>
        </Pressable>
      </View>
      <View style={styles.filterRow}>
        <Text style={styles.dim}>⌕</Text>
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter files…"
          placeholderTextColor={theme.muted}
          style={styles.filter}
          accessibilityLabel="Filter changed files"
        />
      </View>
      {error ? (
        <Text style={styles.hint}>{error}</Text>
      ) : !status ? (
        <Text style={styles.hint}>Loading Git status…</Text>
      ) : !status.isGitRepository ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Not a Git repository</Text>
        </View>
      ) : status.files.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.check}>✓</Text>
          <Text style={styles.emptyTitle}>No changes</Text>
          <Text style={styles.emptyText}>The working tree matches HEAD.</Text>
        </View>
      ) : (
        <ScrollView>
          {visible.length === 0 ? (
            <Text style={styles.hint}>No matching files</Text>
          ) : (
            visible.map((file) => (
              <View key={file.filePath}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: selected === file.filePath }}
                  onPress={() =>
                    setSelected(
                      selected === file.filePath ? null : file.filePath,
                    )
                  }
                  style={styles.gitFile}
                >
                  <Text style={styles.dim}>
                    {selected === file.filePath ? "⌄" : "›"}
                  </Text>
                  <Text style={styles.gitPath}>
                    {relative(file.filePath, cwd)}
                  </Text>
                  <Text style={styles.gitCode}>{file.code}</Text>
                </Pressable>
                {selected === file.filePath && (
                  <Diff
                    key={file.filePath}
                    origin={origin}
                    hostId={hostId}
                    cwd={cwd}
                    sessionId={sessionId}
                    link={link}
                    path={file.filePath}
                  />
                )}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

function Diff({
  origin,
  hostId,
  cwd,
  sessionId,
  path,
  link,
}: Scope & { path: string; link?: BrowserLink | null }) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let requestId = 0;
    const load = () => {
      if (!active) return;
      const id = ++requestId;
      requestJson<GitDiff>(
        origin,
        `/api/git/diff?${query({ origin, hostId, cwd, sessionId }, { path })}`,
      )
        .then((data) => {
          if (active && requestId === id) {
            setDiff(data);
            setError(null);
          }
        })
        .catch((reason: unknown) => {
          if (active && requestId === id) setError(errorMessage(reason));
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
        onOpen: load,
      },
    );
    return () => {
      active = false;
      requestId++;
      unsubscribe?.();
    };
  }, [origin, hostId, cwd, sessionId, path, link]);
  if (error) return <Text style={styles.hint}>{error}</Text>;
  if (!diff) return <Text style={styles.hint}>Loading diff…</Text>;
  if (!diff.supported)
    return <Text style={styles.hint}>Diff unavailable for this file.</Text>;
  if (!diff.patch) return <Text style={styles.hint}>No diff available.</Text>;
  return (
    <ScrollView horizontal>
      <View style={styles.patch}>
        {diff.patch.split("\n").map((line, index) => (
          <Text
            selectable
            key={index}
            style={[
              styles.patchLine,
              line.startsWith("+") && styles.added,
              line.startsWith("-") && styles.removed,
            ]}
          >
            {line || " "}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: theme.background },
  body: { flex: 1 },
  tabsRow: {
    height: 44,
    flexDirection: "row",
    backgroundColor: theme.panel,
    borderBottomWidth: 1,
    borderColor: theme.border,
  },
  tabs: { flexDirection: "row" },
  tab: {
    minWidth: 84,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRightWidth: 1,
    borderColor: theme.border,
  },
  activeTab: {
    backgroundColor: DynamicColorIOS({ dark: "#1d1d23", light: "#E7E3DB" }),
    borderBottomWidth: 2,
    borderBottomColor: theme.accent,
  },
  tabText: { color: theme.muted, fontSize: 13 },
  activeText: { color: theme.text },
  fileTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    maxWidth: 180,
    borderRightWidth: 1,
    borderColor: theme.border,
  },
  close: {
    width: 42,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.panel,
  },
  closeText: { color: theme.text, fontSize: 23 },
  toolbar: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.panel,
  },
  tool: { paddingHorizontal: 15, minHeight: 40, justifyContent: "center" },
  toolText: { color: theme.muted, fontSize: 13 },
  root: {
    flexDirection: "row",
    alignItems: "center",
    margin: 9,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    padding: 9,
    gap: 9,
  },
  rootIcon: { color: theme.accent, fontSize: 19 },
  rootText: { flex: 1 },
  rootName: { color: theme.text, fontSize: 13, fontWeight: "700" },
  rootPath: {
    color: theme.muted,
    fontSize: 11,
    fontFamily: "Menlo",
    marginTop: 3,
  },
  entry: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 30,
  },
  entryMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
  },
  entryIcon: { color: theme.muted, fontSize: 16, width: 31 },
  entryName: { color: theme.text, fontSize: 13, flex: 1 },
  mention: { padding: 8 },
  mentionText: { color: theme.muted, fontSize: 18 },
  dim: { color: theme.muted, fontSize: 16 },
  hint: { color: theme.muted, fontSize: 13, padding: 14 },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    gap: 8,
    paddingVertical: 6,
  },
  filter: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
    color: theme.text,
    fontSize: 13,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 50,
  },
  check: {
    color: DynamicColorIOS({ dark: "#82d0ac", light: "#267a54" }),
    fontSize: 28,
    marginBottom: 10,
  },
  emptyTitle: { color: theme.text, fontSize: 14, fontWeight: "600" },
  emptyText: { color: theme.muted, fontSize: 12, marginTop: 12 },
  gitFile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    minHeight: 42,
  },
  gitPath: { flex: 1, color: theme.text, fontSize: 13 },
  gitCode: { color: theme.accent, fontSize: 12 },
  patch: { paddingHorizontal: 12, paddingBottom: 8 },
  patchLine: {
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 17,
    color: theme.muted,
  },
  added: { color: DynamicColorIOS({ dark: "#82d0ac", light: "#267a54" }) },
  removed: { color: DynamicColorIOS({ dark: "#f0828b", light: "#aa3038" }) },
});
