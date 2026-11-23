import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import {
  createSession,
  getHosts,
  KeylimeHttpError,
  normalizeOrigin,
} from "./keylime-http";

type Props = {
  onConnected: (origin: string) => void;
  expiredOrigin?: string;
  onCancel?: () => void;
};

const light = {
  bg: "#FAF9F6",
  panel: "#F2F0EA",
  border: "#E2DDD2",
  text: "#2B2823",
  muted: "#69635A",
  accent: "#B03E22",
  button: "#B03E22",
  iconBg: "#F5EDE1",
  error: "#B42318",
};
const dark = {
  bg: "#000000",
  panel: "#0A0A0C",
  border: "#232329",
  text: "#F5F5F5",
  muted: "#C9C9D1",
  accent: "#EC5BAB",
  button: "#AD2674",
  iconBg: "#171217",
  error: "#FF9B92",
};

function errorMessage(error: unknown): string {
  if (error instanceof KeylimeHttpError) {
    if (error.kind === "unreachable")
      return "Could not reach the server. Please check your connection and try again.";
    if (error.kind === "invalid-response")
      return "The server returned an invalid response.";
    if (error.kind === "unauthorized")
      return "Your session has expired. Please sign in again.";
    return `The server could not complete the request${error.status ? ` (${error.status})` : ""}.`;
  }
  return "Enter a valid server origin, such as https://keylime.example.com.";
}

export function ConnectionScreen({
  onConnected,
  expiredOrigin,
  onCancel,
}: Props) {
  const colors = useColorScheme() === "light" ? light : dark;
  const [originInput, setOriginInput] = useState(expiredOrigin ?? "");
  const [origin, setOrigin] = useState(expiredOrigin ?? "");
  const [step, setStep] = useState<"server" | "password">(
    expiredOrigin ? "password" : "server",
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    expiredOrigin ? "Your session has expired. Please sign in again." : null,
  );
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const submitting = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function connect() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const server = normalizeOrigin(originInput);
      setOrigin(server);
      setOriginInput(server);
      try {
        await getHosts(server);
        if (active.current) onConnected(server);
      } catch (cause) {
        if (!active.current) return;
        if (
          cause instanceof KeylimeHttpError &&
          cause.kind === "unauthorized"
        ) {
          setStep("password");
        } else {
          setError(errorMessage(cause));
        }
      }
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function signIn() {
    if (submitting.current || !password) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      try {
        await createSession(origin, password);
      } catch (cause) {
        if (
          cause instanceof KeylimeHttpError &&
          cause.kind === "unauthorized"
        ) {
          if (active.current) setError("Incorrect password. Please try again.");
          return;
        }
        // Password protection may have been disabled since the initial read.
        if (!(
          cause instanceof KeylimeHttpError &&
          cause.kind === "http" &&
          cause.status === 404
        ))
          throw cause;
      } finally {
        if (active.current) setPassword("");
      }
      await getHosts(origin);
      if (active.current) onConnected(origin);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  const inputStyle = [
    styles.input,
    {
      color: colors.text,
      backgroundColor: colors.bg,
      borderColor: error ? colors.error : colors.border,
    },
  ];
  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.card,
            { backgroundColor: colors.panel, borderColor: colors.border },
          ]}
        >
          <View
            style={[styles.icon, { backgroundColor: colors.iconBg }]}
            accessible={false}
          >
            <View
              style={[styles.lockShackle, { borderColor: colors.accent }]}
            />
            <View style={[styles.lockBody, { borderColor: colors.accent }]}>
              <View
                style={[styles.lockKey, { backgroundColor: colors.accent }]}
              />
            </View>
          </View>
          <Text
            accessibilityRole="header"
            style={[styles.title, { color: colors.text }]}
          >
            {step === "password" ? "Welcome back" : "Connect to Keylime"}
          </Text>
          <Text style={[styles.description, { color: colors.muted }]}>
            {step === "password"
              ? "Enter the password for this key lime workspace."
              : "Enter the URL of your Keylime web server."}
          </Text>
          {step === "server" ? (
            <View style={styles.form}>
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.muted }]}>
                  Server URL
                </Text>
                <TextInput
                  accessibilityLabel="Server URL"
                  accessibilityHint="Enter the full HTTP or HTTPS server origin"
                  style={inputStyle}
                  value={originInput}
                  onChangeText={setOriginInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="url"
                  keyboardType="url"
                  placeholder="https://keylime.example.com"
                  placeholderTextColor={colors.muted}
                  editable={!busy}
                  returnKeyType="go"
                  onSubmitEditing={connect}
                />
              </View>
              {error && (
                <Text
                  accessibilityRole="alert"
                  style={[styles.error, { color: colors.error }]}
                >
                  {error}
                </Text>
              )}
              <Pressable
                accessibilityRole="button"
                disabled={busy || !originInput.trim()}
                onPress={connect}
                style={[
                  styles.button,
                  {
                    backgroundColor: colors.button,
                    opacity: busy || !originInput.trim() ? 0.7 : 1,
                  },
                ]}
              >
                <Text style={styles.buttonText}>
                  {busy ? "Connecting…" : "Connect"}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.form}>
              <View style={styles.field}>
                <Text style={[styles.label, { color: colors.muted }]}>
                  Password
                </Text>
                <TextInput
                  accessibilityLabel="Password"
                  style={inputStyle}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="current-password"
                  textContentType="password"
                  editable={!busy}
                  returnKeyType="go"
                  onSubmitEditing={signIn}
                />
              </View>
              {error && (
                <Text
                  accessibilityRole="alert"
                  style={[styles.error, { color: colors.error }]}
                >
                  {error}
                </Text>
              )}
              <Pressable
                accessibilityRole="button"
                disabled={busy || !password}
                onPress={signIn}
                style={[
                  styles.button,
                  {
                    backgroundColor: colors.button,
                    opacity: busy ? 0.7 : 1,
                  },
                ]}
              >
                <Text style={styles.buttonText}>
                  {busy ? "Unlocking…" : "Unlock workspace"}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
        {(step === "password" || onCancel) && (
          <View style={styles.secondaryActions}>
            {step === "password" && (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => {
                  setPassword("");
                  setError(null);
                  setStep("server");
                }}
                style={styles.secondary}
              >
                <Text style={[styles.secondaryText, { color: colors.accent }]}>
                  Change server
                </Text>
              </Pressable>
            )}
            {onCancel && (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={onCancel}
                style={styles.secondary}
              >
                <Text style={[styles.secondaryText, { color: colors.muted }]}>
                  Cancel
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  secondaryActions: { width: "100%", maxWidth: 380 },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 20,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    padding: 28,
    borderWidth: 1,
    borderRadius: 16,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },
  lockShackle: {
    width: 10,
    height: 8,
    borderWidth: 1.5,
    borderBottomWidth: 0,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
  },
  lockBody: {
    width: 15,
    height: 11,
    borderWidth: 1.5,
    borderRadius: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  lockKey: { width: 2, height: 4, borderRadius: 1 },
  title: { fontSize: 28, lineHeight: 31, fontWeight: "600" },
  description: {
    marginTop: 10,
    marginBottom: 24,
    fontSize: 13,
    lineHeight: 20,
  },
  form: { gap: 14 },
  field: { gap: 6 },
  label: { fontSize: 12, fontWeight: "600" },
  input: {
    width: "100%",
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderRadius: 8,
    fontSize: 14,
  },
  error: { fontSize: 12 },
  button: {
    minHeight: 44,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: { color: "#FFFFFF", fontWeight: "600", fontSize: 14 },
  secondary: { minHeight: 44, justifyContent: "center", alignItems: "center" },
  secondaryText: { fontSize: 13, fontWeight: "600" },
});
