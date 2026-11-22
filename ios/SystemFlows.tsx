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
import type { operations } from "./generated/web-http";
import { KeylimeHttpError, normalizeOrigin, requestJson } from "./keylime-http";
import { nativeRequest } from "./native-network";
import type { SidebarEffort, SidebarSystem } from "./Sidebar";
import { theme } from "./theme";

type SystemsBody =
  operations["workspaceSystemsPost"]["requestBody"]["content"]["application/json"];
type SystemsResult =
  operations["workspaceSystemsPost"]["responses"][200]["content"]["application/json"];
type SystemsInput = SystemsBody["input"];
type Definition = Extract<SystemsInput, { action: "saveSystem" }>["definition"];
type Plan = NonNullable<SystemsResult["preview"]>;
type Browse =
  operations["workspaceBrowseCwd"]["responses"][200]["content"]["application/json"];
type Host = { id: string; label: string };

export type SystemFlow =
  | { kind: "system"; host: Host; repos: { path: string; name: string }[] }
  | { kind: "effort"; host: Host; system: SidebarSystem };
export interface SystemFlowsProps {
  origin: string;
  flow: SystemFlow;
  onDismiss: () => void;
  onChanged: (hostId: string) => void;
  onEffortCreated?: (hostId: string, effort: SidebarEffort) => void;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
// Service IDs identify entries within a System; they are not credentials.
function serviceId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const n = Math.floor(Math.random() * 16);
    return (c === "x" ? n : (n & 3) | 8).toString(16);
  });
}

class SystemsError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    super(message);
  }
}
async function systemsRequest(
  origin: string,
  host: string,
  input: SystemsInput,
): Promise<SystemsResult> {
  let response: Response;
  try {
    response = await nativeRequest(normalizeOrigin(origin), "/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, input } satisfies SystemsBody),
    });
  } catch {
    throw new SystemsError(
      "Could not reach server.",
      input.action !== "preview",
    );
  }
  if (response.status === 401) throw new KeylimeHttpError("unauthorized", 401);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SystemsError(
      "Invalid server response.",
      input.action !== "preview",
    );
  }
  if (!response.ok) {
    const failure =
      body && typeof body === "object"
        ? (body as { error?: unknown; code?: unknown; delivery?: unknown })
        : {};
    const text =
      typeof failure.error === "string"
        ? failure.error
        : `Server request failed (${response.status})`;
    // An absent delivery field does not establish that the host refused a mutation.
    const rejectedBeforeDispatch =
      [
        "system_exists",
        "effort_preview_changed",
        "effort_path_exists",
        "effort_branch_exists",
      ].includes(String(failure.code)) ||
      response.status === 413 ||
      (response.status === 400 &&
        ["invalid_request", "invalid_json", "request_too_large"].includes(
          String(failure.code),
        ));
    throw new SystemsError(
      text,
      input.action !== "preview" &&
        failure.delivery !== "refused" &&
        !rejectedBeforeDispatch,
    );
  }
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as SystemsResult).systems) ||
    !Array.isArray((body as SystemsResult).efforts)
  ) {
    throw new SystemsError(
      "Invalid server response.",
      input.action !== "preview",
    );
  }
  return body as SystemsResult;
}

export function SystemFlows(props: SystemFlowsProps) {
  return props.flow.kind === "system" ? (
    <SystemCreator {...props} flow={props.flow} />
  ) : (
    <EffortCreator {...props} flow={props.flow} />
  );
}

function colors(light: boolean) {
  return light
    ? {
        bg: "#FAF9F6",
        text: "#221A14",
        border: "#D6CFC1",
        input: "#F2F0EA",
        muted: "#625C57",
      }
    : {
        bg: theme.background,
        text: theme.text,
        border: theme.border,
        input: "#0A0A0C",
        muted: theme.muted,
      };
}
function Shell({
  title,
  dismiss,
  children,
}: {
  title: string;
  dismiss: () => void;
  children: React.ReactNode;
}) {
  const c = colors(useColorScheme() === "light");
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
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.body}
          >
            <Text
              accessibilityRole="header"
              style={[styles.title, { color: c.text }]}
            >
              {title}
            </Text>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
function Label({
  children,
  strong = false,
}: {
  children: React.ReactNode;
  strong?: boolean;
}) {
  const c = colors(useColorScheme() === "light");
  return (
    <Text style={[styles.text, { color: c.text }, strong && styles.strong]}>
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
  const c = colors(useColorScheme() === "light");
  return (
    <Text
      accessibilityRole={error ? "alert" : undefined}
      style={[styles.note, { color: error ? "#E67070" : c.muted }]}
    >
      {children}
    </Text>
  );
}
function Input({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  multiline?: boolean;
  disabled?: boolean;
}) {
  const c = colors(useColorScheme() === "light");
  return (
    <TextInput
      accessibilityLabel={label}
      editable={!disabled}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={c.muted}
      autoCapitalize="none"
      autoCorrect={false}
      multiline={multiline}
      style={[
        styles.input,
        multiline && styles.multiline,
        { color: c.text, backgroundColor: c.input, borderColor: c.border },
      ]}
    />
  );
}
function Button({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const c = colors(useColorScheme() === "light");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        { backgroundColor: c.input, borderColor: c.border },
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, { color: c.text }]}>{title}</Text>
    </Pressable>
  );
}
function Card({ children }: { children: React.ReactNode }) {
  const c = colors(useColorScheme() === "light");
  return (
    <View style={[styles.card, { borderColor: c.border }]}>{children}</View>
  );
}

type SystemProps = SystemFlowsProps & {
  flow: Extract<SystemFlow, { kind: "system" }>;
};
function SystemCreator({ origin, flow, onDismiss, onChanged }: SystemProps) {
  const [definition, setDefinition] = useState<Definition>({
    name: "",
    repoPaths: [],
    services: [],
    instructions: "",
  });
  const [choice, setChoice] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const addRepo = (path: string) => {
    setDefinition((previous) =>
      previous.repoPaths.includes(path)
        ? previous
        : { ...previous, repoPaths: [...previous.repoPaths, path] },
    );
    setChoice("");
    setChoosing(false);
    setBrowsing(false);
  };
  async function save() {
    if (
      locked.current ||
      uncertain ||
      !definition.name.trim() ||
      !definition.repoPaths.length ||
      definition.services.some((s) => !s.name.trim() || !s.command.trim())
    )
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await systemsRequest(origin, flow.host.id, {
        action: "saveSystem",
        definition: { ...definition, name: definition.name.trim() },
      });
      onChanged(flow.host.id);
      onDismiss();
    } catch (cause) {
      const unknown = cause instanceof SystemsError && cause.uncertain;
      if (unknown) {
        setUncertain(true);
        onChanged(flow.host.id);
      }
      setError(
        `${message(cause)}${unknown ? " Save outcome is uncertain. Check Systems before trying again." : ""}`,
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const dismiss = () => {
    if (!locked.current) onDismiss();
  };
  return (
    <Shell
      title={browsing ? `Select directory · ${flow.host.label}` : "New System"}
      dismiss={browsing ? () => setBrowsing(false) : dismiss}
    >
      {browsing ? (
        <FolderPicker
          origin={origin}
          host={flow.host}
          onCancel={() => setBrowsing(false)}
          onSelect={addRepo}
        />
      ) : (
        <>
          <View>
            <Label>System name</Label>
            <Input
              label="System name"
              value={definition.name}
              disabled={busy || uncertain}
              onChangeText={(name) =>
                setDefinition((previous) => ({ ...previous, name }))
              }
            />
          </View>
          <Card>
            <Label strong>Member Repos</Label>
            {definition.repoPaths.map((path) => (
              <View key={path} style={styles.row}>
                <View style={styles.flex}>
                  <Label>{path}</Label>
                </View>
                <Button
                  title="Remove"
                  disabled={busy || uncertain}
                  onPress={() =>
                    setDefinition((previous) => ({
                      ...previous,
                      repoPaths: previous.repoPaths.filter(
                        (item) => item !== path,
                      ),
                    }))
                  }
                />
              </View>
            ))}
            <View>
              <Label>Registered Repo</Label>
              <Button
                title={
                  flow.repos.find((repo) => repo.path === choice)?.name ??
                  "Choose a Repo"
                }
                disabled={busy || uncertain}
                onPress={() => setChoosing(!choosing)}
              />
            </View>
            {choosing && (
              <View style={styles.choices}>
                {flow.repos
                  .filter((repo) => !definition.repoPaths.includes(repo.path))
                  .map((repo) => (
                    <Button
                      key={repo.path}
                      title={
                        repo.name === repo.path
                          ? repo.path
                          : `${repo.name} · ${repo.path}`
                      }
                      onPress={() => {
                        setChoice(repo.path);
                        setChoosing(false);
                      }}
                    />
                  ))}
                {flow.repos.every((repo) =>
                  definition.repoPaths.includes(repo.path),
                ) && <Note>No registered Repos available.</Note>}
              </View>
            )}
            <View style={styles.row}>
              <Button
                title="Add registered Repo"
                disabled={!choice || busy || uncertain}
                onPress={() => addRepo(choice)}
              />
              <Button
                title="Browse host folders"
                disabled={busy || uncertain}
                onPress={() => setBrowsing(true)}
              />
            </View>
            <Note>Choose existing Git checkouts on this host.</Note>
          </Card>
          <Card>
            <Label strong>Services</Label>
            <Note>
              Each command runs in the foreground in its own terminal at the
              Effort root, as the host daemon user.
            </Note>
            {definition.services.map((service, index) => (
              <Card key={service.id}>
                <Label strong>Service {index + 1}</Label>
                <View>
                  <Label>Name</Label>
                  <Input
                    label={`Service ${index + 1} name`}
                    value={service.name}
                    disabled={busy || uncertain}
                    onChangeText={(name) =>
                      setDefinition((previous) => ({
                        ...previous,
                        services: previous.services.map((item) =>
                          item.id === service.id ? { ...item, name } : item,
                        ),
                      }))
                    }
                  />
                </View>
                <View>
                  <Label>Command</Label>
                  <Input
                    label={`Service ${index + 1} command`}
                    value={service.command}
                    multiline
                    disabled={busy || uncertain}
                    onChangeText={(command) =>
                      setDefinition((previous) => ({
                        ...previous,
                        services: previous.services.map((item) =>
                          item.id === service.id ? { ...item, command } : item,
                        ),
                      }))
                    }
                  />
                </View>
                <Button
                  title="Remove service"
                  disabled={busy || uncertain}
                  onPress={() =>
                    setDefinition((previous) => ({
                      ...previous,
                      services: previous.services.filter(
                        (item) => item.id !== service.id,
                      ),
                    }))
                  }
                />
              </Card>
            ))}
            <Button
              title="Add service"
              disabled={busy || uncertain}
              onPress={() =>
                setDefinition((previous) => ({
                  ...previous,
                  services: [
                    ...previous.services,
                    { id: serviceId(), name: "", command: "" },
                  ],
                }))
              }
            />
          </Card>
          <View>
            <Label>AGENTS.md instructions</Label>
            <Input
              label="AGENTS.md instructions"
              value={definition.instructions}
              multiline
              disabled={busy || uncertain}
              onChangeText={(instructions) =>
                setDefinition((previous) => ({ ...previous, instructions }))
              }
            />
          </View>
          {error ? <Note error>{error}</Note> : null}
          <View style={styles.row}>
            <Button
              title={busy ? "Saving…" : "Save System"}
              disabled={
                busy ||
                uncertain ||
                !definition.name.trim() ||
                !definition.repoPaths.length ||
                definition.services.some(
                  (s) => !s.name.trim() || !s.command.trim(),
                )
              }
              onPress={() => void save()}
            />
            <Button title="Cancel" disabled={busy} onPress={dismiss} />
          </View>
        </>
      )}
    </Shell>
  );
}

function FolderPicker({
  origin,
  host,
  onCancel,
  onSelect,
}: {
  origin: string;
  host: Host;
  onCancel: () => void;
  onSelect: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  const [current, setCurrent] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const browse = useCallback(
    async (directory?: string) => {
      const serial = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const query = `hostId=${encodeURIComponent(host.id)}${directory ? `&path=${encodeURIComponent(directory)}` : ""}`;
        const data = await requestJson<Browse>(
          origin,
          `/api/cwd/browse?${query}`,
        );
        if (serial !== generation.current) return;
        setCurrent(data.path);
        setPath(data.path);
        setParent(data.parentPath);
        setEntries("drives" in data ? data.drives : data.directories);
      } catch (cause) {
        if (serial === generation.current) setError(message(cause));
      } finally {
        if (serial === generation.current) setLoading(false);
      }
    },
    [origin, host.id],
  );
  useEffect(() => {
    void browse();
    return () => {
      generation.current++;
    };
  }, [browse]);
  return (
    <>
      <View style={styles.row}>
        <Button
          title="Up"
          disabled={!parent || loading}
          onPress={() => {
            if (parent) void browse(parent);
          }}
        />
        <View style={styles.flex}>
          <Input label="Directory path" value={path} onChangeText={setPath} />
        </View>
        <Button
          title="Go"
          disabled={!path.trim() || loading}
          onPress={() => void browse(path.trim())}
        />
      </View>
      {loading ? (
        <Note>Loading folders…</Note>
      ) : entries.length ? (
        entries.map((entry) => (
          <Button
            key={entry.path}
            title={entry.name}
            onPress={() => void browse(entry.path)}
          />
        ))
      ) : (
        <Note>No folders</Note>
      )}
      {error ? <Note error>{error}</Note> : null}
      <View style={styles.row}>
        <Button title="Cancel" onPress={onCancel} />
        <Button
          title="Select this folder"
          disabled={loading || !current || path.trim() !== current}
          onPress={() => onSelect(current)}
        />
      </View>
    </>
  );
}

type EffortProps = SystemFlowsProps & {
  flow: Extract<SystemFlow, { kind: "effort" }>;
};
function EffortCreator({
  origin,
  flow,
  onDismiss,
  onChanged,
  onEffortCreated,
}: EffortProps) {
  const [name, setName] = useState("");
  const [bases, setBases] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<Plan>();
  const [reviewed, setReviewed] = useState(false);
  const [openRefs, setOpenRefs] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const request = {
    systemId: flow.system.id,
    name: name.trim(),
    bases: Object.entries(bases)
      .filter(([, ref]) => ref.trim())
      .map(([repoPath, ref]) => ({ repoPath, ref: ref.trim() })),
  };
  const setBase = (path: string, ref: string) => {
    setBases((previous) => ({ ...previous, [path]: ref }));
    setReviewed(false);
    setOpenRefs(undefined);
  };
  async function submit() {
    if (locked.current || uncertain || !request.name || flow.system.archived)
      return;
    locked.current = true;
    setBusy(true);
    setError("");
    const creating = reviewed && !!plan;
    try {
      if (!creating || !plan) {
        const result = await systemsRequest(origin, flow.host.id, {
          action: "preview",
          ...request,
        });
        if (!result.preview || !result.preview.confirmation)
          throw new Error("The host did not return an Effort preview.");
        setPlan(result.preview);
        setReviewed(true);
      } else {
        setReviewed(false);
        const result = await systemsRequest(origin, flow.host.id, {
          action: "create",
          ...request,
          confirmation: plan.confirmation,
        });
        onChanged(flow.host.id);
        const effort = result.efforts.find(
          (item) => item.id === result.effortId,
        );
        if (!effort) {
          setUncertain(true);
          setError(
            "Couldn't find the new Effort in the host response. Check Systems before trying again.",
          );
          return;
        }
        onEffortCreated?.(flow.host.id, effort);
        onDismiss();
      }
    } catch (cause) {
      const unknown =
        creating && cause instanceof SystemsError && cause.uncertain;
      if (unknown) {
        setUncertain(true);
        onChanged(flow.host.id);
      }
      setError(
        `${message(cause)}${unknown ? " Creation outcome is uncertain. Check Systems before trying again." : ""}`,
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const dismiss = () => {
    if (!locked.current) onDismiss();
  };
  return (
    <Shell title={`New Effort in ${flow.system.name}`} dismiss={dismiss}>
      <View>
        <Label>Effort name</Label>
        <Input
          label="Effort name"
          value={name}
          disabled={busy || uncertain}
          onChangeText={(value) => {
            setName(value);
            setReviewed(false);
          }}
        />
      </View>
      <Note>
        Preview the branch and starting commit for each Repo before creating
        worktrees.
      </Note>
      {reviewed && plan && (
        <Card>
          <Label>Root: {plan.root}</Label>
          <Label>Branch: {plan.branch}</Label>
        </Card>
      )}
      {flow.system.repoPaths.map((repoPath) => {
        const member = plan?.members.find((item) => item.repoPath === repoPath);
        const branches = member?.branches;
        const refs = branches
          ? Array.from(
              new Set(
                [
                  branches.defaultRef,
                  ...branches.local,
                  ...branches.remote,
                  ...branches.otherRefs,
                ].filter(Boolean),
              ),
            )
          : [];
        return (
          <Card key={repoPath}>
            <Label strong>{member?.name ?? repoPath}</Label>
            {refs.length > 0 && (
              <>
                <Button
                  title={
                    bases[repoPath] || branches?.defaultRef || "Choose base ref"
                  }
                  disabled={busy || uncertain}
                  onPress={() =>
                    setOpenRefs(openRefs === repoPath ? undefined : repoPath)
                  }
                />
                {openRefs === repoPath && (
                  <View style={styles.choices}>
                    {refs.map((ref) => (
                      <Button
                        key={ref}
                        title={ref}
                        disabled={busy || uncertain}
                        onPress={() => setBase(repoPath, ref)}
                      />
                    ))}
                  </View>
                )}
              </>
            )}
            <View>
              <Label>Base ref override</Label>
              <Input
                label={`Base ref override for ${member?.name ?? repoPath}`}
                value={bases[repoPath] ?? ""}
                placeholder="Detected default"
                disabled={busy || uncertain}
                onChangeText={(ref) => setBase(repoPath, ref)}
              />
            </View>
            {reviewed && member && (
              <>
                <Label>
                  Starting at {member.baseRef} ({member.baseCommit})
                </Label>
                <Label>Checkout: {member.path}</Label>
                {member.skipsCustomCreate && (
                  <Note>
                    Skips this Repo's custom create command. Other setup hooks
                    still run.
                  </Note>
                )}
              </>
            )}
          </Card>
        );
      })}
      {error ? <Note error>{error}</Note> : null}
      <View style={styles.row}>
        <Button
          title={
            busy ? "Working…" : reviewed ? "Create Effort" : "Preview Effort"
          }
          disabled={busy || uncertain || !request.name || flow.system.archived}
          onPress={() => void submit()}
        />
        <Button title="Cancel" disabled={busy} onPress={dismiss} />
      </View>
    </Shell>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 16,
    backgroundColor: "rgba(0,0,0,0.75)",
  },
  dialog: {
    maxHeight: "94%",
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  body: { padding: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: "700", marginBottom: 4 },
  text: { fontSize: 14, lineHeight: 21 },
  strong: { fontWeight: "700" },
  note: { fontSize: 14, lineHeight: 21 },
  card: { borderWidth: 1, borderRadius: 8, padding: 10, gap: 10 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    minHeight: 36,
    paddingHorizontal: 8,
    paddingVertical: 7,
    fontSize: 14,
  },
  multiline: { minHeight: 100, textAlignVertical: "top" },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  flex: { flex: 1, minWidth: 100 },
  button: {
    minHeight: 30,
    borderWidth: 1,
    borderRadius: 7,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  buttonText: { fontSize: 12, textAlign: "center" },
  disabled: { opacity: 0.45 },
  choices: { gap: 4 },
});
