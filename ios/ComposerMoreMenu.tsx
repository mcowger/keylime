import { useEffect, useRef, useState, type ComponentRef } from "react";
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from "react-native";
import type { ToolPreset } from "../lib/tool-presets";
export type ComposerMoreMenuProps = {
  onAttachFiles: () => void;
  onPhotoLibrary: () => void;
  onPasteImage: () => void;
  attachmentsDisabled?: boolean;
  toolPreset: ToolPreset;
  onToolPresetChange: (preset: ToolPreset) => void;
  advisorEnabled: boolean;
  onAdvisorChange: (enabled: boolean) => void;
  advisorModel?: { name: string; reasoning: string | null } | null;
  disabled?: boolean;
};

type Anchor = { x: number; y: number; height: number };
type IconName = "plus" | "attach" | "photo" | "paste" | "tools" | "advisor";

function MenuIcon({ name, color }: { name: IconName; color: string }) {
  if (name === "advisor")
    return (
      <View style={styles.icon} accessibilityElementsHidden>
        <Text style={[styles.sparkle, { color }]}>✧</Text>
      </View>
    );
  return (
    <View style={styles.icon} accessibilityElementsHidden>
      {name === "plus" ? (
        <>
          <View style={[styles.plusHorizontal, { backgroundColor: color }]} />
          <View style={[styles.plusVertical, { backgroundColor: color }]} />
        </>
      ) : name === "attach" ? (
        <>
          <View style={[styles.clipOuter, { borderColor: color }]} />
          <View style={[styles.clipInner, { borderColor: color }]} />
        </>
      ) : name === "photo" ? (
        <>
          <View style={[styles.photoFrame, { borderColor: color }]} />
          <View style={[styles.photoSun, { backgroundColor: color }]} />
          <View style={[styles.photoMountain, { borderColor: color }]} />
        </>
      ) : name === "paste" ? (
        <>
          <View style={[styles.clipboard, { borderColor: color }]} />
          <View style={[styles.clipboardTop, { borderColor: color }]} />
          <View style={[styles.clipboardLine, { backgroundColor: color }]} />
        </>
      ) : (
        <>
          <View style={[styles.wrenchHead, { borderColor: color }]} />
          <View style={[styles.wrenchHandle, { backgroundColor: color }]} />
        </>
      )}
    </View>
  );
}

const presets: { value: ToolPreset; description: string }[] = [
  { value: "none", description: "No tools" },
  { value: "default", description: "Read, bash, edit, write" },
  { value: "full", description: "All tools, including subagents" },
];

/** An anchored composer menu. Callbacks own persistence and session changes. */
export function ComposerMoreMenu({
  onAttachFiles,
  onPhotoLibrary,
  onPasteImage,
  attachmentsDisabled = false,
  toolPreset,
  onToolPresetChange,
  advisorEnabled,
  onAdvisorChange,
  advisorModel,
  disabled = false,
}: ComposerMoreMenuProps) {
  const dark = useColorScheme() === "dark";
  const colors = dark
    ? {
        panel: "#0A0A0C",
        border: "#29292E",
        text: "#F5F5F5",
        muted: "#C9C9D1",
        dim: "#929299",
        selected: "#232329",
        accent: "#EC5BAB",
      }
    : {
        panel: "#F2F0EA",
        border: "#D6CFC1",
        text: "#221A14",
        muted: "#554C45",
        dim: "#746D66",
        selected: "#E8E4DC",
        accent: "#A52672",
      };
  const { width, height } = useWindowDimensions();
  const anchorRef = useRef<ComponentRef<typeof View>>(null);
  const pendingAction = useRef<(() => void) | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<"tools" | "advisor" | null>(null);

  const measureAnchor = () => {
    anchorRef.current?.measureInWindow((x, y, buttonWidth, buttonHeight) => {
      if (buttonWidth && buttonHeight)
        setAnchor({ x, y, height: buttonHeight });
    });
  };
  useEffect(() => {
    if (!open) return;
    const show = Keyboard.addListener("keyboardDidShow", measureAnchor);
    const hide = Keyboard.addListener("keyboardDidHide", measureAnchor);
    return () => {
      show.remove();
      hide.remove();
    };
  }, [open]);

  const close = (action?: () => void) => {
    pendingAction.current = action ?? null;
    setOpen(false);
    setExpanded(null);
  };
  const show = () => {
    anchorRef.current?.measureInWindow((x, y, buttonWidth, buttonHeight) => {
      if (!buttonWidth || !buttonHeight) return;
      setAnchor({ x, y, height: buttonHeight });
      setOpen(true);
    });
  };
  const above = !anchor || anchor.y >= 180 || anchor.y > height - anchor.y;
  const menuWidth = Math.min(230, width - 32);
  const left = Math.max(16, Math.min(anchor?.x ?? 16, width - menuWidth - 16));
  const maxHeight = Math.max(
    60,
    above
      ? (anchor?.y ?? height) - 12
      : height - ((anchor?.y ?? 0) + (anchor?.height ?? 0)) - 12,
  );
  const advisorTitle = advisorEnabled
    ? `Advisor: ${advisorModel?.name ?? "Advisor"} (${advisorModel?.reasoning ?? "model default"}) — click to disable`
    : "Enable advisor for this chat";

  return (
    <>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="More actions"
          accessibilityState={{ expanded: open, disabled }}
          disabled={disabled}
          onPress={show}
          style={[
            styles.trigger,
            open && { backgroundColor: colors.selected },
            disabled && styles.disabled,
          ]}
        >
          <MenuIcon name="plus" color={open ? colors.text : colors.muted} />
        </Pressable>
      </View>
      <Modal
        transparent
        visible={open}
        animationType="none"
        onShow={measureAnchor}
        onRequestClose={() => close()}
        onDismiss={() => {
          const action = pendingAction.current;
          pendingAction.current = null;
          action?.();
        }}
      >
        <View style={styles.overlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close more actions"
            onPress={() => close()}
            style={StyleSheet.absoluteFill}
          />
          {anchor && (
            <View
              accessibilityViewIsModal
              style={[
                styles.panel,
                {
                  left,
                  width: menuWidth,
                  maxHeight,
                  backgroundColor: colors.panel,
                  borderColor: colors.border,
                  ...(above
                    ? { bottom: height - anchor.y + 6 }
                    : { top: anchor.y + anchor.height + 6 }),
                },
              ]}
            >
              <View style={[styles.header, { borderColor: colors.border }]}>
                <MenuIcon name="plus" color={colors.muted} />
                <Text style={[styles.headerText, { color: colors.text }]}>
                  More actions
                </Text>
              </View>
              <ScrollView bounces={false} keyboardShouldPersistTaps="always">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Attach files"
                  accessibilityState={{ disabled: attachmentsDisabled }}
                  disabled={attachmentsDisabled}
                  onPress={() => close(onAttachFiles)}
                  style={[styles.row, attachmentsDisabled && styles.disabled]}
                >
                  <MenuIcon name="attach" color={colors.muted} />
                  <Text style={[styles.rowText, { color: colors.muted }]}>
                    Attach files
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Photo Library"
                  accessibilityState={{ disabled: attachmentsDisabled }}
                  disabled={attachmentsDisabled}
                  onPress={() => close(onPhotoLibrary)}
                  style={[styles.row, attachmentsDisabled && styles.disabled]}
                >
                  <MenuIcon name="photo" color={colors.muted} />
                  <Text style={[styles.rowText, { color: colors.muted }]}>
                    Photo Library
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Paste image"
                  accessibilityState={{ disabled: attachmentsDisabled }}
                  disabled={attachmentsDisabled}
                  onPress={() => close(onPasteImage)}
                  style={[styles.row, attachmentsDisabled && styles.disabled]}
                >
                  <MenuIcon name="paste" color={colors.muted} />
                  <Text style={[styles.rowText, { color: colors.muted }]}>
                    Paste image
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Tool preset: ${toolPreset}`}
                  accessibilityState={{ expanded: expanded === "tools" }}
                  onPress={() =>
                    setExpanded((value) => (value === "tools" ? null : "tools"))
                  }
                  style={[
                    styles.row,
                    expanded === "tools" && {
                      backgroundColor: colors.selected,
                    },
                  ]}
                >
                  <MenuIcon name="tools" color={colors.muted} />
                  <Text style={[styles.rowText, { color: colors.muted }]}>
                    Tool preset
                  </Text>
                  <Text style={[styles.value, { color: colors.dim }]}>
                    {toolPreset}
                  </Text>
                  <Text style={[styles.chevron, { color: colors.dim }]}>
                    {expanded === "tools" ? "⌃" : "⌄"}
                  </Text>
                </Pressable>
                {expanded === "tools" &&
                  presets.map(({ value, description }) => {
                    const selected = toolPreset === value;
                    return (
                      <Pressable
                        key={value}
                        accessibilityRole="radio"
                        accessibilityLabel={`${value}, ${description}`}
                        accessibilityState={{ checked: selected }}
                        onPress={() =>
                          close(
                            selected
                              ? undefined
                              : () => onToolPresetChange(value),
                          )
                        }
                        style={[
                          styles.option,
                          selected && { backgroundColor: colors.selected },
                        ]}
                      >
                        <Text style={[styles.check, { color: colors.accent }]}>
                          {selected ? "✓" : ""}
                        </Text>
                        <Text
                          style={[
                            styles.optionText,
                            { color: selected ? colors.text : colors.muted },
                            selected && styles.activeText,
                          ]}
                        >
                          {value}
                        </Text>
                      </Pressable>
                    );
                  })}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Advisor: ${advisorEnabled ? "On" : "Off"}`}
                  accessibilityState={{ expanded: expanded === "advisor" }}
                  onPress={() =>
                    setExpanded((value) =>
                      value === "advisor" ? null : "advisor",
                    )
                  }
                  style={[
                    styles.row,
                    expanded === "advisor" && {
                      backgroundColor: colors.selected,
                    },
                  ]}
                >
                  <MenuIcon
                    name="advisor"
                    color={advisorEnabled ? colors.accent : colors.muted}
                  />
                  <Text
                    style={[
                      styles.rowText,
                      { color: advisorEnabled ? colors.accent : colors.muted },
                    ]}
                  >
                    Advisor
                  </Text>
                  <Text style={[styles.value, { color: colors.dim }]}>
                    {advisorEnabled ? "On" : "Off"}
                  </Text>
                  <Text style={[styles.chevron, { color: colors.dim }]}>
                    {expanded === "advisor" ? "⌃" : "⌄"}
                  </Text>
                </Pressable>
                {expanded === "advisor" && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={advisorTitle}
                    onPress={() =>
                      close(() => onAdvisorChange(!advisorEnabled))
                    }
                    style={styles.option}
                  >
                    <Text
                      numberOfLines={1}
                      style={[styles.advisorAction, { color: colors.muted }]}
                    >
                      {advisorTitle}
                    </Text>
                  </Pressable>
                )}
              </ScrollView>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    width: 32,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
  },
  disabled: { opacity: 0.4 },
  overlay: { flex: 1 },
  panel: {
    position: "absolute",
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  header: {
    height: 29,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerText: { fontSize: 11, fontWeight: "600" },
  row: {
    minHeight: 34,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 5,
  },
  rowText: { flex: 1, fontSize: 12 },
  value: { fontSize: 12, textTransform: "capitalize" },
  chevron: { fontSize: 14, width: 12, textAlign: "center" },
  option: {
    minHeight: 34,
    paddingLeft: 30,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 8,
  },
  optionText: { fontSize: 12, textTransform: "capitalize" },
  activeText: { fontWeight: "600" },
  check: { width: 14, fontSize: 13, textAlign: "center" },
  advisorAction: { fontSize: 12, flexShrink: 1 },
  icon: { width: 14, height: 14, flexShrink: 0 },
  sparkle: { fontSize: 16, lineHeight: 16, textAlign: "center", marginTop: -1 },
  plusHorizontal: {
    position: "absolute",
    left: 1,
    right: 1,
    top: 6,
    height: 1.5,
  },
  plusVertical: {
    position: "absolute",
    top: 1,
    bottom: 1,
    left: 6,
    width: 1.5,
  },
  clipOuter: {
    position: "absolute",
    width: 7,
    height: 12,
    left: 4,
    top: 1,
    borderWidth: 1.2,
    borderRadius: 4,
    transform: [{ rotate: "40deg" }],
  },
  clipInner: {
    position: "absolute",
    width: 3,
    height: 8,
    left: 6,
    top: 3,
    borderWidth: 1,
    borderRadius: 3,
    transform: [{ rotate: "40deg" }],
  },
  photoFrame: {
    position: "absolute",
    left: 1,
    top: 1,
    width: 12,
    height: 12,
    borderWidth: 1.2,
    borderRadius: 2,
  },
  photoSun: {
    position: "absolute",
    left: 4,
    top: 4,
    width: 2,
    height: 2,
    borderRadius: 1,
  },
  photoMountain: {
    position: "absolute",
    left: 4,
    bottom: 2,
    width: 7,
    height: 5,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    transform: [{ rotate: "45deg" }],
  },
  clipboard: {
    position: "absolute",
    left: 2,
    top: 2,
    width: 10,
    height: 12,
    borderWidth: 1.2,
    borderRadius: 2,
  },
  clipboardTop: {
    position: "absolute",
    left: 5,
    top: 0,
    width: 4,
    height: 4,
    borderWidth: 1,
    borderRadius: 1,
  },
  clipboardLine: { position: "absolute", left: 5, top: 8, width: 5, height: 1 },
  wrenchHead: {
    position: "absolute",
    width: 7,
    height: 7,
    top: 0,
    right: 0,
    borderWidth: 1.4,
    borderRadius: 4,
  },
  wrenchHandle: {
    position: "absolute",
    width: 2,
    height: 9,
    left: 4,
    bottom: 0,
    borderRadius: 1,
    transform: [{ rotate: "40deg" }],
  },
});
