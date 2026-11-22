import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  DynamicColorIOS,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { operations } from "./generated/web-http";
import { normalizeOrigin } from "./keylime-http";
import { nativeRequest } from "./native-network";
import { theme } from "./theme";

type ActionRequest =
  operations["workspaceGitAction"]["requestBody"]["content"]["application/json"];
type GitAction = ActionRequest["action"];
type State = { pending: boolean; error: string | null };
const idle: State = { pending: false, error: null };
const states = new Map<string, State>();
const listeners = new Map<string, Set<(state: State) => void>>();

function publish(key: string, state: State) {
  if (!state.pending && !state.error) states.delete(key);
  else states.set(key, state);
  listeners.get(key)?.forEach((listener) => listener(state));
}

async function execute(origin: string, key: string, body: ActionRequest) {
  if (states.get(key)?.pending) return;
  publish(key, { pending: true, error: null });
  let error: string | null = null;
  try {
    const response = await nativeRequest(
      normalizeOrigin(origin),
      "/api/git/action",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        delivery?: unknown;
      };
      error =
        typeof result.error === "string"
          ? result.error
          : `Git action failed (HTTP ${response.status}).`;
      if (result.delivery === "unknown")
        error = `Could not confirm whether the Git action completed.\n${error}`;
    }
  } catch (reason) {
    error = `Could not confirm whether the Git action completed.\n${reason instanceof Error ? reason.message : String(reason)}`;
  }
  if (error) {
    error += "\nCheck the repository and remote state before trying again.";
    if (body.action === "rebase-main" || body.action === "rebase-origin-main") {
      error +=
        "\nIf a rebase is in progress, resolve conflicts and run git rebase --continue, or run git rebase --abort.";
    }
  }
  publish(key, { pending: false, error });
}

const labels: Record<GitAction, string> = {
  push: "Push",
  pull: "Pull",
  fetch: "Fetch",
  "rebase-main": "Rebase onto local main",
  "rebase-origin-main": "Rebase onto origin/main",
};

export function GitActions({
  origin,
  hostId,
  cwd,
  sessionId,
  disabled,
  onRefresh,
  onShip,
  children,
}: {
  origin: string;
  hostId: string;
  cwd: string;
  sessionId?: string | null;
  disabled: boolean;
  onRefresh: () => void;
  onShip?: () => void;
  children: ReactNode;
}) {
  const key = JSON.stringify([origin, hostId, cwd]);
  const [state, setState] = useState<State>(() => states.get(key) ?? idle);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    let previous = states.get(key) ?? idle;
    setState(previous);
    const listener = (next: State) => {
      if (previous.pending && !next.pending) refresh.current();
      previous = next;
      setState(next);
    };
    const group = listeners.get(key) ?? new Set<(state: State) => void>();
    listeners.set(key, group);
    group.add(listener);
    return () => {
      group.delete(listener);
      if (!group.size) listeners.delete(key);
    };
  }, [key]);
  const blocked = disabled || state.pending;
  const confirm = (action: GitAction) => {
    if (blocked || states.get(key)?.pending) return;
    const label = labels[action];
    Alert.alert(label, `${label} for this workspace?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: label,
        onPress: () =>
          void execute(origin, key, {
            hostId,
            cwd,
            sessionId: sessionId ?? null,
            action,
          }),
      },
    ]);
  };
  const rebase = () =>
    Alert.alert("Rebase", "Rebase this workspace onto which branch?", [
      {
        text: labels["rebase-main"],
        onPress: () =>
          void execute(origin, key, {
            hostId,
            cwd,
            sessionId: sessionId ?? null,
            action: "rebase-main",
          }),
      },
      {
        text: labels["rebase-origin-main"],
        onPress: () =>
          void execute(origin, key, {
            hostId,
            cwd,
            sessionId: sessionId ?? null,
            action: "rebase-origin-main",
          }),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  const button = (
    label: string,
    symbol: string,
    onPress: () => void,
    isDisabled: boolean,
  ) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={[styles.button, isDisabled && styles.disabled]}
    >
      <Text style={styles.icon}>{symbol}</Text>
    </Pressable>
  );
  return (
    <>
      <View style={styles.actions}>
        {children}
        {button("Push", "↑", () => confirm("push"), blocked)}
        {button("Pull", "↓", () => confirm("pull"), blocked)}
        {button("Fetch", "⇩", () => confirm("fetch"), blocked)}
        {button("Rebase", "⑂", rebase, blocked)}
        {button("Refresh Git status", "↻", onRefresh, false)}
        {onShip && button("Ship", "⇧", onShip, blocked)}
      </View>
      {state.pending && <Text style={styles.status}>Running Git action…</Text>}
      {state.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 10,
    gap: 4,
  },
  button: {
    minWidth: 34,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.45 },
  icon: {
    color: DynamicColorIOS({ dark: theme.muted, light: "#625C57" }),
    fontSize: 18,
  },
  status: {
    color: DynamicColorIOS({ dark: theme.muted, light: "#625C57" }),
    fontSize: 12,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  error: {
    color: DynamicColorIOS({ dark: "#f0828b", light: "#aa3038" }),
    fontSize: 12,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
});
