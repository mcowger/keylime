import { useRef, useState } from "react";
import {
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

type Props = {
  levels: string[];
  value: string;
  disabled: boolean;
  dim: string;
  border: string;
  accent: string;
  planEnabled: boolean;
  planUnknown: boolean;
  planDisabled: boolean;
  prewalk: "off" | "suggest" | "on" | null;
  onPlanChange: (enabled: boolean) => void;
  onPrewalkChange: (mode: "off" | "suggest" | "on") => void;
  onChange: (level: string) => void;
};

/** The Auto selector is separate from the model's discrete manual effort ladder. */
export function NativeReasoningSlider({
  levels,
  value,
  disabled,
  dim,
  border,
  accent,
  planEnabled,
  planUnknown,
  planDisabled,
  prewalk,
  onPlanChange,
  onPrewalkChange,
  onChange,
}: Props) {
  const manual = levels.filter((level) => level !== "auto");
  const { width: screenWidth } = useWindowDimensions();
  const manualWidth = Math.max(65, manual.length * 34, screenWidth - 132);
  const [width, setWidth] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const start = useRef(0);
  const currentIndex = Math.max(0, manual.indexOf(value));
  const index = preview ?? currentIndex;
  const indexAt = (x: number) =>
    Math.max(
      0,
      Math.min(
        manual.length - 1,
        Math.round((x / Math.max(width, 1)) * (manual.length - 1)),
      ),
    );
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled && manual.length > 1,
    onMoveShouldSetPanResponder: () => !disabled && manual.length > 1,
    onPanResponderGrant: (event) => {
      start.current = event.nativeEvent.locationX;
      setPreview(indexAt(start.current));
    },
    onPanResponderMove: (_event, gesture) =>
      setPreview(indexAt(start.current + gesture.dx)),
    onPanResponderRelease: (_event, gesture) => {
      const level = manual[indexAt(start.current + gesture.dx)];
      setPreview(null);
      if (level) onChange(level);
    },
    onPanResponderTerminate: () => setPreview(null),
  });
  return (
    <View style={[styles.container, { borderColor: border }]}>
      <View style={[styles.modes, { borderColor: border }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            planUnknown
              ? "Plan mode unavailable"
              : planEnabled
                ? "Switch to Build mode"
                : "Switch to Plan mode"
          }
          accessibilityState={{ selected: planEnabled, disabled: planDisabled }}
          disabled={planDisabled}
          onPress={() => onPlanChange(!planEnabled)}
          style={styles.modeButton}
        >
          <View style={styles.hammer}>
            <View
              style={[
                styles.hammerHead,
                { borderColor: planEnabled ? accent : dim },
              ]}
            />
            <View
              style={[
                styles.hammerHandle,
                { backgroundColor: planEnabled ? accent : dim },
              ]}
            />
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Auto prewalk: ${prewalk ?? "default"}`}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() =>
            onPrewalkChange(
              prewalk === "off"
                ? "suggest"
                : prewalk === "suggest"
                  ? "on"
                  : "off",
            )
          }
          style={styles.modeButton}
        >
          <View style={styles.footprints}>
            <View
              style={[
                styles.foot,
                {
                  borderColor: prewalk === "on" ? accent : dim,
                  left: 3,
                  top: 1,
                },
              ]}
            />
            <View
              style={[
                styles.foot,
                {
                  borderColor: prewalk === "on" ? accent : dim,
                  right: 3,
                  bottom: 1,
                },
              ]}
            />
            <Text
              style={[
                styles.modeMark,
                { color: prewalk === "on" ? accent : dim },
              ]}
            >
              {prewalk === "suggest" ? "◐" : prewalk === "on" ? "●" : "○"}
            </Text>
          </View>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="radio"
            accessibilityLabel="Reasoning Auto"
            accessibilityState={{ checked: value === "auto", disabled }}
            disabled={disabled}
            onPress={() => onChange("auto")}
            style={styles.detent}
          >
            <Text style={{ color: value === "auto" ? accent : dim }}>
              {value === "auto" ? "●" : "○"}
            </Text>
            <Text
              style={{ color: value === "auto" ? accent : dim, fontSize: 11 }}
            >
              Auto
            </Text>
          </Pressable>
          {manual.length > 0 && (
            <View style={{ width: manualWidth }}>
              <View
                accessibilityRole="adjustable"
                accessibilityLabel="Change reasoning"
                accessibilityValue={{
                  min: 0,
                  max: manual.length - 1,
                  now: index,
                  text:
                    value === "auto" && preview === null
                      ? "Auto"
                      : manual[index],
                }}
                accessibilityState={{ disabled }}
                accessibilityActions={[
                  { name: "increment" },
                  { name: "decrement" },
                ]}
                onAccessibilityAction={(event) => {
                  if (disabled) return;
                  const delta =
                    event.nativeEvent.actionName === "increment" ? 1 : -1;
                  const level =
                    manual[
                      Math.max(
                        0,
                        Math.min(manual.length - 1, currentIndex + delta),
                      )
                    ];
                  if (level) onChange(level);
                }}
                onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
                {...responder.panHandlers}
                style={[
                  styles.track,
                  {
                    marginHorizontal:
                      manual.length > 1 ? manualWidth / manual.length / 2 : 0,
                  },
                ]}
              >
                <View
                  pointerEvents="none"
                  style={[styles.line, { backgroundColor: border }]}
                />
                {manual.map((level, position) => (
                  <View
                    key={level}
                    pointerEvents="none"
                    style={[
                      styles.detentDot,
                      {
                        borderColor: dim,
                        left:
                          manual.length === 1
                            ? "50%"
                            : `${(position / (manual.length - 1)) * 100}%`,
                      },
                    ]}
                  />
                ))}
                <View
                  pointerEvents="none"
                  style={[
                    styles.thumb,
                    {
                      backgroundColor:
                        value === "auto" && preview === null
                          ? "transparent"
                          : accent,
                      left:
                        manual.length === 1
                          ? "50%"
                          : `${(index / (manual.length - 1)) * 100}%`,
                    },
                  ]}
                />
              </View>
              <View style={styles.labels}>
                {manual.map((level) => (
                  <Pressable
                    key={level}
                    accessibilityRole="radio"
                    accessibilityLabel={`Reasoning ${level}`}
                    accessibilityState={{ checked: value === level, disabled }}
                    disabled={disabled}
                    onPress={() => onChange(level)}
                    style={styles.manualDetent}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        color: value === level ? accent : dim,
                        fontSize: 11,
                        textTransform: "capitalize",
                      }}
                    >
                      {level}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    minHeight: 70,
  },
  modes: { width: 54, borderRightWidth: StyleSheet.hairlineWidth },
  modeButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 34,
  },
  hammer: { width: 24, height: 24, transform: [{ rotate: "-42deg" }] },
  hammerHead: {
    position: "absolute",
    width: 16,
    height: 7,
    left: 4,
    top: 2,
    borderWidth: 1.5,
    borderRadius: 2,
  },
  hammerHandle: {
    position: "absolute",
    width: 2,
    height: 14,
    left: 11,
    top: 8,
    borderRadius: 1,
  },
  footprints: { width: 22, height: 22 },
  foot: {
    position: "absolute",
    width: 6,
    height: 11,
    borderWidth: 1.5,
    borderRadius: 4,
    transform: [{ rotate: "-15deg" }],
  },
  modeMark: { position: "absolute", right: -3, bottom: -5, fontSize: 9 },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
  },
  detent: { width: 46, alignItems: "center", paddingVertical: 5 },
  track: { height: 24, justifyContent: "center" },
  line: { height: 2, width: "100%" },
  detentDot: {
    position: "absolute",
    width: 8,
    height: 8,
    borderWidth: 1,
    borderRadius: 4,
    marginLeft: -4,
    top: 8,
  },
  thumb: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 5,
    marginLeft: -5,
    top: 7,
  },
  labels: { flexDirection: "row" },
  manualDetent: { flex: 1, alignItems: "center", paddingBottom: 5 },
});
