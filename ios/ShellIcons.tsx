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
});
