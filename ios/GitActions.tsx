import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  DynamicColorIOS,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import type { operations } from "./generated/web-http";
import { normalizeOrigin } from "./keylime-http";
import { nativeRequest } from "./native-network";
import { theme } from "./theme";
import { ShipIcon } from "./ShellIcons";

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
type ActionIcon = "push" | "pull" | "fetch" | "rebase" | "refresh" | "ship";

function ActionGlyph({ name }: { name: ActionIcon }) {
  const scheme = useColorScheme();
  if (name === "ship")
    return <ShipIcon color={scheme === "light" ? "#625C57" : theme.muted} />;
  return (
    <View accessible={false} style={styles.glyph}>
      {(name === "push" || name === "pull" || name === "fetch") && (
        <>
          <View
            style={[styles.arrowShaft, name === "push" && styles.arrowShaftUp]}
          />
          <View
            style={[styles.arrowHead, name === "push" && styles.arrowHeadUp]}
          />
          <View
            style={name === "fetch" ? styles.downloadTray : styles.arrowLine}
          />
        </>
      )}
      {name === "rebase" && (
        <>
          <View style={styles.mergeStem} />
          <View style={styles.mergeBranch} />
          <View style={[styles.mergeNode, styles.mergeTop]} />
          <View style={[styles.mergeNode, styles.mergeBottom]} />
          <View style={[styles.mergeNode, styles.mergeEnd]} />
        </>
      )}
      {name === "refresh" && (
        <>
          <View style={styles.refreshCircle} />
          <View style={[styles.refreshArrow, styles.refreshArrowTop]} />
          <View style={[styles.refreshArrow, styles.refreshArrowBottom]} />
        </>
      )}
    </View>
  );
}

const iconColor = DynamicColorIOS({ dark: theme.muted, light: "#625C57" });

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
    symbol: ActionIcon,
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
      <ActionGlyph name={symbol} />
    </Pressable>
  );
  return (
    <>
      <View style={styles.actions}>
        {children}
        {button("Push", "push", () => confirm("push"), blocked)}
        {button("Pull", "pull", () => confirm("pull"), blocked)}
        {button("Fetch", "fetch", () => confirm("fetch"), blocked)}
        {button("Rebase", "rebase", rebase, blocked)}
        {button("Refresh Git status", "refresh", onRefresh, false)}
        {onShip && button("Ship", "ship", onShip, blocked)}
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
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 6,
  },
  button: {
    width: 26,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.5 },
  glyph: { width: 14, height: 14 },
  arrowShaft: {
    position: "absolute",
    left: 6.3,
    top: 1,
    height: 9,
    width: 1.4,
    backgroundColor: iconColor,
  },
  arrowShaftUp: { top: 3 },
  arrowHead: {
    position: "absolute",
    left: 4,
    top: 5,
    width: 6,
    height: 6,
    borderRightWidth: 1.4,
    borderBottomWidth: 1.4,
    borderColor: iconColor,
    transform: [{ rotate: "45deg" }],
  },
  arrowHeadUp: { top: 2, transform: [{ rotate: "225deg" }] },
  arrowLine: {
    position: "absolute",
    left: 2,
    bottom: 1,
    width: 10,
    height: 1.4,
    backgroundColor: iconColor,
  },
  downloadTray: {
    position: "absolute",
    left: 1,
    bottom: 1,
    width: 12,
    height: 4,
    borderWidth: 1.4,
    borderTopWidth: 0,
    borderColor: iconColor,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
  },
  mergeStem: {
    position: "absolute",
    left: 3,
    top: 3,
    width: 1.4,
    height: 8,
    backgroundColor: iconColor,
  },
  mergeBranch: {
    position: "absolute",
    left: 3,
    top: 5,
    width: 7,
    height: 5,
    borderBottomWidth: 1.4,
    borderLeftWidth: 1.4,
    borderBottomLeftRadius: 4,
    borderColor: iconColor,
  },
  mergeNode: {
    position: "absolute",
    width: 4,
    height: 4,
    borderWidth: 1.2,
    borderRadius: 2,
    borderColor: iconColor,
    backgroundColor: DynamicColorIOS({
      dark: theme.background,
      light: "#F7F5F0",
    }),
  },
  mergeTop: { left: 1.7, top: 0 },
  mergeBottom: { left: 1.7, bottom: 0 },
  mergeEnd: { right: 0, bottom: 2.7 },
  refreshCircle: {
    position: "absolute",
    left: 1.5,
    top: 1.5,
    width: 11,
    height: 11,
    borderWidth: 1.4,
    borderColor: iconColor,
    borderRadius: 6,
  },
  refreshArrow: {
    position: "absolute",
    width: 4,
    height: 4,
    borderColor: iconColor,
  },
  refreshArrowTop: {
    right: 0,
    top: 0,
    borderRightWidth: 1.4,
    borderBottomWidth: 1.4,
  },
  refreshArrowBottom: {
    left: 0,
    bottom: 0,
    borderLeftWidth: 1.4,
    borderTopWidth: 1.4,
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
