import { StyleSheet, Text, View } from "react-native";
import { dynamicTheme as theme } from "./dynamic-theme";

type IconName = "folder-plus" | "layers" | "message" | "bot" | "question";

// These are the small, decorative outlines used on Home. Keeping them native
// avoids relying on emoji glyphs, which vary between iOS versions.
export function HomeIcon({ name }: { name: IconName }) {
  const color =
    name === "folder-plus" || name === "layers" ? theme.text : theme.muted;
  if (name === "folder-plus") {
    return (
      <View style={styles.icon} accessibilityElementsHidden>
        <View style={[styles.folderTab, { borderColor: color }]} />
        <View style={[styles.folderBody, { borderColor: color }]} />
        <View style={[styles.plusHorizontal, { backgroundColor: color }]} />
        <View style={[styles.plusVertical, { backgroundColor: color }]} />
      </View>
    );
  }
  if (name === "layers") {
    return (
      <View style={styles.icon} accessibilityElementsHidden>
        <View
          style={[styles.layer, styles.layerBottom, { borderColor: color }]}
        />
        <View
          style={[styles.layer, styles.layerMiddle, { borderColor: color }]}
        />
        <View style={[styles.layer, styles.layerTop, { borderColor: color }]} />
      </View>
    );
  }
  if (name === "bot") {
    return (
      <View style={styles.icon} accessibilityElementsHidden>
        <View style={[styles.botAntenna, { backgroundColor: color }]} />
        <View style={[styles.botHead, { borderColor: color }]} />
        <View
          style={[styles.botEye, styles.botEyeLeft, { backgroundColor: color }]}
        />
        <View
          style={[
            styles.botEye,
            styles.botEyeRight,
            { backgroundColor: color },
          ]}
        />
      </View>
    );
  }
  if (name === "question") {
    return (
      <View style={styles.icon} accessibilityElementsHidden>
        <View style={[styles.questionCircle, { borderColor: color }]} />
        <Text style={[styles.questionMark, { color }]}>?</Text>
      </View>
    );
  }
  return (
    <View style={styles.icon} accessibilityElementsHidden>
      <View style={[styles.messageBody, { borderColor: color }]} />
      <View
        style={[
          styles.messageTail,
          { borderColor: color, backgroundColor: theme.panel },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: 17, height: 17, flexShrink: 0 },
  folderTab: {
    position: "absolute",
    left: 1,
    top: 1,
    width: 7,
    height: 4,
    borderWidth: 1.5,
    borderBottomWidth: 0,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  folderBody: {
    position: "absolute",
    left: 1,
    top: 3,
    width: 15,
    height: 12,
    borderWidth: 1.5,
    borderRadius: 2,
  },
  plusHorizontal: {
    position: "absolute",
    width: 6,
    height: 1.5,
    left: 6,
    top: 8,
  },
  plusVertical: {
    position: "absolute",
    width: 1.5,
    height: 6,
    left: 8.25,
    top: 5.75,
  },
  layer: {
    position: "absolute",
    left: 3,
    width: 11,
    height: 11,
    borderWidth: 1.4,
    borderRadius: 1,
    transform: [{ rotate: "45deg" }, { scaleY: 0.55 }],
  },
  layerTop: { top: 0, backgroundColor: theme.panel },
  layerMiddle: { top: 3.5 },
  layerBottom: { top: 7 },
  botAntenna: { position: "absolute", left: 8, top: 0, width: 1.5, height: 4 },
  botHead: {
    position: "absolute",
    left: 2,
    top: 3,
    width: 13,
    height: 11,
    borderWidth: 1.5,
    borderRadius: 3,
  },
  botEye: {
    position: "absolute",
    top: 8,
    width: 1.8,
    height: 1.8,
    borderRadius: 1,
  },
  botEyeLeft: { left: 5 },
  botEyeRight: { right: 5 },
  questionCircle: {
    position: "absolute",
    left: 1,
    top: 1,
    width: 15,
    height: 15,
    borderWidth: 1.5,
    borderRadius: 8,
  },
  questionMark: {
    position: "absolute",
    left: 5,
    top: 0,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
  },
  messageBody: {
    position: "absolute",
    left: 1,
    top: 1,
    width: 15,
    height: 12,
    borderWidth: 1.5,
    borderRadius: 2,
  },
  messageTail: {
    position: "absolute",
    left: 2,
    top: 11,
    width: 4,
    height: 4,
    borderLeftWidth: 1.5,
    borderBottomWidth: 1.5,
    transform: [{ skewY: "-35deg" }],
  },
});
