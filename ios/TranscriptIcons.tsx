import { StyleSheet, View } from "react-native";

export type TranscriptIconName =
  | "copy"
  | "markdown"
  | "read"
  | "edit"
  | "fork"
  | "layers"
  | "chevron";

export function TranscriptIcon({
  name,
  color,
  expanded = false,
}: {
  name: TranscriptIconName;
  color: string;
  expanded?: boolean;
}) {
  const stroke = { borderColor: color };
  const fill = { backgroundColor: color };
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.icon,
        (name === "edit" || name === "fork") && styles.smallIcon,
        (name === "layers" || name === "chevron") && styles.processIcon,
      ]}
    >
      {name === "copy" && (
        <>
          <View style={[styles.copyBack, stroke]} />
          <View style={[styles.copyBackRight, fill]} />
          <View style={[styles.copyBackBottom, fill]} />
          <View style={[styles.copyFront, stroke]} />
        </>
      )}
      {name === "markdown" && (
        <>
          <View style={[styles.document, stroke]} />
          <View style={[styles.documentFold, stroke]} />
          <View style={[styles.documentLine, styles.documentLineOne, fill]} />
          <View style={[styles.documentLine, styles.documentLineTwo, fill]} />
        </>
      )}
      {name === "read" && (
        <>
          <View style={[styles.speakerBox, stroke]} />
          <View style={[styles.speakerTop, fill]} />
          <View style={[styles.speakerBottom, fill]} />
          <View style={[styles.speakerEdge, fill]} />
          <View style={[styles.wave, styles.waveInner, stroke]} />
          <View style={[styles.wave, styles.waveOuter, stroke]} />
        </>
      )}
      {name === "edit" && (
        <>
          <View style={[styles.editArrow, stroke]} />
          <View style={[styles.editShaft, fill]} />
          <View style={[styles.editCurve, stroke]} />
        </>
      )}
      {name === "fork" && (
        <>
          <View style={[styles.forkStem, fill]} />
          <View style={[styles.forkBranch, stroke]} />
          <View style={[styles.forkNode, styles.forkLeft, stroke]} />
          <View style={[styles.forkNode, styles.forkRight, stroke]} />
          <View style={[styles.forkNode, styles.forkBottom, stroke]} />
        </>
      )}
      {name === "layers" && (
        <>
          <View style={[styles.layerTop, stroke]} />
          <View style={[styles.layerLeft, styles.layerMiddle, fill]} />
          <View style={[styles.layerRight, styles.layerMiddle, fill]} />
          <View style={[styles.layerLeft, styles.layerBottom, fill]} />
          <View style={[styles.layerRight, styles.layerBottom, fill]} />
        </>
      )}
      {name === "chevron" && (
        <View
          style={[
            styles.chevron,
            stroke,
            expanded && styles.chevronExpanded,
          ]}
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  icon: { width: 13, height: 13, flexShrink: 0 },
  copyBackRight: { position: "absolute", left: 8, top: 2, width: 1.1, height: 2 },
  copyBackBottom: { position: "absolute", left: 2, top: 9, width: 2, height: 1.1 },
  smallIcon: { width: 11, height: 11 },
  processIcon: { width: 12, height: 12 },
  copyBack: {
    position: "absolute", left: 1, top: 1, width: 8, height: 9,
    borderTopWidth: 1.1, borderLeftWidth: 1.1, borderTopLeftRadius: 1.5,
    borderTopRightRadius: 1.5, borderBottomLeftRadius: 1.5,
  },
  copyFront: {
    position: "absolute", left: 4, top: 4, width: 8, height: 8,
    borderWidth: 1.1, borderRadius: 1.5,
  },
  document: {
    position: "absolute", left: 2, top: 1, width: 9, height: 11,
    borderWidth: 1.1, borderRadius: 1.5,
  },
  documentFold: {
    position: "absolute", right: 2, top: 1, width: 3, height: 3,
    borderLeftWidth: 1, borderBottomWidth: 1,
  },
  documentLine: { position: "absolute", left: 4, width: 5, height: 1, borderRadius: 1 },
  documentLineOne: { top: 6 },
  documentLineTwo: { top: 8 },
  speakerBox: {
    position: "absolute", left: 1, top: 4, width: 3, height: 5,
    borderWidth: 1.1, borderRightWidth: 0, borderRadius: 1,
  },
  speakerTop: {
    position: "absolute", left: 3, top: 3.4, width: 4, height: 1.1,
    transform: [{ rotate: "-40deg" }],
  },
  speakerBottom: {
    position: "absolute", left: 3, top: 8.5, width: 4, height: 1.1,
    transform: [{ rotate: "40deg" }],
  },
  speakerEdge: { position: "absolute", left: 6.3, top: 2, width: 1.1, height: 9 },
  wave: { position: "absolute", borderRightWidth: 1.1, borderRadius: 8 },
  waveInner: { left: 7, top: 4, width: 3, height: 5 },
  waveOuter: { left: 7, top: 2, width: 5, height: 9 },
  editArrow: {
    position: "absolute", left: 1, top: 3, width: 4, height: 4,
    borderLeftWidth: 1.1, borderBottomWidth: 1.1, transform: [{ rotate: "45deg" }],
  },
  editShaft: { position: "absolute", left: 2, top: 4.5, width: 5, height: 1.1 },
  editCurve: {
    position: "absolute", left: 5, top: 4.5, width: 5, height: 5,
    borderTopWidth: 1.1, borderRightWidth: 1.1, borderTopRightRadius: 4,
  },
  forkStem: { position: "absolute", left: 2.5, top: 3, width: 1.1, height: 5 },
  forkBranch: {
    position: "absolute", left: 3, top: 3, width: 5, height: 4,
    borderBottomWidth: 1.1, borderRightWidth: 1.1, borderBottomRightRadius: 3,
  },
  forkNode: { position: "absolute", width: 3, height: 3, borderWidth: 1, borderRadius: 2 },
  forkLeft: { left: 1.5, top: 0 },
  forkRight: { right: 1.5, top: 0 },
  forkBottom: { left: 1.5, bottom: 0 },
  layerTop: {
    position: "absolute", left: 2.5, top: 1, width: 7, height: 7,
    borderWidth: 1, borderRadius: 1, transform: [{ rotate: "45deg" }, { scaleY: 0.58 }],
  },
  layerLeft: { position: "absolute", left: 1, width: 5.5, height: 1, transform: [{ rotate: "28deg" }] },
  layerRight: { position: "absolute", right: 1, width: 5.5, height: 1, transform: [{ rotate: "-28deg" }] },
  layerMiddle: { top: 7 },
  layerBottom: { top: 9 },
  chevron: {
    position: "absolute", left: 3, top: 3, width: 6, height: 6,
    borderRightWidth: 1.1, borderBottomWidth: 1.1, transform: [{ rotate: "45deg" }],
  },
  chevronExpanded: { top: 5, transform: [{ rotate: "225deg" }] },
});
