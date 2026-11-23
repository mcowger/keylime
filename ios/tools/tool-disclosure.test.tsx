import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import type * as React from "react";
import type { ReactNode } from "react";
import "../../tests/setup-dom";
import type { ChatTranscriptProps } from "../ChatTranscript";
import {
  applyCoveredToolEvent,
  applyToolEvent,
  reconcileToolSnapshot,
} from "../chat-tool-state";

// The DOM renderer and transcript must share the root React dispatcher.
const react = createRequire(new URL("../../package.json", import.meta.url))(
  "react",
) as typeof React;
const { createElement } = react;
mock.module("../node_modules/react/index.js", () => react);
mock.module("../AuthenticatedMedia", () => ({
  AuthenticatedMedia: () => null,
}));
mock.module("../node_modules/react-native/index.js", () => ({
  View: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  Image: () => null,
  ActivityIndicator: () => null,
  Modal: () => null,
  Linking: { openURL: async () => {} },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useColorScheme: () => "dark",
  Pressable: ({
    children,
    onPress,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress?: () => void;
    accessibilityState?: { expanded?: boolean };
  }) =>
    createElement(
      "button",
      { onClick: onPress, "aria-expanded": accessibilityState?.expanded },
      children,
    ),
  FlatList: ({
    data,
    keyExtractor,
    renderItem,
  }: {
    data: unknown[];
    keyExtractor: (row: unknown) => string;
    renderItem: (props: { item: unknown }) => ReactNode;
  }) =>
    createElement(
      "div",
      null,
      data.map((item) =>
        createElement("div", { key: keyExtractor(item) }, renderItem({ item })),
      ),
    ),
}));

const { render, fireEvent } = await import("@testing-library/react");
const { ChatTranscript } = await import("../ChatTranscript");
type Message = ChatTranscriptProps["messages"][number];
const call = (id: string): Message => ({
  role: "assistant",
  model: "fixture",
  provider: "fixture",
  content: [
    { type: "toolCall", toolCallId: id, toolName: `tool-${id}`, input: {} },
  ],
});
const result = (text: string): Extract<Message, { role: "toolResult" }> => ({
  role: "toolResult",
  toolCallId: "B",
  isError: true,
  content: [{ type: "text", text }],
});

test.each([false, true])(
  "live tool B stays open across saved-row merge (buffered end: %s)",
  (buffered) => {
    const a = call("A");
    const b = call("B");
    const end = {
      type: "tool_execution_end",
      toolCallId: "B",
      isError: true,
      result: result("retained failure"),
    };
    const before = buffered
      ? { B: { ...result("in progress"), partial: true } }
      : applyToolEvent({}, end, [a]);
    const snapshot = reconcileToolSnapshot(before, [], [a, b]);
    const retained = buffered
      ? applyCoveredToolEvent(snapshot, end, [a, b])
      : snapshot;
    const ui = render(
      <ChatTranscript
        messages={[a]}
        entryIds={["a"]}
        liveMessage={b}
        toolResults={before}
      />,
    );
    try {
      fireEvent.click(
        ui.getAllByRole("button", { name: /Process details/ })[1],
      );
      fireEvent.click(ui.getByRole("button", { name: /tool-B/ }));
      expect(
        ui.getAllByText(buffered ? "in progress" : "retained failure"),
      ).toHaveLength(1);

      ui.rerender(
        <ChatTranscript
          messages={[a, b]}
          entryIds={["a", "b"]}
          toolResults={retained}
        />,
      );
      expect(
        ui
          .getByRole("button", { name: /Process details/ })
          .getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        ui
          .getByRole("button", { name: /tool-B/ })
          .getAttribute("aria-expanded"),
      ).toBe("true");
      expect(ui.getAllByText("retained failure")).toHaveLength(1);

      ui.rerender(
        <ChatTranscript
          messages={[a, b, result("saved failure")]}
          entryIds={["a", "b", "result-b"]}
        />,
      );
      expect(ui.queryByText("retained failure")).toBeNull();
      expect(ui.getAllByText("saved failure")).toHaveLength(1);
    } finally {
      ui.unmount();
    }
  },
);
