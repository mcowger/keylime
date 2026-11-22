import { useCallback, useEffect, useRef, useState } from "react";
import {
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
import { isRecord } from "../lib/type-guards";
import type { BrowserLink, BrowserLinkStatus } from "./browser-link";
import type { operations } from "./generated/web-http";
import { normalizeOrigin, requestJson } from "./keylime-http";
import { nativeRequest } from "./native-network";
import type { SidebarRepo } from "./Sidebar";
import { theme } from "./theme";

type JsonResponse<K extends keyof operations> = operations[K] extends {
  responses: { 200: { content: { "application/json": infer T } } };
}
  ? T
  : never;
type Browse = JsonResponse<"workspaceBrowseCwd">;
type Project = JsonResponse<"workspaceProjectsPost">["project"];
type Hierarchy = JsonResponse<"workspaceHierarchyPost">;
type Worktrees = JsonResponse<"workspaceWorktreesGet">;
type Branches = Extract<Worktrees, { defaultRef: string }>;
type Job = Extract<Worktrees, { status: string; input: unknown }>;
type CreateBody = Extract<
  operations["workspaceWorktreesPost"]["requestBody"]["content"]["application/json"],
  { action: "create" }
>;

type Host = { id: string; label: string };
export type RepoFlow =
  | { kind: "addRepo"; host: Host }
  | { kind: "workspace"; host: Host; repo: SidebarRepo };
export interface RepoFlowsProps {
  origin: string;
  link: BrowserLink;
  linkStatus: BrowserLinkStatus;
  flow: RepoFlow;
  onDismiss: () => void;
  onChanged: () => void;
  onProjectAdded?: (hostId: string, project: Project) => void;
  onWorkspaceCreated?: (hostId: string, path: string) => void;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const query = (values: Record<string, string>) =>
  Object.entries(values)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
// IDs are idempotency keys, not credentials. Keep the key for status reconciliation after a lost reply.
function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16);
    return (c === "x" ? n : (n & 3) | 8).toString(16);
  });
}
function cleanBranch(value: string) {
  const result = value
    .replace(/[\u0000-\u0020\u007f~^:?*[\]\\]+/gu, "-")
    .replace(/@\{/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[-./]+/, "")
    .split("/")
    .map((part) => part.replace(/^\.+/g, "").replace(/\.lock$/, "-lock"))
    .filter(Boolean)
    .join("/")
    .replace(/\.+$/, "")
    .replace(/\.lock$/, "-lock");
  return result === "@" || result === "HEAD" ? "" : result;
}
function validProfile(value: string) {
  return (
    !value ||
    (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) &&
      !value.endsWith(".") &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(value))
  );
}
function cloneName(url: string) {
  if (
    !/^https:\/\/[^\s/@]+(?:@[^\s/]+)?\/\S+$/.test(url) &&
    !/^ssh:\/\/(?:[^\s/@]+@)?[^\s/]+\/\S+$/.test(url) &&
    !/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]{2,}:(?!:|\/\/)[^\s\\]+$/.test(url)
  )
    return null;
  const path = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const name = path
    .slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf(":")) + 1)
    .replace(/\.git$/, "");
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== ".."
    ? name
    : null;
}

export function RepoFlows(props: RepoFlowsProps) {
  return props.flow.kind === "addRepo" ? (
    <AddRepo {...props} host={props.flow.host} />
  ) : (
    <WorkspaceFlow
      key={JSON.stringify([
        props.origin,
        props.flow.host.id,
        props.flow.repo.path,
      ])}
      {...props}
      host={props.flow.host}
      repo={props.flow.repo}
    />
  );
}

function Shell({
  title,
  subtitle,
  dismiss,
  children,
}: {
  title: string;
  subtitle?: string;
  dismiss: () => void;
  children: React.ReactNode;
}) {
  const light = useColorScheme() === "light";
  const c = light
    ? { bg: "#FAF9F6", text: "#221A14", border: "#D6CFC1", muted: "#625C57" }
    : {
        bg: theme.background,
        text: theme.text,
        border: theme.border,
        muted: "#93939B",
      };
  return (
    <Modal transparent animationType="fade" onRequestClose={dismiss}>
      <KeyboardAvoidingView behavior="padding" style={styles.backdrop}>
        <View
          accessibilityViewIsModal
          style={[
            styles.dialog,
            { backgroundColor: c.bg, borderColor: c.border },
          ]}
        >
          <View style={[styles.header, { borderColor: c.border }]}>
            <View style={styles.flex}>
              <Text style={[styles.title, { color: c.text }]}>{title}</Text>
              {subtitle ? (
                <Text style={[styles.subtitle, { color: c.muted }]}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={dismiss}
              style={styles.close}
            >
              <Text style={[styles.closeText, { color: c.muted }]}>×</Text>
            </Pressable>
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
function Input({
  value,
  onChangeText,
  placeholder,
  label,
  multiline,
  autoCapitalize = "none",
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  label: string;
  multiline?: boolean;
  autoCapitalize?: "none" | "sentences";
}) {
  const light = useColorScheme() === "light";
  return (
    <TextInput
      accessibilityLabel={label}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={light ? "#77716B" : "#88888F"}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      multiline={multiline}
      style={[
        styles.input,
        multiline && styles.multiline,
        {
          color: light ? "#221A14" : theme.text,
          backgroundColor: light ? "#F2F0EA" : "#0A0A0C",
          borderColor: light ? "#D6CFC1" : theme.border,
        },
      ]}
    />
  );
}
function Button({
  title,
  onPress,
  disabled,
  primary,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  const light = useColorScheme() === "light";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        primary
          ? styles.primary
          : { borderColor: light ? "#D6CFC1" : theme.border },
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          { color: primary ? "white" : light ? "#221A14" : theme.muted },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  const light = useColorScheme() === "light";
  return (
    <Text style={[styles.label, { color: light ? "#221A14" : theme.text }]}>
      {children}
    </Text>
  );
}
function Note({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  const light = useColorScheme() === "light";
  return (
    <Text
      accessibilityRole={error ? "alert" : undefined}
      style={[
        styles.note,
        { color: error ? "#E67070" : light ? "#625C57" : "#93939B" },
      ]}
    >
      {children}
    </Text>
  );
}

function AddRepo({
  origin,
  host,
  onDismiss,
  onChanged,
  onProjectAdded,
}: RepoFlowsProps & { host: Host }) {
  const [path, setPath] = useState("");
  const [current, setCurrent] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [profile, setProfile] = useState("");
  const [advisor, setAdvisor] = useState(false);
  const [extraArgs, setExtraArgs] = useState("");
  const [cloneId, setCloneId] = useState<string | null>(null);
  const [cloneUncertain, setCloneUncertain] = useState(false);
  const generation = useRef(0);
  const browse = useCallback(
    async (directory?: string) => {
      const serial = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const params: Record<string, string> = { hostId: host.id };
        if (directory) params.path = directory;
        const data = await requestJson<Browse>(
          origin,
          `/api/cwd/browse?${query(params)}`,
        );
        if (serial !== generation.current) return;
        setCurrent(data.path);
        setPath(data.path);
        setParent(data.parentPath);
        setEntries(
          "drives" in data
            ? data.drives
            : (data.directories as { name: string; path: string }[]),
        );
      } catch (e) {
        if (serial === generation.current) setError(message(e));
      } finally {
        if (serial === generation.current) setLoading(false);
      }
    },
    [host.id, origin],
  );
  useEffect(() => {
    void browse();
    return () => {
      generation.current++;
    };
  }, [browse]);
  const launchConfig = {
    profile: profile.trim() || undefined,
    advisor: advisor || undefined,
    extraArgs: extraArgs
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  async function register(selected: string) {
    const data = await requestJson<JsonResponse<"workspaceProjectsPost">>(
      origin,
      "/api/projects",
      post({ cwd: selected, hostId: host.id, launchConfig }),
    );
    onChanged();
    onProjectAdded?.(host.id, data.project);
    onDismiss();
  }
  async function submit() {
    if (
      busy ||
      loading ||
      !current ||
      path.trim() !== current ||
      !validProfile(profile.trim()) ||
      (cloneUrl.trim() && !cloneName(cloneUrl.trim()))
    )
      return;
    setBusy(true);
    setError("");
    let requested = false;
    try {
      if (!cloneUrl.trim()) {
        await register(current);
        return;
      }
      const selected = await requestJson<JsonResponse<"workspaceValidateCwd">>(
        origin,
        "/api/cwd/validate",
        post({ cwd: current, hostId: host.id }),
      );
      const id = uuid();
      setCloneId(id);
      requested = true;
      const response = await nativeRequest(
        normalizeOrigin(origin),
        "/api/projects/clone",
        post({
          id,
          parent: selected.cwd,
          url: cloneUrl.trim(),
          hostId: host.id,
        }),
      );
      if (!response.ok)
        throw new Error(
          `Clone request failed (${response.status}). Inspect the destination before retrying.`,
        );
      const text = await response.text();
      let completedPath: string | undefined;
      let failure: string | undefined;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as {
          type: string;
          path?: string;
          error?: string;
        };
        if (frame.type === "done") completedPath = frame.path;
        if (frame.type === "error") failure = frame.error || "Clone failed.";
        if (frame.type === "cancelled")
          failure = `Clone cancelled${frame.path ? `: ${frame.path}` : "."}`;
      }
      if (failure) {
        requested = false;
        throw new Error(failure);
      }
      if (!completedPath) throw new Error("Clone result was incomplete.");
      requested = false;
      setCloneUrl("");
      // Keep the clone selectable if project registration fails.
      await browse(completedPath);
      await register(completedPath);
    } catch (e) {
      if (requested) {
        setCloneUncertain(true);
        setError(
          `Clone outcome is uncertain. Inspect the destination before retrying. ${message(e)}`,
        );
      } else setError(message(e));
    } finally {
      setCloneId(null);
      setBusy(false);
    }
  }
  const dismiss = () => {
    if (!busy) onDismiss();
  };
  return (
    <Shell title="Select directory" subtitle={host.label} dismiss={dismiss}>
      <View style={styles.pathRow}>
        <Button
          title="⌃"
          onPress={() => {
            if (parent) void browse(parent);
          }}
          disabled={!parent || busy}
        />
        <View style={styles.flex}>
          <Input label="Directory path" value={path} onChangeText={setPath} />
        </View>
        <Button
          title="Go"
          onPress={() => void browse(path.trim())}
          disabled={!path.trim() || busy || loading}
        />
      </View>
      <ScrollView
        style={styles.directories}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <Note>Loading folders…</Note>
        ) : entries.length === 0 ? (
          <Note>No folders</Note>
        ) : (
          entries.map((entry) => (
            <Pressable
              accessibilityRole="button"
              key={entry.path}
              disabled={busy}
              onPress={() => void browse(entry.path)}
              style={styles.directory}
            >
              <Text style={styles.directoryText}>▱ {entry.name}</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
      <ScrollView
        style={styles.options}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.fields}
      >
        <Input
          label="Clone a repository here"
          placeholder="Clone a repository here (https://… or git@…) — optional"
          value={cloneUrl}
          onChangeText={(text) => {
            setCloneUrl(text);
            setCloneUncertain(false);
          }}
        />
        <Input
          label="OMP profile"
          placeholder="OMP profile (optional)"
          value={profile}
          onChangeText={setProfile}
        />
        {profile.trim() && !validProfile(profile.trim()) ? (
          <Note error>Enter a valid OMP profile name.</Note>
        ) : null}
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: advisor }}
          onPress={() => setAdvisor(!advisor)}
          style={styles.checkRow}
        >
          <Text style={styles.checkbox}>{advisor ? "☑" : "□"}</Text>
          <Label>Launch with advisor mode</Label>
        </Pressable>
        <Input
          label="Extra arguments"
          placeholder="Extra arguments, one per line (optional)"
          value={extraArgs}
          onChangeText={setExtraArgs}
          multiline
        />
        {cloneUrl.trim() && !cloneName(cloneUrl.trim()) ? (
          <Note error>Enter an https:// or ssh Git URL.</Note>
        ) : null}
        {error ? <Note error>{error}</Note> : null}
        {busy && cloneId ? (
          <>
            <Note>Cloning repository…</Note>
            <Button
              title="Cancel clone"
              onPress={() => {
                void requestJson(origin, "/api/projects/clone", {
                  ...post({ id: cloneId, hostId: host.id }),
                  method: "DELETE",
                }).catch(() =>
                  setError(
                    "Cancellation is uncertain. Inspect the destination.",
                  ),
                );
              }}
            />
          </>
        ) : null}
      </ScrollView>
      <View style={styles.actions}>
        <Button title="Cancel" onPress={dismiss} disabled={busy} />
        <Button
          title={busy ? "Working…" : "Select this folder"}
          primary
          onPress={() => void submit()}
          disabled={
            busy ||
            loading ||
            !current ||
            path.trim() !== current ||
            !validProfile(profile.trim()) ||
            (!!cloneUrl.trim() &&
              (!cloneName(cloneUrl.trim()) || cloneUncertain))
          }
        />
      </View>
    </Shell>
  );
}

function WorkspaceFlow({
  origin,
  link,
  linkStatus,
  host,
  repo,
  onDismiss,
  onChanged,
  onWorkspaceCreated,
}: RepoFlowsProps & { host: Host; repo: SidebarRepo }) {
  const [tab, setTab] = useState<"create" | "import">("create");
  const [branches, setBranches] = useState<Branches | null>(null);
  const [mode, setMode] = useState<"new" | "local" | "remote">("new");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [name, setName] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const creation = useRef<CreateBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<NonNullable<
    Hierarchy["workspaceCandidates"]
  > | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const notified = useRef("");
  const completed = useRef(false);
  const statusRequest = useRef(0);
  const statusReading = useRef(false);
  const statusAgain = useRef(false);
  const admitting = useRef(false);
  const callbacks = useRef({ onChanged, onWorkspaceCreated });
  callbacks.current = { onChanged, onWorkspaceCreated };
  const alive = useRef(true);
  const applyJob = useCallback(
    (result: Job) => {
      setJob(result);
      setError("");
      if (result.workspaceId && notified.current !== result.workspaceId) {
        notified.current = result.workspaceId;
        callbacks.current.onChanged();
      }
      if (result.status === "running") return;
      completed.current = true;
      callbacks.current.onChanged();
      if (result.status === "complete" && result.workspacePath)
        callbacks.current.onWorkspaceCreated?.(host.id, result.workspacePath);
    },
    [host.id],
  );
  const status = useCallback(
    async (id: string) => {
      if (completed.current || admitting.current) return;
      if (statusReading.current) {
        statusAgain.current = true;
        return;
      }
      statusReading.current = true;
      do {
        statusAgain.current = false;
        const request = ++statusRequest.current;
        try {
          const result = await requestJson<Worktrees>(
            origin,
            `/api/worktrees?${query({ hostId: host.id, action: "status", id })}`,
          );
          if (!("input" in result && "status" in result))
            throw new Error("Invalid workspace job response");
          if (
            !alive.current ||
            request !== statusRequest.current ||
            completed.current
          )
            continue;
          applyJob(result);
        } catch (e) {
          if (
            alive.current &&
            !completed.current &&
            request === statusRequest.current
          )
            setError(`Couldn't check workspace setup: ${message(e)}`);
        }
      } while (
        alive.current &&
        statusAgain.current &&
        !completed.current &&
        !admitting.current
      );
      statusReading.current = false;
    },
    [origin, host.id, applyJob],
  );
  useEffect(() => {
    alive.current = true;
    if (repo.kind === "git")
      void requestJson<Worktrees>(
        origin,
        `/api/worktrees?${query({ hostId: host.id, projectPath: repo.path, action: "branches" })}`,
      )
        .then((result) => {
          if (!alive.current) return;
          if (!("defaultRef" in result))
            throw new Error("Invalid branch response");
          setBranches(result);
          setBaseRef(result.defaultRef.replace(/^refs\/(heads|remotes)\//, ""));
        })
        .catch((e) => {
          if (alive.current) setError(message(e));
        });
    return () => {
      alive.current = false;
    };
  }, [origin, host.id, repo.path, repo.kind]);
  useEffect(() => {
    if (!jobId) return;
    void status(jobId);
    return link.subscribe(
      { kind: "workspace-jobs", hostId: host.id },
      {
        onOpen: () => void status(jobId),
        onEvent: (event) => {
          if (
            isRecord(event) &&
            event.type === "workspace_jobs_changed" &&
            event.scope === "setup"
          )
            void status(jobId);
        },
      },
    );
  }, [host.id, jobId, link, status]);
  useEffect(() => {
    if (jobId && linkStatus === "open") void status(jobId);
  }, [jobId, linkStatus, status]);
  async function create(retry = false) {
    if (admitting.current || busy || !branches || (jobId && !retry)) return;
    const normalized = mode === "local" ? branch : cleanBranch(branch);
    if (
      !retry &&
      (!normalized || !name.trim() || (mode !== "local" && !baseRef))
    )
      return;
    const id = retry ? jobId : uuid();
    if (!id) return;
    const body: CreateBody =
      retry && creation.current
        ? creation.current
        : {
            action: "create",
            hostId: host.id,
            input: {
              projectPath: repo.path,
              branch: normalized,
              mode,
              baseRef: mode === "local" ? branch : baseRef,
              name: name.trim(),
              creationId: id,
            },
          };
    creation.current = body;
    admitting.current = true;
    completed.current = false;
    statusRequest.current++;
    setJobId(id);
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<Worktrees>(
        origin,
        "/api/worktrees",
        post(body),
      );
      if (!alive.current) return;
      if (!("input" in result && "status" in result))
        throw new Error("Invalid workspace job response");
      applyJob(result);
    } catch (e) {
      if (alive.current && !completed.current)
        setError(
          `Creation may have started. Check its status or retry the same request. ${message(e)}`,
        );
    } finally {
      admitting.current = false;
      if (alive.current) {
        setBusy(false);
        if (!completed.current) void status(id);
      }
    }
  }
  async function discover() {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<Hierarchy>(
        origin,
        "/api/hierarchy",
        post({
          host: host.id,
          input: { action: "discoverWorkspaces", projectId: repo.id },
        }),
      );
      setCandidates(result.workspaceCandidates ?? []);
      setChecked([]);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function importSelected() {
    if (!checked.length || busy) return;
    setBusy(true);
    setError("");
    try {
      await requestJson<Hierarchy>(
        origin,
        "/api/hierarchy",
        post({
          host: host.id,
          input: {
            action: "importWorkspaces",
            projectId: repo.id,
            paths: checked,
          },
        }),
      );
      onChanged();
      onDismiss();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function changeMode(next: typeof mode) {
    setMode(next);
    setBranch("");
    setBaseRef(
      next === "new"
        ? (branches?.defaultRef.replace(/^refs\/(heads|remotes)\//, "") ?? "")
        : "",
    );
  }
  const options =
    mode === "local"
      ? (branches?.local ?? [])
      : mode === "remote"
        ? (branches?.remote ?? [])
        : [...(branches?.local ?? []), ...(branches?.remote ?? [])];
  const selected = mode === "local" ? branch : baseRef;
  return (
    <Shell
      title="Manage workspaces"
      subtitle={`${repo.alias ?? repo.name} · ${host.label}`}
      dismiss={onDismiss}
    >
      <View style={styles.tabs}>
        <Button
          title="Create workspace"
          onPress={() => setTab("create")}
          primary={tab === "create"}
        />
        <Button
          title="Import workspaces"
          onPress={() => {
            setTab("import");
            if (!candidates) void discover();
          }}
          primary={tab === "import"}
        />
      </View>
      <ScrollView
        style={styles.workspaceBody}
        contentContainerStyle={styles.fields}
        keyboardShouldPersistTaps="handled"
      >
        {tab === "create" ? (
          <>
            {repo.kind !== "git" ? (
              <Note>Workspaces can be created for Git repos.</Note>
            ) : (
              <>
                <Label>Branch source</Label>
                <View style={styles.modeRow}>
                  {(
                    [
                      ["new", "New branch"],
                      ["local", "Local"],
                      ["remote", "Remote"],
                    ] as const
                  ).map(([value, label]) => (
                    <Button
                      key={value}
                      title={label}
                      primary={mode === value}
                      disabled={!!jobId}
                      onPress={() => changeMode(value)}
                    />
                  ))}
                </View>
                {mode !== "local" && (
                  <>
                    <Label>Branch name</Label>
                    <Input
                      label="Branch name"
                      value={branch}
                      onChangeText={(value) => {
                        setBranch(value);
                        setName(value.replace(/[\\/]/g, "-"));
                      }}
                    />
                    <Note>
                      Git branch: {cleanBranch(branch) || "Enter a branch name"}
                    </Note>
                  </>
                )}
                <Label>
                  {mode === "local"
                    ? "Branch"
                    : mode === "remote"
                      ? "Remote branch"
                      : "Base ref"}
                </Label>
                {!branches ? (
                  <Note>Loading branches…</Note>
                ) : options.length === 0 ? (
                  <Note>No branches available.</Note>
                ) : (
                  options.map((ref) => (
                    <Pressable
                      key={ref}
                      accessibilityRole="radio"
                      accessibilityState={{
                        checked: selected === ref,
                        disabled: !!jobId,
                      }}
                      disabled={!!jobId}
                      onPress={() => {
                        if (mode === "local") {
                          setBranch(ref);
                          setName(ref.replace(/[\\/]/g, "-"));
                        } else setBaseRef(ref);
                      }}
                      style={styles.refRow}
                    >
                      <Text style={styles.refText}>
                        {selected === ref ? "◉" : "○"} {ref}
                      </Text>
                    </Pressable>
                  ))
                )}
                <Label>Display name</Label>
                <Input
                  label="Display name"
                  value={name}
                  onChangeText={setName}
                />
                <Note>
                  Workspace directory: {repo.path}-worktrees/
                  {(mode === "local" ? branch : cleanBranch(branch)).replace(
                    /[^a-zA-Z0-9._-]/g,
                    "-",
                  )}
                </Note>
                {job && (
                  <>
                    <Label>
                      Setup: {job.status} / {job.stage}
                    </Label>
                    {job.error ? <Note error>{job.error}</Note> : null}
                    {job.logs ? (
                      <Text selectable style={styles.log}>
                        {job.logs}
                      </Text>
                    ) : null}
                  </>
                )}
                {jobId && (!job || job.status === "running") ? (
                  <>
                    <Note>
                      Setup runs on the host. Progress updates automatically.
                    </Note>
                    <Button
                      title="Check setup status"
                      onPress={() => void status(jobId)}
                    />
                  </>
                ) : null}
                {jobId && !job && error ? (
                  <Button
                    title="Retry same request"
                    onPress={() => void create(true)}
                    disabled={busy}
                  />
                ) : null}
              </>
            )}
          </>
        ) : (
          <>
            {candidates === null ? (
              <Note>Discovering workspaces…</Note>
            ) : candidates.length === 0 ? (
              <Note>No workspaces to import.</Note>
            ) : (
              candidates.map((candidate) => (
                <Pressable
                  key={candidate.path}
                  accessibilityRole="checkbox"
                  accessibilityState={{
                    checked: checked.includes(candidate.path),
                  }}
                  onPress={() =>
                    setChecked((previous) =>
                      previous.includes(candidate.path)
                        ? previous.filter((path) => path !== candidate.path)
                        : [...previous, candidate.path],
                    )
                  }
                  style={styles.checkRow}
                >
                  <Text style={styles.checkbox}>
                    {checked.includes(candidate.path) ? "☑" : "□"}
                  </Text>
                  <Label>
                    {candidate.branch
                      ? `${candidate.name} (${candidate.branch})`
                      : candidate.path}
                  </Label>
                </Pressable>
              ))
            )}
            <Button
              title="Refresh discovery"
              onPress={() => void discover()}
              disabled={busy}
            />
          </>
        )}
        {error ? <Note error>{error}</Note> : null}
      </ScrollView>
      <View style={styles.actions}>
        <Button title="Close" onPress={onDismiss} />
        <Button
          primary
          title={
            tab === "create"
              ? busy
                ? "Creating…"
                : "Create"
              : "Import selected"
          }
          onPress={() => void (tab === "create" ? create() : importSelected())}
          disabled={
            busy ||
            (tab === "create"
              ? !!jobId ||
                repo.kind !== "git" ||
                !branches ||
                !(mode === "local" ? branch : cleanBranch(branch)) ||
                !name.trim() ||
                (mode !== "local" && !baseRef)
              : !checked.length)
          }
        />
      </View>
    </Shell>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 8,
    backgroundColor: "rgba(0,0,0,0.75)",
  },
  dialog: {
    maxHeight: "94%",
    borderRadius: 17,
    borderWidth: 1,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  flex: { flex: 1 },
  title: { fontSize: 15, fontWeight: "700" },
  subtitle: { fontSize: 11, marginTop: 4 },
  close: { padding: 6 },
  closeText: { fontSize: 24, lineHeight: 26 },
  pathRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 14,
    borderBottomWidth: 1,
    borderColor: theme.border,
  },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    minHeight: 42,
    paddingHorizontal: 9,
    paddingVertical: 9,
    fontFamily: "Menlo",
    fontSize: 12,
  },
  multiline: { minHeight: 48, textAlignVertical: "top" },
  directories: { minHeight: 120, maxHeight: 190, paddingHorizontal: 18 },
  directory: { paddingVertical: 14 },
  directoryText: { color: theme.muted, fontFamily: "Menlo", fontSize: 12 },
  options: {
    flexGrow: 0,
    borderTopWidth: 1,
    borderColor: theme.border,
    maxHeight: 250,
  },
  fields: { padding: 18, gap: 9 },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    minHeight: 38,
  },
  checkbox: { color: "#9999A2", fontSize: 22 },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    padding: 14,
    borderTopWidth: 1,
    borderColor: theme.border,
  },
  button: {
    minHeight: 40,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  primary: { backgroundColor: "#A61F70", borderColor: "#A61F70" },
  disabled: { opacity: 0.45 },
  buttonText: { fontSize: 13, fontWeight: "500", textAlign: "center" },
  label: { fontSize: 13 },
  note: { fontSize: 12, lineHeight: 17 },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingTop: 12 },
  modeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  workspaceBody: { flexGrow: 0, maxHeight: 560 },
  refRow: { paddingVertical: 7 },
  refText: { color: theme.muted, fontSize: 13 },
  log: { color: theme.muted, fontFamily: "Menlo", fontSize: 11 },
});
