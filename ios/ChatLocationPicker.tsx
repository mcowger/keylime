import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { theme } from "./theme";

export type ChatLocationChoice = {
  key: string;
  title: string;
  subtitle?: string;
  onSelect: () => void;
};

export function ChatLocationPicker({
  kind,
  choices,
  onClose,
}: {
  kind: "project" | "workspace" | null;
  choices: readonly ChatLocationChoice[];
  onClose: () => void;
}) {
  const dark = useColorScheme() !== "light";
  const colors = dark
    ? theme
    : {
        panel: "#F2F0EA",
        text: "#2B2823",
        muted: "#69635A",
        border: "#E2DDD2",
      };
  return (
    <Modal
      transparent
      visible={kind !== null}
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss picker"
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { backgroundColor: colors.panel, borderColor: colors.border },
          ]}
        >
          <View style={styles.heading}>
            <Text
              accessibilityRole="header"
              style={[styles.title, { color: colors.text }]}
            >
              Select {kind}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close picker"
              onPress={onClose}
              hitSlop={8}
            >
              <Text style={[styles.title, { color: colors.text }]}>×</Text>
            </Pressable>
          </View>
          <ScrollView>
            {choices.map((choice) => (
              <Pressable
                key={choice.key}
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  choice.onSelect();
                }}
                style={[styles.row, { borderColor: colors.border }]}
              >
                <Text style={{ color: colors.text, fontSize: 16 }}>
                  {choice.title}
                </Text>
                {choice.subtitle && (
                  <Text
                    style={{ color: colors.muted, fontSize: 12 }}
                    numberOfLines={2}
                  >
                    {choice.subtitle}
                  </Text>
                )}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.50)",
    justifyContent: "flex-end",
  },
  sheet: {
    maxHeight: "72%",
    padding: 20,
    paddingBottom: 45,
    borderWidth: 1,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  heading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 16,
  },
  title: { fontWeight: "600", fontSize: 20 },
  row: {
    minHeight: 51,
    borderBottomWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    gap: 3,
    paddingVertical: 8,
  },
});
