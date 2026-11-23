import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  useWindowDimensions,
} from "react-native";
import type { components } from "./generated/browser-link";
import { ChatMarkdown } from "./ChatMarkdown";
import { lightTheme, theme } from "./theme";

type PlanState = NonNullable<
  Extract<
    components["schemas"]["BrowserReply_get_plan_state"]["data"],
    { success: true }
  >["data"]
>;

type Props = {
  proposal: NonNullable<PlanState["proposal"]>;
  pending: boolean;
  onRespond(id: string, approved: boolean, feedback?: string): Promise<boolean>;
};

export function PlanReview({ proposal, pending, onRespond }: Props) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const colors = useColorScheme() === "light" ? lightTheme : theme;
  const { height } = useWindowDimensions();
  const busy = pending || submitting;

  async function respond(approved: boolean) {
    const trimmed = feedback.trim();
    if (busy || inFlight.current || (!approved && !trimmed)) return;
    inFlight.current = true;
    setSubmitting(true);
    setFailed(false);
    try {
      if (
        !(await onRespond(
          proposal.id,
          approved,
          approved ? undefined : trimmed,
        ))
      ) {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <View
      accessibilityLabel="Review plan"
      style={[
        styles.panel,
        { backgroundColor: colors.panel, borderColor: colors.border },
      ]}
    >
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: colors.text }]}
      >
        {proposal.title || "Review plan"}
      </Text>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={[styles.scroll, { maxHeight: Math.min(height * 0.4, 360) }]}
      >
        <ChatMarkdown text={proposal.content} palette={colors} />
      </ScrollView>
      {revising && (
        <TextInput
          accessibilityLabel="Revision feedback"
          editable={!busy}
          multiline
          placeholder="What should change?"
          placeholderTextColor={colors.muted}
          value={feedback}
          onChangeText={setFeedback}
          style={[
            styles.input,
            { color: colors.text, borderColor: colors.border },
          ]}
        />
      )}
      {failed && (
        <Text
          accessibilityRole="alert"
          style={[styles.error, { color: colors.accent }]}
        >
          {pending
            ? "Response may have been sent; waiting for confirmation."
            : "Could not submit the response. Check the session status."}
        </Text>
      )}
      <View style={styles.actions}>
        {busy && <ActivityIndicator color={colors.muted} />}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void respond(true)}
          style={[
            styles.button,
            { borderColor: colors.border },
            busy && styles.disabled,
          ]}
        >
          <Text style={[styles.buttonText, { color: colors.text }]}>
            Approve &amp; implement
          </Text>
        </Pressable>
        {revising ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || !feedback.trim() }}
              disabled={busy || !feedback.trim()}
              onPress={() => void respond(false)}
              style={[
                styles.button,
                { borderColor: colors.border },
                (busy || !feedback.trim()) && styles.disabled,
              ]}
            >
              <Text style={[styles.buttonText, { color: colors.text }]}>
                Send revisions
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => setRevising(false)}
              style={[
                styles.button,
                { borderColor: colors.border },
                busy && styles.disabled,
              ]}
            >
              <Text style={[styles.buttonText, { color: colors.text }]}>
                Cancel
              </Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => setRevising(true)}
            style={[
              styles.button,
              { borderColor: colors.border },
              busy && styles.disabled,
            ]}
          >
            <Text style={[styles.buttonText, { color: colors.text }]}>
              Request revisions
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 8 },
  title: { fontSize: 15, fontWeight: "600" },
  scroll: { flexGrow: 0 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 80,
    fontSize: 14,
    textAlignVertical: "top",
  },
  error: { fontSize: 13 },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  button: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  buttonText: { fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.45 },
});
