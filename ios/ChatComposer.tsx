import { useMemo, useState } from "react";
import { File, Paths } from "expo-file-system";
import { selectableThinkingLevels } from "../lib/thinking-levels";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import type { operations } from "./generated/web-http";
import type { ModelActivity } from "../lib/model-activity";
import { ComposerActivity } from "./ComposerActivity";
import { NativeReasoningSlider } from "./NativeReasoningSlider";

type ModelCatalog =
  operations["getModels"]["responses"][200]["content"]["application/json"];
type ChatRole =
  operations["getChatRoles"]["responses"][200]["content"]["application/json"]["roles"][number];

type ModelSelection = { provider: string; modelId: string };

export type ChatComposerProps = {
  children?: React.ReactNode;
  canSendAttachment?: boolean;
  moreActions?: React.ReactNode;
  selection?: { start: number; end: number };
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  onComposerKey?: (key: string) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  modelActivity?: ModelActivity;
  disabled?: boolean;
  submissionBlocked?: boolean;
  favoriteScope: string;
  catalog: ModelCatalog | null;
  catalogLoading?: boolean;
  catalogError?: string | null;
  pickerError?: string;
  roles: readonly ChatRole[];
  selectedModel: ModelSelection | null;
  onSelectModel: (provider: string, modelId: string) => void;
  onSelectRole: (role: ChatRole) => void;
  thinkingLevel: string;
  availableThinkingLevels: string[] | null;
  onThinkingLevelChange: (level: string) => void;
  planEnabled: boolean;
  planUnknown: boolean;
  planBusy: boolean;
  prewalk: "off" | "suggest" | "on" | null;
  onPlanChange: (enabled: boolean) => void;
  onPrewalkChange: (mode: "off" | "suggest" | "on") => void;
  onRefreshModels?: () => void;
};

const roleNames: Record<string, string> = {
  default: "Default",
  smol: "Fast",
  slow: "Thinking",
};

function readFavorites(): Record<string, string[]> {
  try {
    const file = new File(Paths.document, "native-favorite-models.json");
    const value: unknown = file.exists ? JSON.parse(file.textSync()) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, models]) => Array.isArray(models))
        .map(([scope, models]) => [
          scope,
          (models as unknown[]).filter(
            (item): item is string => typeof item === "string",
          ),
        ]),
    );
  } catch {
    return {};
  }
}

export function ChatComposer({
  children,
  canSendAttachment,
  moreActions,
  selection,
  onSelectionChange,
  onComposerKey,
  draft,
  onDraftChange,
  onSend,
  onStop,
  running,
  modelActivity,
  disabled = false,
  submissionBlocked = false,
  favoriteScope,
  catalog,
  catalogLoading = false,
  catalogError,
  pickerError,
  roles,
  selectedModel,
  onSelectModel,
  onSelectRole,
  thinkingLevel,
  availableThinkingLevels,
  onThinkingLevelChange,
  planEnabled,
  planUnknown,
  planBusy,
  prewalk,
  onPlanChange,
  onPrewalkChange,
  onRefreshModels,
}: ChatComposerProps) {
  const dark = useColorScheme() !== "light";
  const colors = dark
    ? {
        background: "#000000",
        panel: "#0A0A0C",
        text: "#F5F5F5",
        muted: "#C9C9D1",
        dim: "#929299",
        border: "#29292E",
        hover: "#17171B",
        error: "#F0A3A0",
        errorBg: "#160C0D",
        errorBorder: "#704D50",
      }
    : {
        background: "#FAF9F6",
        panel: "#F2F0EA",
        text: "#221A14",
        muted: "#554C45",
        dim: "#746D66",
        border: "#D6CFC1",
        hover: "#E8E4DC",
        error: "#9E3434",
        errorBg: "#FCEDED",
        errorBorder: "#D8A6A4",
      };
  const [collapsedSearch, setCollapsedSearch] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [favoriteScopes, setFavoriteScopes] = useState(readFavorites);
  const favorites = new Set(favoriteScopes[favoriteScope] ?? []);
  const [focused, setFocused] = useState(false);
  const models = catalog?.modelList ?? [];
  const search = query.trim().toLocaleLowerCase();
  const expanded = search ? collapsedSearch !== query : moreOpen;
  const matchingModels = useMemo(
    () =>
      models
        .filter((model) =>
          [model.name, model.id, model.provider].some((value) =>
            value.toLocaleLowerCase().includes(search),
          ),
        )
        .sort(
          (a, b) =>
            (a.name || a.id).localeCompare(b.name || b.id) ||
            a.provider.localeCompare(b.provider) ||
            a.id.localeCompare(b.id),
        ),
    [models, search],
  );
  const matchingRoles = roles.filter((role) =>
    [
      roleNames[role.id] ?? role.id,
      role.id,
      role.provider,
      role.modelId,
      role.modelName,
      role.thinkingLevel,
      role.effectiveThinkingLevel,
    ].some((value) => value?.toLocaleLowerCase().includes(search)),
  );
  const favoriteModels = matchingModels.filter((model) =>
    favorites.has(`${model.provider}:${model.id}`),
  );
  const otherModels = matchingModels.filter(
    (model) => !favorites.has(`${model.provider}:${model.id}`),
  );
  const providers = [
    ...new Set(otherModels.map((model) => model.provider)),
  ].sort((a, b) =>
    a === selectedModel?.provider
      ? -1
      : b === selectedModel?.provider
        ? 1
        : a.localeCompare(b),
  );
  const levels = selectableThinkingLevels(availableThinkingLevels);
  const toggleFavorite = (key: string) => {
    const next = new Set(favorites);
    if (!next.delete(key)) next.add(key);
    const scopes = { ...favoriteScopes, [favoriteScope]: [...next] };
    setFavoriteScopes(scopes);
    try {
      new File(Paths.document, "native-favorite-models.json").writeSync(
        JSON.stringify(scopes),
      );
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  };
  const renderModel = (
    model: ModelCatalog["modelList"][number],
    showProvider = false,
  ) => {
    const key = `${model.provider}:${model.id}`;
    const favorite = favorites.has(key);
    const selected =
      selectedModel?.provider === model.provider &&
      selectedModel.modelId === model.id;
    return (
      <View key={key} style={styles.modelRow}>
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{
            checked: selected,
            disabled: disabled || running,
          }}
          disabled={disabled || running}
          onPress={() => {
            onSelectModel(model.provider, model.id);
            closePicker();
          }}
          style={[styles.row, styles.modelChoice]}
        >
          <Text style={{ color: colors.muted }}>{selected ? "✓" : "  "}</Text>
          <Text
            numberOfLines={1}
            style={[styles.rowText, { color: colors.muted }]}
          >
            {model.name || model.id}
          </Text>
          {showProvider && (
            <Text
              numberOfLines={1}
              style={[styles.rowMeta, { color: colors.dim }]}
            >
              {model.provider}
            </Text>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${favorite ? "Remove" : "Add"} ${model.name || model.id} (${model.provider}) ${favorite ? "from" : "to"} favorites`}
          accessibilityState={{ selected: favorite }}
          onPress={() => toggleFavorite(key)}
          style={styles.star}
        >
          <Text
            style={{ color: favorite ? colors.text : colors.dim, fontSize: 18 }}
          >
            {favorite ? "★" : "☆"}
          </Text>
        </Pressable>
      </View>
    );
  };
  const selectedName = models.find(
    (model) =>
      model.provider === selectedModel?.provider &&
      model.id === selectedModel.modelId,
  )?.name;
  const modelLabel =
    selectedName ||
    selectedModel?.modelId ||
    (catalogLoading
      ? "Loading models…"
      : models.length
        ? "Select model"
        : "No models");
  const error = catalogError || catalog?.modelError;
  const canSend =
    !disabled &&
    !submissionBlocked &&
    (draft.trim().length > 0 || canSendAttachment === true);

  const closePicker = () => {
    setPickerOpen(false);
    setQuery("");
    setMoreOpen(false);
    setCollapsedSearch(null);
    setProvider(null);
    Keyboard.dismiss();
  };
  const openPicker = () => {
    Keyboard.dismiss();
    setPickerOpen(true);
  };

  return (
    <View style={styles.container}>
      {!!error && (
        <View
          accessibilityRole="alert"
          style={[
            styles.error,
            {
              backgroundColor: colors.errorBg,
              borderColor: colors.errorBorder,
            },
          ]}
        >
          <Text style={[styles.errorIcon, { color: colors.error }]}>⚠</Text>
          <View style={styles.errorContent}>
            <Text style={[styles.errorTitle, { color: colors.error }]}>
              Model error
            </Text>
            <Text style={[styles.errorText, { color: colors.error }]}>
              {error}
            </Text>
          </View>
        </View>
      )}
      <View
        // Keep the native container stable when focus adds a shadow.
        collapsable={false}
        style={[
          styles.composer,
          {
            backgroundColor: colors.background,
            borderColor: focused ? "#A94B80" : colors.border,
          },
          focused && {
            shadowColor: dark ? "#EC5BAB" : "#A62972",
            shadowOpacity: 0.28,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 0 },
          },
        ]}
      >
        <TextInput
          accessibilityLabel="Message"
          multiline
          value={draft}
          selection={selection}
          onSelectionChange={(event) =>
            onSelectionChange?.(event.nativeEvent.selection)
          }
          onKeyPress={(event) => onComposerKey?.(event.nativeEvent.key)}
          onChangeText={onDraftChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Message... Type / for commands, @ for files"
          placeholderTextColor={colors.dim}
          style={[styles.input, { color: colors.text }]}
          textAlignVertical="top"
        />
        {children}
        <View style={[styles.toolbar, { borderColor: colors.border }]}>
          {moreActions}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Models: ${modelLabel}`}
            onPress={openPicker}
            style={styles.modelButton}
          >
            <Text
              accessibilityLabel={`Reasoning: ${thinkingLevel}`}
              style={[styles.modelIcon, { color: colors.muted }]}
            >
              ◉
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.modelLabel, { color: colors.muted }]}
            >
              {modelLabel}
            </Text>
            <View
              accessibilityElementsHidden
              style={[styles.chevron, { borderColor: colors.dim }]}
            />
          </Pressable>
          <View style={styles.spacer} />
          <ComposerActivity
            activity={modelActivity}
            color={colors.muted}
            accent={dark ? "#EC5BAB" : "#A62972"}
          />
          {running && !canSend ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop"
              onPress={onStop}
              style={[styles.send, { backgroundColor: colors.hover }]}
            >
              <Text style={[styles.sendIcon, { color: colors.text }]}>■</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={onSend}
              style={[
                styles.send,
                { backgroundColor: canSend ? "#EC5BAB" : colors.hover },
              ]}
            >
              <Text
                style={[
                  styles.sendIcon,
                  { color: canSend ? "#000000" : colors.dim },
                ]}
              >
                ➜
              </Text>
            </Pressable>
          )}
        </View>
      </View>
      <Modal
        transparent
        visible={pickerOpen}
        animationType="none"
        onRequestClose={closePicker}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modal}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close models"
            onPress={closePicker}
            style={styles.backdrop}
          />
          <View
            accessibilityViewIsModal
            style={[
              styles.sheet,
              { backgroundColor: colors.panel, borderColor: colors.border },
            ]}
          >
            <View style={[styles.sheetHeader, { borderColor: colors.border }]}>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>
                ▣ Models
              </Text>
              <Text style={[styles.count, { color: colors.dim }]}>
                {catalogLoading ? "Loading…" : catalog ? models.length : ""}
              </Text>
            </View>
            <View
              style={[
                styles.search,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                },
              ]}
            >
              <View pointerEvents="none" style={styles.searchIcon}>
                <View
                  style={[styles.searchCircle, { borderColor: colors.dim }]}
                />
                <View
                  style={[styles.searchHandle, { backgroundColor: colors.dim }]}
                />
              </View>
              <TextInput
                accessibilityLabel="Search models"
                value={query}
                onChangeText={(value) => {
                  setQuery(value);
                  setCollapsedSearch(null);
                  setProvider(null);
                }}
                placeholder="Search models..."
                placeholderTextColor={colors.dim}
                autoCorrect={false}
                returnKeyType="search"
                style={[styles.searchInput, { color: colors.text }]}
              />
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.list}>
              {!!error && (
                <Text
                  accessibilityRole="alert"
                  style={[styles.message, { color: colors.error }]}
                >
                  {error}
                </Text>
              )}
              {!!pickerError && (
                <Text
                  accessibilityRole="alert"
                  style={[styles.message, { color: colors.error }]}
                >
                  {pickerError}
                </Text>
              )}
              {catalogLoading && !catalog && (
                <Text style={[styles.message, { color: colors.dim }]}>
                  Loading models…
                </Text>
              )}
              {matchingRoles.length > 0 && (
                <Text style={[styles.groupLabel, { color: colors.dim }]}>
                  ROLES
                </Text>
              )}
              {matchingRoles.map((role) => {
                const unavailable =
                  role.id !== "default" && (!role.provider || !role.modelId);
                return (
                  <Pressable
                    key={role.id}
                    accessibilityRole="button"
                    accessibilityState={{
                      disabled: disabled || running || unavailable,
                    }}
                    disabled={disabled || running || unavailable}
                    onPress={() => {
                      onSelectRole(role);
                      closePicker();
                    }}
                    style={styles.row}
                  >
                    <Text style={[styles.rowText, { color: colors.muted }]}>
                      {roleNames[role.id] ?? role.id}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[styles.rowMeta, { color: colors.dim }]}
                    >
                      {role.modelId
                        ? `${role.modelName || role.modelId} · ${role.effectiveThinkingLevel ?? "Unspecified"}`
                        : "Unspecified"}
                    </Text>
                  </Pressable>
                );
              })}
              {favoriteModels.length > 0 && (
                <View accessibilityLabel="Favorite models">
                  <Text style={[styles.groupLabel, { color: colors.dim }]}>
                    FAVORITES
                  </Text>
                  {favoriteModels.map((model) => renderModel(model, true))}
                </View>
              )}
              {(otherModels.length > 0 || onRefreshModels) && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    onPress={() => {
                      if (search) setCollapsedSearch(expanded ? query : null);
                      else setMoreOpen(!expanded);
                      setProvider(null);
                    }}
                    style={styles.row}
                  >
                    <Text style={[styles.more, { color: colors.muted }]}>
                      {expanded ? "⌄" : "›"} More...
                    </Text>
                  </Pressable>
                  {expanded && (
                    <>
                      {!!onRefreshModels && (
                        <Pressable
                          accessibilityRole="button"
                          disabled={catalogLoading}
                          onPress={onRefreshModels}
                          style={styles.row}
                        >
                          <Text
                            style={[styles.rowText, { color: colors.muted }]}
                          >
                            {catalogLoading
                              ? "Loading models…"
                              : "↻  Refresh models"}
                          </Text>
                        </Pressable>
                      )}
                      {!search &&
                        providers.length > 1 &&
                        !provider &&
                        providers.map((name) => (
                          <Pressable
                            accessibilityRole="button"
                            key={name}
                            onPress={() => setProvider(name)}
                            style={styles.row}
                          >
                            <Text
                              style={[styles.rowText, { color: colors.muted }]}
                            >
                              {name}
                            </Text>
                            <Text style={{ color: colors.dim }}>›</Text>
                          </Pressable>
                        ))}
                      {!!provider && (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => setProvider(null)}
                          style={styles.row}
                        >
                          <Text
                            style={[styles.rowText, { color: colors.muted }]}
                          >
                            ‹ {provider}
                          </Text>
                        </Pressable>
                      )}
                      {(!!search || providers.length <= 1 || !!provider) &&
                        otherModels
                          .filter(
                            (model) => !provider || model.provider === provider,
                          )
                          .map((model) => renderModel(model, !!search))}
                    </>
                  )}
                </>
              )}
              {!!search && !matchingModels.length && !matchingRoles.length && (
                <Text style={[styles.message, { color: colors.dim }]}>
                  No matching models
                </Text>
              )}
            </ScrollView>
            <NativeReasoningSlider
              levels={levels}
              value={thinkingLevel}
              disabled={disabled || running}
              dim={colors.dim}
              border={colors.border}
              accent={dark ? "#EC5BAB" : "#A62972"}
              planEnabled={planEnabled}
              planUnknown={planUnknown}
              prewalk={prewalk}
              planDisabled={disabled || planUnknown || planBusy}
              onPlanChange={onPlanChange}
              onPrewalkChange={onPrewalkChange}
              onChange={onThinkingLevelChange}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 16, gap: 8 },
  error: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 8,
  },
  errorIcon: { fontSize: 16 },
  errorContent: { flex: 1 },
  errorTitle: { fontSize: 12, fontWeight: "600" },
  errorText: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  composer: {
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  input: {
    fontSize: 14,
    lineHeight: 20,
    minHeight: 37,
    maxHeight: 160,
    paddingVertical: 7,
    paddingHorizontal: 0,
  },
  toolbar: {
    minHeight: 51,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
  },
  modelButton: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    flexShrink: 1,
    gap: 5,
  },
  modelIcon: { fontSize: 16 },
  modelLabel: { fontSize: 12, flexShrink: 1 },
  chevron: {
    width: 7,
    height: 7,
    borderRightWidth: 1.2,
    borderBottomWidth: 1.2,
    marginTop: -3,
    transform: [{ rotate: "45deg" }],
  },
  spacer: { flex: 1 },
  send: {
    width: 36,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  sendIcon: { fontSize: 18, fontWeight: "600" },
  modal: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  sheet: {
    marginHorizontal: 8,
    marginBottom: 40,
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
    maxHeight: "72%",
    minHeight: 240,
  },
  sheetHeader: {
    minHeight: 30,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sheetTitle: { fontSize: 12, fontWeight: "600" },
  count: { fontSize: 11 },
  search: {
    height: 34,
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: 8,
    marginVertical: 8,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchInput: { flex: 1, height: "100%", padding: 0, fontSize: 13 },
  searchIcon: { width: 14, height: 14 },
  searchCircle: {
    position: "absolute",
    left: 1,
    top: 1,
    width: 9,
    height: 9,
    borderWidth: 1.5,
    borderRadius: 5,
  },
  searchHandle: {
    position: "absolute",
    left: 9,
    top: 9,
    width: 5,
    height: 1.5,
    transform: [{ rotate: "45deg" }],
  },
  list: { flexGrow: 0 },
  groupLabel: {
    fontSize: 11,
    fontWeight: "600",
    paddingHorizontal: 12,
    paddingTop: 7,
    paddingBottom: 4,
  },
  row: {
    minHeight: 34,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  modelRow: { flexDirection: "row", alignItems: "center" },
  modelChoice: { flex: 1, justifyContent: "flex-start" },
  star: {
    width: 44,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { fontSize: 13, flexShrink: 1 },
  rowMeta: { fontSize: 11, flexShrink: 1, textAlign: "right" },
  more: { fontSize: 13, fontWeight: "600" },
  message: { fontSize: 12, padding: 12 },
});
