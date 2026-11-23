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
  Text: ({
    children,
    onPress,
  }: {
    children?: ReactNode;
    onPress?: React.MouseEventHandler<HTMLSpanElement>;
  }) => createElement("span", { onClick: onPress }, children),
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

test("tool disclosure shows a compact preview and makes full input optional", () => {
  const message: Message = {
    role: "assistant",
    model: "fixture",
    provider: "fixture",
    content: [
      {
        type: "toolCall",
        toolCallId: "read",
        toolName: "read",
        intent: "Inspect parser",
        input: { path: "src/parser.ts", limit: 10 },
      },
    ],
  };
  const saved: Message = {
    role: "toolResult",
    toolCallId: "read",
    content: [{ type: "text", text: "1: parser output" }],
    timestamp: 5000,
  };
  const ui = render(
    <ChatTranscript
      messages={[message, saved]}
      entryIds={["call", "result"]}
      cwd="/repo"
    />,
  );
  try {
    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    fireEvent.click(ui.getByRole("button", { name: /Inspect parser/ }));
    expect(ui.getByText("parser output")).toBeTruthy();
    expect(ui.queryByText("limit")).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "Show full input" }));
    expect(ui.getByText("limit")).toBeTruthy();
    expect(ui.getByText("10")).toBeTruthy();
  } finally {
    ui.unmount();
  }
});

test("a tool file target opens on its owning workspace without expanding the call", () => {
  const open = mock(() => {});
  const message: Message = {
    role: "assistant",
    model: "fixture",
    provider: "fixture",
    content: [
      {
        type: "toolCall",
        toolCallId: "file",
        toolName: "read",
        input: { path: "src/file.ts:9" },
      },
    ],
  };
  const ui = render(
    <ChatTranscript
      messages={[message]}
      entryIds={["call"]}
      cwd="/remote/workspace"
      onOpenActivityTarget={open}
    />,
  );
  try {
    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    fireEvent.click(ui.getByText("src/file.ts:9"));
    expect(open).toHaveBeenCalledWith("file", "/remote/workspace/src/file.ts");
    expect(ui.queryByRole("button", { name: "Show full input" })).toBeNull();
  } finally {
    ui.unmount();
  }
});

test("thinking and hidden todo reminders match the compact activity timeline", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      model: "fixture",
      provider: "fixture",
      content: [{ type: "thinking", thinking: "Private reasoning body" }],
    },
    {
      role: "custom",
      customType: "mid-run-todo-nudge",
      display: false,
      content: "<system-reminder>6 todo items still open.</system-reminder>",
    },
  ];
  const ui = render(
    <ChatTranscript messages={messages} entryIds={["thinking", "reminder"]} />,
  );
  try {
    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    expect(ui.getByRole("button", { name: "Thinking" })).toBeTruthy();
    expect(ui.queryByText("Private reasoning body")).toBeNull();
    expect(
      ui.getByRole("button", {
        name: /Todo reminder · hidden.*6 todo items still open/,
      }),
    ).toBeTruthy();
    fireEvent.click(ui.getByRole("button", { name: "Thinking" }));
    expect(ui.getByText("Private reasoning body")).toBeTruthy();
  } finally {
    ui.unmount();
  }
});

test("long eval input stays behind the full input disclosure", () => {
  const code = `${"long payload ".repeat(40)}END_OF_CODE`;
  const message: Message = {
    role: "assistant",
    model: "fixture",
    provider: "fixture",
    content: [
      {
        type: "toolCall",
        toolCallId: "eval",
        toolName: "eval",
        input: { language: "py", code },
      },
    ],
  };
  const ui = render(
    <ChatTranscript messages={[message]} entryIds={["eval"]} />,
  );
  try {
    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    fireEvent.click(ui.getByRole("button", { name: /Py/ }));
    expect(ui.queryByText(/END_OF_CODE/)).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "Show full input" }));
    expect(ui.getByText(code)).toBeTruthy();
  } finally {
    ui.unmount();
  }
});

test("plan approval hides the internal abort marker but keeps real errors and the implementation", () => {
  const ui = render(
    <ChatTranscript
      messages={[
        {
          role: "assistant",
          model: "fixture",
          provider: "fixture",
          content: [],
          stopReason: "aborted",
          errorMessage: "__omp.silent_abort__",
        },
        {
          role: "assistant",
          model: "fixture",
          provider: "fixture",
          content: [],
          stopReason: "error",
          errorMessage: "Provider unavailable",
        },
        {
          role: "assistant",
          model: "fixture",
          provider: "fixture",
          content: [{ type: "text", text: "Implementation started" }],
        },
      ]}
      entryIds={["internal", "error", "result"]}
    />,
  );
  expect(ui.queryByText("__omp.silent_abort__")).toBeNull();
  expect(ui.getByText("Provider unavailable")).toBeTruthy();
  expect(ui.getByText("Implementation started")).toBeTruthy();
  ui.unmount();
});
