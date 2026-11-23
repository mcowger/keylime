import { useCallback, useEffect, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { operations } from "./generated/web-http";
import {
  getHosts,
  KeylimeHttpError,
  requestJson,
  type HostsResponse,
} from "./keylime-http";
import { theme } from "./theme";

type Host = HostsResponse["hosts"][number];
type NativeSettings =
  operations["getOmpSettings"]["responses"][200]["content"]["application/json"]["settings"];
type Hierarchy =
  operations["workspaceHierarchyGet"]["responses"][200]["content"]["application/json"];
type Project = Hierarchy["projects"][number];
type WorktreeResponse =
  operations["workspaceWorktreesGet"]["responses"][200]["content"]["application/json"];
type CreationSettings = Extract<WorktreeResponse, { defaults: unknown }>;
type Pipeline = CreationSettings["defaults"];

/** Only provide preferences whose behavior is implemented by the parent. */
export type SettingsPreferences = {
  keepToolCallsCollapsed?: boolean;
  expandThinkingBlocks?: "off" | "latest" | "all";
  hideToolActivityWhileWorking?: boolean;
  showToolCallsOutsideProcessDetails?: boolean;
  neverFoldToolActivity?: boolean;
};
export type SettingsScreenProps = {
  origin: string;
  hosts: HostsResponse["hosts"];
  onBack: () => void;
  onUnauthorized: () => void;
  preferences?: SettingsPreferences;
  onChangePreference?: (
    key: keyof SettingsPreferences,
    value: SettingsPreferences[keyof SettingsPreferences],
  ) => void;
};

type Tab =
  | "general"
  | "safety"
  | "models"
  | "providers"
  | "usage"
  | "intelligence"
  | "agents"
  | "mcp"
  | "hosts"
  | "projects"
  | "notifications"
  | "system";
const categories: {
  id: Tab;
  label: string;
  description: string;
  icon: string;
}[] = [
  {
    id: "general",
    label: "Interface & Behavior",
    description: "UI preferences, completion sound, submission mode",
    icon: "☷",
  },
  {
    id: "safety",
    label: "Safety & Approvals",
    description: "Tool safety rules, YOLO mode, terminal permissions",
    icon: "◇",
  },
  {
    id: "models",
    label: "AI Model Defaults",
    description: "Reasoning budget, verbosity, personality, scratchpad",
    icon: "▣",
  },
  {
    id: "providers",
    label: "API Keys & Providers",
    description: "Connected OAuth accounts, API keys, and model registry",
    icon: "♧",
  },
  {
    id: "usage",
    label: "Usage",
    description: "Tokens, costs, cache analytics, and model breakdown",
    icon: "▥",
  },
  {
    id: "intelligence",
    label: "Agent & Intelligence",
    description: "Advisor, memory, autolearn, compaction and retry",
    icon: "✧",
  },
  {
    id: "agents",
    label: "Agents",
    description: "Task agents, model settings, and tool policy",
    icon: "♙",
  },
  {
    id: "mcp",
    label: "Extensions & Tools",
    description: "MCP servers, managed skills, and OMP plugins",
    icon: "♧",
  },
  {
    id: "hosts",
    label: "Hosts",
    description: "Linked machines and host configuration",
    icon: "♧",
  },
  {
    id: "projects",
    label: "Repos",
    description: "Repo names and workspace creation commands",
    icon: "▱",
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Desktop and mobile notifications for your sessions",
    icon: "♧",
  },
  {
    id: "system",
    label: "System",
    description: "Agent settings and service controls",
    icon: "↻",
  },
];
const prefs = [
  {
    key: "keepToolCallsCollapsed",
    label: "Keep tool calls collapsed",
    description: "Show only compact headers while tools execute.",
  },
  {
    key: "expandThinkingBlocks",
    label: "Expand thinking blocks",
    description:
      "Expand no thinking blocks, the latest block, or every block, including while streaming. You can still toggle each block manually.",
  },
  {
    key: "hideToolActivityWhileWorking",
    label: "Hide tool activity while working",
    description:
      "Fold a running turn's tool calls into one Process details row, the same way a finished turn folds them. Expand the row to see each call and its result.",
  },
  {
    key: "showToolCallsOutsideProcessDetails",
    label: "Show tool calls outside Process details",
    description:
      "Keep each tool call's row visible in the transcript instead of folding it into Process details.",
  },
  {
    key: "neverFoldToolActivity",
    label: "Never fold tool activity",
    description:
      "Show thinking, tool calls and notices as their own rows in every turn instead of folding them into Process details.",
  },
] as const;
const modelSearch = [
  "Reasoning",
  "Auto thinking source",
  "Verbosity",
  "Personality",
  "Hide Thinking Blocks",
  "External thinking",
];
const status = (host: Host) =>
  host.status === "omp-missing"
    ? "omp not installed"
    : host.status === "needs-upgrade"
      ? "needs upgrade"
      : host.status;
const hostName = (host: Host) =>
  host.id === "local" && !host.label ? "This machine" : host.label;
const linkUp = (host: Host) =>
  host.status === "online" || host.status === "omp-missing";
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function Choice({
  label,
  value,
  choices,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  choices: readonly { label: string; value: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      disabled={disabled}
      style={styles.choice}
      onPress={() => {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [...choices.map((choice) => choice.label), "Cancel"],
            cancelButtonIndex: choices.length,
          },
          (index) => {
            if (index < choices.length) onChange(choices[index].value);
          },
        );
      }}
    >
      <Text style={styles.choiceText}>
        {choices.find((item) => item.value === value)?.label ?? value}
      </Text>
      <Text style={styles.dim}>⌄</Text>
    </Pressable>
  );
}
function Card({
  label,
  description,
  scope,
  children,
  compact,
}: {
  label: string;
  description?: string;
  scope?: string;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <View style={[styles.card, compact && styles.compactCard]}>
      <View style={styles.cardHeading}>
        <Text style={styles.cardTitle}>{label}</Text>
        {scope && <Text style={styles.scope}>{scope}</Text>}
      </View>
      {description && (
        <Text
          style={[styles.description, compact && styles.compactDescription]}
        >
          {description}
        </Text>
      )}
      {children}
    </View>
  );
}
function ToggleCard({
  label,
  description,
  scope,
  value,
  onChange,
  disabled,
  compact,
}: {
  label: string;
  description: string;
  scope?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <View
      style={[styles.card, compact && styles.compactCard, styles.toggleCard]}
    >
      <View style={styles.flex}>
        <View style={styles.cardHeading}>
          <Text style={[styles.cardTitle, styles.flex]}>{label}</Text>
          {scope && <Text style={styles.scope}>{scope}</Text>}
        </View>
        <Text
          style={[
            styles.description,
            compact && styles.compactDescription,
            compact && styles.compactToggleDescription,
          ]}
        >
          {description}
        </Text>
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: "#a52470", false: "#27272f" }}
      />
    </View>
  );
}
function Heading({
  title,
  description,
  compact,
}: {
  title: string;
  description?: string;
  compact?: boolean;
}) {
  return (
    <View style={[styles.heading, compact && styles.compactHeading]}>
      <Text accessibilityRole="header" style={styles.headingTitle}>
        {title}
      </Text>
      {description && <Text style={styles.subtitle}>{description}</Text>}
    </View>
  );
}
function Button({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

function RemoteCatalog({
  origin,
  host,
  onError,
}: {
  origin: string;
  host: Host;
  onError: (error: unknown) => void;
}) {
  type Models =
    operations["getModels"]["responses"][200]["content"]["application/json"];
  const [models, setModels] = useState<Models | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setModels(null);
    setError("");
    if (!linkUp(host))
      return () => {
        active = false;
      };
    void requestJson<Models>(
      origin,
      `/api/models?hostId=${encodeURIComponent(host.id)}`,
    )
      .then((data) => {
        if (!active) return;
        if (data.modelError) setError("Model catalog unavailable.");
        else setModels(data);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(
            cause instanceof KeylimeHttpError && cause.status === 501
              ? "Host upgrade required for model catalog."
              : "Could not load model catalog.",
          );
          onError(cause);
        }
      });
    return () => {
      active = false;
    };
  }, [origin, host.id, host.status, onError]);
  return (
    <Card label="Model catalog">
      {!linkUp(host) ? (
        <Text style={styles.subtitle}>
          {hostName(host)}: {status(host)}. Model catalog unavailable.
        </Text>
      ) : error ? (
        <Text style={styles.subtitle}>{error}</Text>
      ) : !models ? (
        <Text style={styles.subtitle}>Loading model catalog…</Text>
      ) : (
        <>
          <Text style={styles.subtitle}>
            Default model:{" "}
            {models.defaultModel
              ? `${models.defaultModel.provider}/${models.defaultModel.modelId}`
              : "None"}
          </Text>
          {models.modelList.length ? (
            models.modelList.map((model) => (
              <Text
                key={`${model.provider}:${model.id}`}
                style={styles.subtitle}
              >
                {model.name} · {model.provider}/{model.id}
              </Text>
            ))
          ) : (
            <Text style={styles.subtitle}>No models available.</Text>
          )}
        </>
      )}
    </Card>
  );
}

function PipelineEditor({
  origin,
  host,
  project,
  onError,
}: {
  origin: string;
  host: Host;
  project?: Project;
  onError: (error: unknown) => void;
}) {
  const [settings, setSettings] = useState<CreationSettings | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setSettings(null);
    setPipeline(null);
    setMessage("");
    if (!linkUp(host))
      return () => {
        active = false;
      };
    const params = `hostId=${encodeURIComponent(host.id)}&action=settings${project ? `&projectPath=${encodeURIComponent(project.path)}` : ""}`;
    void requestJson<WorktreeResponse>(origin, `/api/worktrees?${params}`)
      .then((data) => {
        if (!active) return;
        if (!("defaults" in data)) throw new Error("Invalid settings response");
        setSettings(data);
        setPipeline(project ? (data.override ?? data.defaults) : data.defaults);
      })
      .catch((error: unknown) => {
        if (active) {
          setMessage("Could not load workspace setup.");
          onError(error);
        }
      });
    return () => {
      active = false;
    };
  }, [origin, host.id, host.status, project?.path, onError, revision]);
  if (!linkUp(host))
    return (
      <Text style={styles.subtitle}>
        {hostName(host)}: {status(host)}. Workspace settings are unavailable.
      </Text>
    );
  if (!pipeline || !settings)
    return (
      <>
        <Text style={styles.subtitle}>
          {message || "Loading workspace settings…"}
        </Text>
        {!!message && (
          <Button
            title="Reload"
            onPress={() => setRevision((value) => value + 1)}
          />
        )}
      </>
    );
  if (project && settings.source === "paseo")
    return (
      <Text style={styles.subtitle}>
        This repo uses paseo.json for workspace setup. Edit that file to change
        its configuration.
      </Text>
    );
  const fields: { key: keyof Pipeline; label: string; description: string }[] =
    [
      {
        key: "pre",
        label: "Pre commands (one per line)",
        description: "Run before workspace creation.",
      },
      {
        key: "create",
        label: "Create commands (one per line)",
        description: "Run to create the workspace.",
      },
      {
        key: "postBlocking",
        label: "Blocking post commands (one per line)",
        description: "Run after creation before the workspace opens.",
      },
      {
        key: "postNonBlocking",
        label: "Non-blocking post commands (one per line)",
        description: "Run after creation in the background.",
      },
    ];
  const save = async () => {
    setSaving(true);
    setMessage("");
    const clean: Pipeline = {
      pre: pipeline.pre.filter((x) => x.trim()),
      create: pipeline.create.filter((x) => x.trim()),
      postBlocking: pipeline.postBlocking.filter((x) => x.trim()),
      postNonBlocking: pipeline.postNonBlocking.filter((x) => x.trim()),
    };
    const body: operations["workspaceWorktreesPost"]["requestBody"]["content"]["application/json"] =
      {
        hostId: host.id,
        action: "settings",
        input: project
          ? { projectPath: project.path, override: clean }
          : { defaults: clean },
      };
    try {
      await requestJson<unknown>(origin, "/api/worktrees", json(body));
      setMessage("Saved.");
    } catch (error) {
      setPipeline(null);
      setMessage("Save failed. Reload settings before retrying.");
      onError(error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Text style={styles.sectionTitle}>Creation commands</Text>
      {fields.map((field) => (
        <Card
          key={field.key}
          label={field.label}
          description={field.description}
        >
          <TextInput
            accessibilityLabel={field.label}
            multiline
            value={pipeline[field.key].join("\n")}
            onChangeText={(text) =>
              setPipeline({ ...pipeline, [field.key]: text.split("\n") })
            }
            style={styles.multiline}
          />
        </Card>
      ))}
      <Button
        title={saving ? "Saving…" : "Save"}
        disabled={saving}
        onPress={() => void save()}
      />
      {!!message && <Text style={styles.subtitle}>{message}</Text>}
    </>
  );
}

export function SettingsScreen({
  origin,
  hosts,
  onBack,
  onUnauthorized,
  preferences,
  onChangePreference,
}: SettingsScreenProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState(hosts);
  const [hostId, setHostId] = useState("local");
  const [native, setNative] = useState<NativeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [repoTab, setRepoTab] = useState<
    Record<string, "general" | "workspace">
  >({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [command, setCommand] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => setRows(hosts), [hosts]);
  const host = rows.find((item) => item.id === hostId);
  const fail = useCallback(
    (cause: unknown) => {
      if (cause instanceof KeylimeHttpError && cause.kind === "unauthorized")
        onUnauthorized();
    },
    [onUnauthorized],
  );
  useEffect(() => {
    if ((tab !== "models" && tab !== "safety") || hostId !== "local") return;
    let active = true;
    setNative(null);
    setError("");
    void requestJson<
      operations["getOmpSettings"]["responses"][200]["content"]["application/json"]
    >(origin, "/api/omp-settings")
      .then((data) => {
        if (active) setNative(data.settings);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError("Could not load native settings.");
          fail(cause);
        }
      });
    return () => {
      active = false;
    };
  }, [origin, tab, hostId, revision, fail]);
  useEffect(() => {
    if (tab !== "projects") return;
    let active = true;
    setHierarchy(null);
    setError("");
    if (!host || !linkUp(host))
      return () => {
        active = false;
      };
    void requestJson<Hierarchy>(
      origin,
      `/api/hierarchy?host=${encodeURIComponent(host.id)}`,
    )
      .then((data) => {
        if (active) {
          setHierarchy(data);
          setNames(
            Object.fromEntries(
              data.projects.map((project) => [
                project.id,
                project.alias ?? project.name,
              ]),
            ),
          );
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError("Could not load repos.");
          fail(cause);
        }
      });
    return () => {
      active = false;
    };
  }, [origin, tab, hostId, host?.status, revision, fail]);
  const saveNative = async (patch: Partial<NativeSettings>) => {
    if (!native || busy) return;
    setBusy(true);
    setError("");
    const body: operations["putOmpSettings"]["requestBody"]["content"]["application/json"] =
      { settings: { ...native, ...patch } };
    try {
      const result = await requestJson<
        operations["putOmpSettings"]["responses"][200]["content"]["application/json"]
      >(origin, "/api/omp-settings", json(body, "PUT"));
      setNative(result.settings);
    } catch (cause) {
      setError("Save failed. Reload settings before retrying.");
      setNative(null);
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const refreshHosts = async () => {
    try {
      setRows((await getHosts(origin)).hosts);
    } catch (cause) {
      setError("Could not refresh hosts.");
      fail(cause);
    }
  };
  const promptHost = (selected?: Host) =>
    Alert.prompt(
      selected ? "Rename host" : "Add host",
      selected
        ? "Choose a name for this host."
        : "Enter a name for the new host.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: selected ? "Rename" : "Add",
          onPress: (label) => {
            if (!label?.trim()) return;
            void (async () => {
              setBusy(true);
              setError("");
              try {
                if (selected) {
                  const body: operations["patchHosts"]["requestBody"]["content"]["application/json"] =
                    { id: selected.id, label: label.trim() };
                  await requestJson<unknown>(
                    origin,
                    "/api/hosts",
                    json(body, "PATCH"),
                  );
                } else {
                  const body: operations["postHosts"]["requestBody"]["content"]["application/json"] =
                    { label: label.trim() };
                  const result = await requestJson<
                    operations["postHosts"]["responses"][200]["content"]["application/json"]
                  >(origin, "/api/hosts", json(body));
                  setCommand(result.command);
                }
                await refreshHosts();
              } catch (cause) {
                setError(
                  "Host operation failed. Refresh hosts before retrying.",
                );
                fail(cause);
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
      "plain-text",
      selected?.label,
    );
  const saveName = async (project: Project) => {
    if (!host || busy) return;
    setBusy(true);
    setError("");
    const body: operations["workspaceHierarchyPost"]["requestBody"]["content"]["application/json"] =
      {
        host: host.id,
        input: {
          action: "updateProject",
          projectId: project.id,
          alias: names[project.id]?.trim() || null,
        },
      };
    try {
      const result = await requestJson<Hierarchy>(
        origin,
        "/api/hierarchy",
        json(body),
      );
      setHierarchy(result);
    } catch (cause) {
      setError("Could not save repo name. Reload before retrying.");
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const hostChoice = host && (
    <Card
      label="Settings host"
      description="These settings apply only to the selected host."
    >
      <Choice
        label="Settings host"
        value={hostId}
        choices={rows.map((item) => ({
          value: item.id,
          label: `${hostName(item)} (${status(item)})`,
        }))}
        onChange={setHostId}
      />
    </Card>
  );
  const search = query.trim().toLowerCase();
  const searchItems = [
    ...categories.map((item) => ({
      tab: item.id,
      label: item.label,
      description: item.description,
    })),
    ...prefs
      .filter((p) => preferences?.[p.key] !== undefined && onChangePreference)
      .map((item) => ({
        tab: "general" as Tab,
        label: item.label,
        description: item.description,
      })),
    ...modelSearch.map((label) => ({
      tab: "models" as Tab,
      label,
      description: "AI Model Defaults",
    })),
  ].filter((item) =>
    `${item.label} ${item.description}`.toLowerCase().includes(search),
  );
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.headerText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.searchBox}>
          <Text style={styles.dim}>⌕</Text>
          <TextInput
            accessibilityLabel="Search settings"
            value={query}
            onChangeText={setQuery}
            placeholder="Search settings"
            placeholderTextColor="#77777e"
            style={styles.searchInput}
            returnKeyType="search"
          />
          {!!query && (
            <Pressable
              accessibilityLabel="Clear search"
              onPress={() => setQuery("")}
            >
              <Text style={styles.dim}>×</Text>
            </Pressable>
          )}
        </View>
        <Pressable accessibilityLabel="Close settings" onPress={onBack}>
          <Text style={styles.close}>×</Text>
        </Pressable>
      </View>
      {search ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.searchResults}
        >
          {searchItems.length ? (
            searchItems.map((item, index) => (
              <Pressable
                key={`${item.tab}:${item.label}:${index}`}
                style={styles.searchResult}
                onPress={() => {
                  setTab(item.tab);
                  setQuery("");
                  Keyboard.dismiss();
                }}
              >
                <Text style={styles.cardTitle}>{item.label}</Text>
                <Text style={styles.description}>{item.description}</Text>
              </Pressable>
            ))
          ) : (
            <Text style={styles.subtitle}>
              No settings match “{query.trim()}”.
            </Text>
          )}
        </ScrollView>
      ) : (
        <>
          <View style={styles.tabsBorder}>
            <ScrollView
              key={tab}
              contentOffset={{
                x:
                  153 *
                  Math.max(
                    0,
                    categories.findIndex((item) => item.id === tab),
                  ),
                y: 0,
              }}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tabs}
            >
              {categories.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab === item.id }}
                  onPress={() => {
                    setTab(item.id);
                    setError("");
                  }}
                  style={[styles.tab, tab === item.id && styles.tabSelected]}
                >
                  <Text style={styles.tabIcon}>{item.icon}</Text>
                  <View>
                    <Text style={styles.tabLabel}>{item.label}</Text>
                    <Text style={styles.tabDescription} numberOfLines={1}>
                      {item.description}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[
              styles.content,
              tab === "general" && styles.generalContent,
            ]}
          >
            {!!error && (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            )}
            {!!error &&
              (tab === "models" || tab === "safety" || tab === "projects") && (
                <Button
                  title="Reload"
                  onPress={() => setRevision((value) => value + 1)}
                />
              )}
            {tab === "general" && (
              <>
                <Heading
                  title="Interface & Behavior"
                  description="Controls interface presentation, notification sounds, and execution submission mode."
                  compact
                />
                {prefs.map((item) => {
                  const value = preferences?.[item.key];
                  if (value === undefined || !onChangePreference) return null;
                  if (item.key === "expandThinkingBlocks")
                    return (
                      <Card
                        key={item.key}
                        label={item.label}
                        description={item.description}
                        scope="UI"
                        compact
                      >
                        <Choice
                          label={item.label}
                          value={String(value)}
                          choices={[
                            { label: "Off", value: "off" },
                            { label: "Latest", value: "latest" },
                            { label: "All", value: "all" },
                          ]}
                          onChange={(next) =>
                            onChangePreference(
                              item.key,
                              next as "off" | "latest" | "all",
                            )
                          }
                        />
                      </Card>
                    );
                  return (
                    <ToggleCard
                      key={item.key}
                      label={item.label}
                      description={item.description}
                      scope="UI"
                      compact
                      value={value === true}
                      onChange={(next) => onChangePreference(item.key, next)}
                    />
                  );
                })}
                {(!preferences ||
                  !onChangePreference ||
                  !prefs.some((p) => preferences[p.key] !== undefined)) && (
                  <Text style={styles.subtitle}>
                    No interface preferences are available in this app yet.
                  </Text>
                )}
              </>
            )}
            {(tab === "models" || tab === "safety") && (
              <>
                {hostChoice}
                {hostId !== "local" ? (
                  <Text style={styles.subtitle}>
                    Native OMP settings can only be edited on this machine.
                    Remote host configuration is unavailable here.
                  </Text>
                ) : native ? (
                  tab === "models" ? (
                    <>
                      <Heading
                        title="AI Model Defaults"
                        description="Configure default reasoning effort, response verbosity, personality tone, and thinking display."
                      />
                      <Card
                        label="Reasoning"
                        description="Default effort level for thinking-capable models."
                        scope="Native OMP"
                      >
                        <Choice
                          disabled={busy}
                          label="Reasoning"
                          value={native.defaultThinkingLevel ?? "high"}
                          choices={[
                            "auto",
                            "minimal",
                            "low",
                            "medium",
                            "high",
                            "xhigh",
                            "max",
                          ].map((value) => ({ value, label: value }))}
                          onChange={(value) =>
                            void saveNative({
                              defaultThinkingLevel:
                                value as NativeSettings["defaultThinkingLevel"],
                            })
                          }
                        />
                      </Card>
                      {native.defaultThinkingLevel === "auto" && (
                        <Card
                          label="Auto thinking source"
                          description="Choose how automatic reasoning effort is determined."
                          scope="Native OMP"
                        >
                          <Choice
                            disabled={busy}
                            label="Auto thinking source"
                            value={
                              native.providers?.autoThinkingSource ??
                              "classifier"
                            }
                            choices={[
                              { value: "classifier", label: "Classifier" },
                              { value: "vendor", label: "Vendor" },
                            ]}
                            onChange={(value) =>
                              void saveNative({
                                providers: {
                                  ...native.providers,
                                  autoThinkingSource: value as
                                    "classifier" | "vendor",
                                },
                              })
                            }
                          />
                        </Card>
                      )}
                      <Card
                        label="Verbosity"
                        description="Response detail level for supporting providers."
                        scope="Native OMP"
                      >
                        <Choice
                          disabled={busy}
                          label="Verbosity"
                          value={native.textVerbosity ?? "medium"}
                          choices={["low", "medium", "high"].map((value) => ({
                            value,
                            label: value,
                          }))}
                          onChange={(value) =>
                            void saveNative({
                              textVerbosity:
                                value as NativeSettings["textVerbosity"],
                            })
                          }
                        />
                      </Card>
                      <Card
                        label="Personality"
                        description="Style included in OMP's system prompt."
                        scope="Native OMP"
                      >
                        <Choice
                          disabled={busy}
                          label="Personality"
                          value={native.personality ?? "default"}
                          choices={[
                            "default",
                            "friendly",
                            "pragmatic",
                            "none",
                          ].map((value) => ({ value, label: value }))}
                          onChange={(value) =>
                            void saveNative({
                              personality:
                                value as NativeSettings["personality"],
                            })
                          }
                        />
                      </Card>
                      <ToggleCard
                        disabled={busy}
                        label="Hide Thinking Blocks"
                        description="Hide model reasoning from output view."
                        scope="Native OMP"
                        value={native.hideThinkingBlock ?? false}
                        onChange={(value) =>
                          void saveNative({ hideThinkingBlock: value })
                        }
                      />
                      <ToggleCard
                        disabled={busy}
                        label="External thinking"
                        description="Private scratchpad reasoning via think tool."
                        scope="Native OMP"
                        value={native.externalThinking ?? false}
                        onChange={(value) =>
                          void saveNative({ externalThinking: value })
                        }
                      />
                    </>
                  ) : (
                    <>
                      <Heading
                        title="Safety & Approvals"
                        description="Configure tool safety and approval rules."
                      />
                      <Card
                        label="Approval mode"
                        description="Choose when tool calls require approval."
                        scope="Native OMP"
                      >
                        <Choice
                          disabled={busy}
                          label="Approval mode"
                          value={native.tools?.approvalMode ?? "yolo"}
                          choices={[
                            { value: "always-ask", label: "Always ask" },
                            { value: "write", label: "Ask for writes" },
                            { value: "yolo", label: "YOLO" },
                          ]}
                          onChange={(value) =>
                            void saveNative({
                              tools: {
                                ...native.tools,
                                approvalMode: value as
                                  "always-ask" | "write" | "yolo",
                              },
                            })
                          }
                        />
                      </Card>
                    </>
                  )
                ) : (
                  !error && (
                    <Text style={styles.subtitle}>
                      Loading native settings…
                    </Text>
                  )
                )}
              </>
            )}
            {tab === "models" && host && hostId !== "local" && (
              <RemoteCatalog
                key={host.id}
                origin={origin}
                host={host}
                onError={fail}
              />
            )}
            {tab === "hosts" && (
              <>
                <View style={styles.headingRow}>
                  <View style={styles.flex}>
                    <Heading
                      title="Linked hosts"
                      description="Run sessions on other machines. Each one runs keylime host and connects back to this server."
                    />
                  </View>
                  <Button
                    title="+ Add host"
                    disabled={busy}
                    onPress={() => promptHost()}
                  />
                </View>
                {!!command && (
                  <Card
                    label="Connect host"
                    description="Run this command on the host. It contains a credential; keep it private."
                  >
                    <Text selectable style={styles.command}>
                      {command}
                    </Text>
                    <Button title="Done" onPress={() => setCommand("")} />
                  </Card>
                )}
                {rows.map((item) => (
                  <View key={item.id} style={styles.hostCard}>
                    <View style={styles.flex}>
                      <Text style={styles.cardTitle}>{hostName(item)}</Text>
                      <Text style={styles.description}>● {status(item)}</Text>
                      <Text style={styles.dim}>
                        {item.platform ?? "unknown platform"} · link protocol v
                        {item.hostVersion ?? item.serverVersion}
                      </Text>
                    </View>
                    <Button
                      title="Rename"
                      disabled={busy}
                      onPress={() => promptHost(item)}
                    />
                  </View>
                ))}
                {!rows.some((item) => item.id !== "local") && (
                  <Text style={styles.dim}>No linked hosts yet.</Text>
                )}
                <Heading title="Host creation defaults" />
                {host && (
                  <>
                    <Choice
                      label="Host"
                      value={hostId}
                      choices={rows.map((item) => ({
                        value: item.id,
                        label: `${hostName(item)} (${status(item)})`,
                      }))}
                      onChange={setHostId}
                    />
                    <PipelineEditor
                      key={host.id}
                      origin={origin}
                      host={host}
                      onError={fail}
                    />
                  </>
                )}
              </>
            )}
            {tab === "projects" && (
              <>
                {hostChoice}
                <Heading title="Repos" />
                {!host || !linkUp(host) ? (
                  <Text style={styles.subtitle}>
                    {host
                      ? `${hostName(host)}: ${status(host)}. Repos are unavailable.`
                      : "Host unavailable."}
                  </Text>
                ) : hierarchy ? (
                  hierarchy.projects.length ? (
                    hierarchy.projects.map((project) => (
                      <View key={project.id} style={styles.repo}>
                        <Text style={styles.sectionTitle}>
                          {project.alias ?? project.name}
                        </Text>
                        <Text style={styles.dim}>{project.path}</Text>
                        <View style={styles.repoTabs}>
                          <Button
                            title="General"
                            onPress={() =>
                              setRepoTab({
                                ...repoTab,
                                [project.id]: "general",
                              })
                            }
                          />
                          <Button
                            title="Workspace setup"
                            onPress={() =>
                              setRepoTab({
                                ...repoTab,
                                [project.id]: "workspace",
                              })
                            }
                          />
                        </View>
                        {repoTab[project.id] === "workspace" ? (
                          <>
                            <Heading
                              title="Workspace setup"
                              description="Configure workspace creation for this repo."
                            />
                            <PipelineEditor
                              key={`${host.id}:${project.id}`}
                              origin={origin}
                              host={host}
                              project={project}
                              onError={fail}
                            />
                          </>
                        ) : (
                          <>
                            <Heading
                              title="General"
                              description="Set how this repo appears in the sidebar."
                            />
                            <Card
                              label="Display name"
                              description="Choose the name shown for this repo. Clear it to use the directory name."
                            >
                              <TextInput
                                accessibilityLabel={`Display name for ${project.name}`}
                                value={names[project.id] ?? ""}
                                onChangeText={(value) =>
                                  setNames({ ...names, [project.id]: value })
                                }
                                onSubmitEditing={() => void saveName(project)}
                                style={styles.input}
                              />
                              <Button
                                title="Save"
                                disabled={busy}
                                onPress={() => void saveName(project)}
                              />
                            </Card>
                          </>
                        )}
                      </View>
                    ))
                  ) : (
                    <Text style={styles.subtitle}>No registered repos.</Text>
                  )
                ) : (
                  !error && <Text style={styles.subtitle}>Loading repos…</Text>
                )}
              </>
            )}
            {!["general", "safety", "models", "hosts", "projects"].includes(
              tab,
            ) && (
              <>
                <Heading
                  title={
                    categories.find((item) => item.id === tab)?.label ??
                    "Settings"
                  }
                />
                <Text style={styles.subtitle}>
                  These settings are not available in the native app yet.
                </Text>
              </>
            )}
          </ScrollView>
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1 },
  header: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.panel,
  },
  headerText: { color: theme.muted, fontSize: 14 },
  headerTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 0,
  },
  close: { color: theme.muted, fontSize: 24 },
  searchBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 9,
    height: 34,
    backgroundColor: theme.background,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    color: theme.text,
    fontSize: 13,
  },
  tabsBorder: {
    borderBottomWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.panel,
  },
  tabs: { paddingHorizontal: 12, paddingVertical: 7, gap: 3 },
  tab: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    width: 150,
  },
  tabSelected: { backgroundColor: "#1b1b21" },
  tabIcon: { color: theme.text, fontSize: 15 },
  tabLabel: { color: theme.text, fontSize: 13, fontWeight: "600" },
  tabDescription: {
    color: theme.muted,
    fontSize: 11,
    marginTop: 2,
    maxWidth: 120,
  },
  content: {
    paddingHorizontal: 32,
    paddingTop: 34,
    paddingBottom: 60,
    gap: 20,
  },
  generalContent: { paddingTop: 16 },
  compactHeading: { gap: 4, marginBottom: 4 },
  heading: { gap: 9, marginBottom: 14 },
  headingTitle: { color: theme.text, fontSize: 23, fontWeight: "700" },
  subtitle: { color: theme.muted, fontSize: 13, lineHeight: 19 },
  sectionTitle: { color: theme.text, fontSize: 16, fontWeight: "600" },
  card: {
    backgroundColor: theme.panel,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 20,
    gap: 10,
  },
  toggleCard: { flexDirection: "row", alignItems: "center", gap: 16 },
  compactCard: { paddingVertical: 16, paddingHorizontal: 22, gap: 8 },
  compactDescription: { fontSize: 12, lineHeight: 17.4 },
  compactToggleDescription: { marginTop: 4 },
  cardHeading: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  cardTitle: { color: theme.text, fontSize: 14, fontWeight: "600" },
  description: { color: theme.muted, fontSize: 13, lineHeight: 21 },
  scope: {
    color: theme.muted,
    backgroundColor: "#17171b",
    fontSize: 11,
    paddingHorizontal: 6,
    paddingVertical: 3,
    overflow: "hidden",
    borderRadius: 4,
  },
  choice: {
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    backgroundColor: theme.background,
    minHeight: 36,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  choiceText: { color: theme.text, fontSize: 13, flexShrink: 1 },
  dim: { color: "#9999a1", fontSize: 12, lineHeight: 18 },
  button: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignSelf: "flex-start",
    backgroundColor: theme.panel,
  },
  buttonText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  headingRow: { flexDirection: "row", gap: 12, alignItems: "center" },
  hostCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    backgroundColor: theme.panel,
  },
  error: { color: "#ff8b95", fontSize: 13 },
  input: {
    color: theme.text,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
  },
  multiline: {
    color: theme.text,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    padding: 10,
    fontSize: 13,
    minHeight: 80,
    textAlignVertical: "top",
  },
  command: { color: theme.text, fontSize: 12, lineHeight: 18 },
  repo: { gap: 16 },
  repoTabs: {
    flexDirection: "row",
    gap: 8,
    borderBottomWidth: 1,
    borderColor: theme.border,
    paddingBottom: 8,
  },
  searchResults: { padding: 16, gap: 10 },
  searchResult: {
    padding: 16,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 10,
    gap: 5,
  },
});
