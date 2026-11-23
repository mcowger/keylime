import { View } from "react-native";

export type ActivityIconName =
  | "read"
  | "search"
  | "edit"
  | "terminal"
  | "todo"
  | "task"
  | "code"
  | "web"
  | "hub"
  | "agent-message"
  | "other"
  | "thinking"
  | "hidden"
  | "notice"
  | "job"
  | "developer"
  | "chevron";

type Direction = "right" | "down" | "left" | "up";

export function ActivityIcon({
  name,
  color,
  size = 14,
  direction = "right",
  expanded,
}: {
  name: ActivityIconName;
  color: string;
  size?: number;
  direction?: Direction;
  expanded?: boolean;
}) {
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const width = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    return (
      <View
        style={{
          position: "absolute",
          left: (x1 + x2 - width) / 2,
          top: (y1 + y2) / 2 - 0.55,
          width,
          height: 1.1,
          borderRadius: 0.55,
          backgroundColor: color,
          transform: [{ rotate: `${angle}rad` }],
        }}
      />
    );
  };
  const outline = (
    x: number,
    y: number,
    width: number,
    height: number,
    radius = 0,
  ) => (
    <View
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        borderWidth: 1.1,
        borderColor: color,
        borderRadius: radius,
      }}
    />
  );
  const dot = (x: number, y: number, size = 1.4) => (
    <View
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  );

  const chevronDirection =
    expanded === undefined ? direction : expanded ? "down" : "right";
  const chevronRotation = {
    right: "0deg",
    down: "90deg",
    left: "180deg",
    up: "-90deg",
  }[chevronDirection];

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      <View
        style={{
          position: "absolute",
          left: (size - 14) / 2,
          top: (size - 14) / 2,
          width: 14,
          height: 14,
          transform: [{ scale: size / 14 }],
        }}
      >
        {name === "read" && (
          <>
            {outline(3, 1.5, 8, 11, 1)}
            {line(5, 5, 9, 5)}
            {line(5, 7.5, 9, 7.5)}
            {line(5, 10, 8, 10)}
          </>
        )}
        {name === "search" && (
          <>
            {outline(1.5, 1.5, 8, 8, 4)}
            {line(8.5, 8.5, 12.5, 12.5)}
          </>
        )}
        {name === "edit" && (
          <>
            {line(8, 2, 3, 2)}
            {line(3, 2, 3, 12)}
            {line(3, 12, 8, 12)}
            {line(8, 2, 10, 4)}
            {line(8, 2, 8, 4)}
            {line(8, 4, 10, 4)}
            {line(6, 10, 11.5, 4.5)}
            {line(7.5, 11, 13, 5.5)}
            {line(6, 10, 5.5, 11.5)}
            {line(5.5, 11.5, 7.5, 11)}
          </>
        )}
        {name === "terminal" && (
          <>
            {outline(1, 2, 12, 10, 1.5)}
            {line(3.2, 4.5, 5.5, 6.5)}
            {line(5.5, 6.5, 3.2, 8.5)}
            {line(7, 9, 10.5, 9)}
          </>
        )}
        {name === "todo" && (
          <>
            {outline(1.5, 1.5, 11, 11, 1.5)}
            {line(4, 7, 6, 9)}
            {line(6, 9, 10, 5)}
          </>
        )}
        {name === "task" && (
          <>
            {outline(2, 4, 10, 8, 2)}
            {line(7, 2, 7, 4)}
            {dot(7, 1.5)}
            {line(1, 7, 2, 7)}
            {line(12, 7, 13, 7)}
            {dot(5, 7)}
            {dot(9, 7)}
            {line(5, 10, 9, 10)}
          </>
        )}
        {name === "code" && (
          <>
            {line(4.5, 3.5, 1.5, 7)}
            {line(1.5, 7, 4.5, 10.5)}
            {line(9.5, 3.5, 12.5, 7)}
            {line(12.5, 7, 9.5, 10.5)}
            {line(8.5, 2, 5.5, 12)}
          </>
        )}
        {name === "web" && (
          <>
            {outline(1, 1, 12, 12, 6)}
            {outline(4, 1, 6, 12, 3)}
            {line(1.5, 5, 12.5, 5)}
            {line(1.5, 9, 12.5, 9)}
          </>
        )}
        {name === "hub" && (
          <>
            {outline(1, 1.5, 9, 7, 1.5)}
            {line(3, 8.5, 2, 10)}
            {line(2, 10, 5, 8.5)}
            {line(11, 4.5, 12.5, 4.5)}
            {line(12.5, 4.5, 12.5, 11)}
            {line(12.5, 11, 10.5, 9.5)}
            {line(10.5, 9.5, 6.5, 9.5)}
          </>
        )}
        {name === "agent-message" && (
          <>
            {outline(1.5, 1.5, 11, 10, 5)}
            {line(3.5, 10.5, 2.5, 12.5)}
            {line(2.5, 12.5, 5.5, 11.2)}
          </>
        )}
        {name === "other" && (
          <>
            {line(8, 1.5, 7, 3)}
            {line(7, 3, 8, 5)}
            {line(8, 5, 10, 6)}
            {line(10, 6, 12, 5)}
            {line(12, 5, 12.5, 3)}
            {line(12.5, 3, 10.5, 4)}
            {line(10.5, 4, 9, 2.5)}
            {line(9, 2.5, 10, 1)}
            {line(8, 5.5, 2, 11.5)}
            {line(2, 11.5, 3.5, 13)}
            {line(3.5, 13, 9.5, 7)}
          </>
        )}
        {name === "thinking" && (
          <>
            {outline(1.5, 2, 6, 10, 3)}
            {outline(6.5, 2, 6, 10, 3)}
            {line(7, 2, 7, 12)}
            {line(2, 5, 4, 5)}
            {line(4, 5, 4.5, 6.5)}
            {line(2, 9, 4, 9)}
            {line(12, 5, 10, 5)}
            {line(10, 5, 9.5, 6.5)}
            {line(12, 9, 10, 9)}
          </>
        )}
        {name === "hidden" && (
          <>
            {line(1, 2, 13, 12)}
            {line(1, 7, 3, 4.8)}
            {line(3, 4.8, 5, 4)}
            {line(6.2, 3.8, 8, 4)}
            {line(8, 4, 11, 5)}
            {line(11, 5, 13, 7)}
            {line(13, 7, 11.4, 8.7)}
            {line(9.5, 10, 7, 10.3)}
            {line(7, 10.3, 4, 9.5)}
            {line(4, 9.5, 1, 7)}
          </>
        )}
        {name === "notice" && (
          <>
            {outline(1, 1, 12, 12, 6)}
            {line(7, 3.5, 7, 7.5)}
            {dot(7, 10)}
          </>
        )}
        {name === "job" && (
          <>
            {outline(1, 1, 12, 12, 6)}
            {line(7, 3.5, 7, 7)}
            {line(7, 7, 9.5, 8.5)}
          </>
        )}
        {name === "developer" && (
          <>
            {outline(1.5, 1.5, 11, 9, 2)}
            {line(4, 10.5, 3, 12.5)}
            {line(3, 12.5, 6, 10.5)}
            {line(4, 5, 10, 5)}
            {line(4, 7.5, 8, 7.5)}
          </>
        )}
        {name === "chevron" && (
          <View
            style={{
              width: 14,
              height: 14,
              transform: [{ rotate: chevronRotation }],
            }}
          >
            {line(5, 3.5, 8.5, 7)}
            {line(8.5, 7, 5, 10.5)}
          </View>
        )}
      </View>
    </View>
  );
}
