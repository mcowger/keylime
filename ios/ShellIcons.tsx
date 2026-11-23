import { StyleSheet, View } from "react-native";

export function WorkspacePanelIcon({ color }: { color: string }) {
  return (
    <View accessible={false} style={[styles.split, { borderColor: color }]}>
      <View style={[styles.line, { backgroundColor: color }]} />
    </View>
  );
}

export function SidebarMenuIcon({ color }: { color: string }) {
  return (
    <View accessible={false} style={styles.hamburger}>
      <View style={[styles.rule, { backgroundColor: color }]} />
      <View style={[styles.rule, { backgroundColor: color }]} />
      <View style={[styles.rule, { backgroundColor: color }]} />
    </View>
  );
}

export function ShipIcon({ color }: { color: string }) {
  return (
    <View accessible={false} style={styles.ship}>
      <View style={[styles.mast, { backgroundColor: color }]} />
      <View style={[styles.cabin, { borderColor: color }]} />
      <View style={[styles.hull, { borderColor: color }]} />
      <View style={[styles.wave, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  split: {
    width: 14,
    height: 13,
    borderWidth: 1.2,
    borderRadius: 2,
    alignItems: "flex-end",
    paddingRight: 4,
  },
  line: { width: 1.2, flex: 1 },
  hamburger: { width: 13, height: 12, justifyContent: "space-between" },
  rule: { height: 1.1, borderRadius: 1 },
  ship: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "flex-end",
  },
  mast: { position: "absolute", top: 1, width: 1.4, height: 5 },
  cabin: {
    position: "absolute",
    top: 5,
    width: 9,
    height: 4,
    borderWidth: 1.3,
    borderRadius: 1,
  },
  hull: {
    width: 16,
    height: 6,
    borderWidth: 1.3,
    borderBottomLeftRadius: 5,
    borderBottomRightRadius: 5,
    marginBottom: 2,
  },
  wave: { position: "absolute", bottom: 0, width: 16, height: 1.2 },
});
