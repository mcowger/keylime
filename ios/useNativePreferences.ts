import { File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import type { SettingsPreferences } from "./SettingsScreen";

const defaults: Required<SettingsPreferences> = {
  keepToolCallsCollapsed: true,
  expandThinkingBlocks: "off",
  hideToolActivityWhileWorking: true,
  showToolCallsOutsideProcessDetails: false,
  neverFoldToolActivity: false,
};

type Snapshot = {
  preferences: Required<SettingsPreferences>;
  loaded: boolean;
  error: string | null;
};
let snapshot: Snapshot | undefined;
const listeners = new Set<() => void>();

function load(): Snapshot {
  try {
    const storage = new File(Paths.document, "native-preferences.json");
    const raw: unknown = storage.exists ? JSON.parse(storage.textSync()) : {};
    const data =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const preferences = { ...defaults };
    for (const key of [
      "keepToolCallsCollapsed",
      "hideToolActivityWhileWorking",
      "showToolCallsOutsideProcessDetails",
      "neverFoldToolActivity",
    ] as const) {
      if (typeof data[key] === "boolean") preferences[key] = data[key];
    }
    if (
      data.expandThinkingBlocks === "off" ||
      data.expandThinkingBlocks === "latest" ||
      data.expandThinkingBlocks === "all"
    )
      preferences.expandThinkingBlocks = data.expandThinkingBlocks;
    return { preferences, loaded: true, error: null };
  } catch (error) {
    return {
      preferences: { ...defaults },
      loaded: true,
      error:
        error instanceof Error ? error.message : "Could not load preferences",
    };
  }
}

function getSnapshot(): Snapshot {
  return (snapshot ??= load());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function onChangePreference(
  key: keyof SettingsPreferences,
  value: SettingsPreferences[keyof SettingsPreferences],
) {
  if (
    key === "expandThinkingBlocks"
      ? value !== "off" && value !== "latest" && value !== "all"
      : typeof value !== "boolean"
  )
    return;
  const current = getSnapshot();
  const preferences = {
    ...current.preferences,
    [key]: value,
  } as Required<SettingsPreferences>;
  try {
    new File(Paths.document, "native-preferences.json").writeSync(
      JSON.stringify(preferences),
    );
    snapshot = { preferences, loaded: true, error: null };
  } catch (cause) {
    snapshot = {
      ...current,
      error:
        cause instanceof Error ? cause.message : "Could not save preferences",
    };
  }
  listeners.forEach((listener) => listener());
}

/** Device-local settings shared by all native screens. */
export function useNativePreferences() {
  return {
    ...useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
    onChangePreference,
  };
}
