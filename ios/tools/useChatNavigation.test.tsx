import "../../tests/setup-dom.ts";
import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import type * as ReactTypes from "react";
import type { BrowserLink, BrowserLinkHandlers } from "../browser-link";
import type { ChatTranscriptProps } from "../ChatTranscript";
import type { ChatContext } from "../useChatSession";
import { TranscriptFollowIntents } from "../transcript-follow-intents";

const React = createRequire(new URL("../../package.json", import.meta.url))(
  "react",
) as typeof ReactTypes;
mock.module(
  createRequire(new URL("../useChatSession.ts", import.meta.url)).resolve(
    "react",
  ),
  () => React,
);
type ScrollEvent = {
  nativeEvent: {
    contentOffset: { y: number };
    contentSize: { height: number };
    layoutMeasurement: { height: number };
    velocity?: { x: number; y: number };
  };
};
let listEvents: {
  data?: unknown[];
  onContentSizeChange?: (width?: number, height?: number) => void;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  onScroll?: (event: ScrollEvent) => void;
  onScrollBeginDrag?: () => void;
  onScrollEndDrag?: (event: ScrollEvent) => void;
  onMomentumScrollBegin?: () => void;
  onMomentumScrollEnd?: (event: ScrollEvent) => void;
} = {};
const scrollCalls: { animated: boolean }[] = [];
let countedTextRenders = 0;
let screenReaderEnabled = false;
let readScreenReader = () => Promise.resolve(screenReaderEnabled);
let screenReaderChange: ((enabled: boolean) => void) | undefined;
mock.module("../AuthenticatedMedia", () => ({
  AuthenticatedMedia: () => null,
}));
mock.module("../ChatMarkdown", () => ({ ChatMarkdown: () => null }));
mock.module("../TranscriptIcons", () => ({ TranscriptIcon: () => null }));
mock.module("../node_modules/react-native/index.js", () => ({
  AccessibilityInfo: {
    isScreenReaderEnabled: () => readScreenReader(),
    addEventListener: (
      _event: string,
      listener: (enabled: boolean) => void,
    ) => {
      screenReaderChange = listener;
      return {
        remove() {
          if (screenReaderChange === listener) screenReaderChange = undefined;
        },
      };
    },
  },
  View: ({ children }: { children?: ReactTypes.ReactNode }) =>
    React.createElement("div", null, children),
  Text: ({ children }: { children?: ReactTypes.ReactNode }) => {
    if (children === "Counting first message") countedTextRenders += 1;
    return React.createElement("span", null, children);
  },
  ScrollView: ({ children }: { children?: ReactTypes.ReactNode }) =>
    React.createElement("div", null, children),
  Image: () => null,
  ActivityIndicator: () => null,
  Modal: () => null,
  Linking: { openURL: async () => {} },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useColorScheme: () => "dark",
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children?: ReactTypes.ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) =>
    React.createElement(
      "button",
      { "aria-label": accessibilityLabel, onClick: onPress },
      children,
    ),
  FlatList: ({
    data,
    keyExtractor,
    renderItem,
    onContentSizeChange,
    onLayout,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    ref,
  }: {
    data: unknown[];
    keyExtractor: (row: unknown) => string;
    renderItem: (props: { item: unknown }) => ReactTypes.ReactNode;
    onContentSizeChange?: typeof listEvents.onContentSizeChange;
    onLayout?: typeof listEvents.onLayout;
    onScroll?: typeof listEvents.onScroll;
    onScrollBeginDrag?: typeof listEvents.onScrollBeginDrag;
    onScrollEndDrag?: typeof listEvents.onScrollEndDrag;
    onMomentumScrollBegin?: typeof listEvents.onMomentumScrollBegin;
    onMomentumScrollEnd?: typeof listEvents.onMomentumScrollEnd;
    ref?: ReactTypes.Ref<{
      scrollToEnd: (options: { animated: boolean }) => void;
    }>;
  }) => {
    React.useImperativeHandle(
      ref,
      () => ({
        scrollToEnd: (options) => {
          scrollCalls.push(options);
        },
      }),
      [],
    );
    listEvents = {
      data,
      onContentSizeChange,
      onLayout,
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    };
    return React.createElement(
      "div",
      null,
      data.map((item) =>
        React.createElement(
          "div",
          { key: keyExtractor(item) },
          renderItem({ item }),
        ),
      ),
    );
  },
}));
class BrowserLinkError extends Error {}
class KeylimeHttpError extends Error {
  kind = "http";
  status = 500;
}
const requests: {
  origin: string;
  path: string;
  response: PromiseWithResolvers<unknown>;
}[] = [];
mock.module("../browser-link", () => ({ BrowserLinkError }));
mock.module("../keylime-http", () => ({
  KeylimeHttpError,
  requestJson(origin: string, path: string) {
    const response = Promise.withResolvers<unknown>();
    requests.push({ origin, path, response });
    return response.promise;
  },
}));
function firstUserContent(value: ChatContext | null) {
  const message = value?.messages[0];
  return message?.role === "user" ? message.content : undefined;
}

// Load after installing mocks so the hook uses the DOM renderer's React instance.
const { act, cleanup, fireEvent, render, renderHook, waitFor } =
  await import("@testing-library/react/pure.js");
const { useChatSession } = await import("../useChatSession");
const { ChatTranscript } = await import("../ChatTranscript");

class FakeLink {
  subscriptions = new Set<string>();
  subscribe(
    channel: { kind: string; hostId?: string; sessionId?: string },
    _handlers: BrowserLinkHandlers,
  ) {
    const key = JSON.stringify(channel);
    this.subscriptions.add(key);
    return () => this.subscriptions.delete(key);
  }
}
const context = (id: string, text: string) => ({
  messages: [{ role: "user", content: text, timestamp: 1 }],
  entryIds: [id],
});
const state = {
  state: null,
  outbox: [],
  outboxSettledIds: [],
  nativeSettledIds: [],
};
function take(part: string) {
  const index = requests.findIndex((request) => request.path.includes(part));
  if (index < 0) throw new Error(`Missing request ${part}`);
  return requests.splice(index, 1)[0];
}
async function resolve(
  response: PromiseWithResolvers<unknown>,
  value: unknown,
) {
  await act(async () => response.resolve(value));
}
async function load(session: string, entry: string, text: string) {
  await resolve(take(`/api/sessions/${session}?`).response, {
    context: context(entry, text),
    historyRevision: "r1",
    historyHasMore: false,
  });
  await resolve(take(`/api/sessions/${session}/state`).response, state);
  await resolve(take(`/api/sessions/${session}/context`).response, {
    mode: "append",
    sessionId: session,
    baseEntryId: entry,
    context: { messages: [], entryIds: [] },
    cursor: { firstEntryId: entry, lastEntryId: entry },
    hasMore: false,
  });
}

test("switching chats retains history, fences late responses, and reconciles changed branches", async () => {
  const link = new FakeLink();
  const view = renderHook(
    ({ origin, hostId, sessionId }) =>
      useChatSession({
        openSessionKeys: new Set(
          ["a", "b"].map((id) => JSON.stringify([origin, hostId, id])),
        ),
        origin,
        hostId,
        sessionId,
        link: link as unknown as BrowserLink,
      }),
    {
      initialProps: {
        origin: "https://one.test",
        hostId: "host-a",
        sessionId: "a",
      },
    },
  );
  try {
    await load("a", "a1", "First chat");
    expect(firstUserContent(view.result.current.context)).toBe("First chat");
    view.rerender({
      origin: "https://one.test",
      hostId: "host-a",
      sessionId: "b",
    });
    const lateB = take("/api/sessions/b?");
    view.rerender({
      origin: "https://one.test",
      hostId: "host-a",
      sessionId: "a",
    });
    expect(firstUserContent(view.result.current.context)).toBe("First chat");
    expect(
      requests.some((request) => request.path.includes("/api/sessions/a?")),
    ).toBe(false);
    expect(link.subscriptions.size).toBe(2);
    await resolve(lateB.response, {
      context: context("b1", "Wrong chat"),
      historyRevision: "r1",
      historyHasMore: false,
    });
    expect(firstUserContent(view.result.current.context)).toBe("First chat");
    await resolve(take("/api/sessions/a/state").response, state);
    await resolve(take("/api/sessions/a/context").response, {
      mode: "replace",
      sessionId: "a",
      context: context("branch", "Changed branch"),
      cursor: { firstEntryId: "branch", lastEntryId: "branch" },
      hasMore: false,
    });
    await waitFor(() =>
      expect(firstUserContent(view.result.current.context)).toBe(
        "Changed branch",
      ),
    );
    expect(view.result.current.historyView).toBe(1);

    view.rerender({
      origin: "https://one.test",
      hostId: "host-b",
      sessionId: "a",
    });
    expect(view.result.current.context).toBeNull();
    const otherHost = take("/api/sessions/a?");
    expect(otherHost.path).toContain("hostId=host-b");
    view.rerender({
      origin: "https://two.test",
      hostId: "host-a",
      sessionId: "a",
    });
    expect(view.result.current.context).toBeNull();
    const otherOrigin = take("/api/sessions/a?");
    expect(otherOrigin.origin).toBe("https://two.test");
    await resolve(otherHost.response, {
      context: context("other", "Other host"),
      historyRevision: "r1",
      historyHasMore: false,
    });
    expect(view.result.current.context).toBeNull();
    expect(link.subscriptions.size).toBe(2);
  } finally {
    view.unmount();
    cleanup();
    requests.length = 0;
  }
});

test("all open chats retain history and closing a tab discards its snapshot", async () => {
  const link = new FakeLink();
  const ids = ["one", "two", "three", "four", "five", "six"];
  const origin = "https://one.test";
  const hostId = "host-a";
  const view = renderHook(
    ({ sessionId, open }) =>
      useChatSession({
        origin,
        hostId,
        sessionId,
        openSessionKeys: new Set(
          open.map((id) => JSON.stringify([origin, hostId, id])),
        ),
        link: link as unknown as BrowserLink,
      }),
    { initialProps: { sessionId: ids[0], open: ids } },
  );
  try {
    for (const id of ids) {
      if (id !== ids[0]) view.rerender({ sessionId: id, open: ids });
      await load(id, `${id}-entry`, `Message ${id}`);
      expect(link.subscriptions.size).toBe(2);
    }
    for (const id of ids) {
      view.rerender({ sessionId: id, open: ids });
      expect(firstUserContent(view.result.current.context)).toBe(
        `Message ${id}`,
      );
      const messages = view.result.current.context?.messages;
      const entryIds = view.result.current.context?.entryIds;
      expect(
        requests.some((request) =>
          request.path.includes(`/api/sessions/${id}?`),
        ),
      ).toBe(false);
      await resolve(take(`/api/sessions/${id}/state`).response, state);
      await resolve(take(`/api/sessions/${id}/context`).response, {
        mode: "append",
        sessionId: id,
        baseEntryId: `${id}-entry`,
        context: { messages: [], entryIds: [] },
        cursor: { firstEntryId: `${id}-entry`, lastEntryId: `${id}-entry` },
        hasMore: false,
      });
      expect(view.result.current.context?.messages).toBe(messages);
      expect(view.result.current.context?.entryIds).toBe(entryIds);
    }
    view.rerender({ sessionId: ids[0], open: ids });
    expect(firstUserContent(view.result.current.context)).toBe("Message one");
    const oldRead = take("/api/sessions/one/state");
    const remaining = ids.slice(1);
    view.rerender({ sessionId: ids[1], open: remaining });
    expect(firstUserContent(view.result.current.context)).toBe("Message two");
    await resolve(oldRead.response, state);
    view.rerender({ sessionId: ids[0], open: ids });
    expect(view.result.current.context).toBeNull();
    expect(take("/api/sessions/one?").origin).toBe(origin);
    expect(link.subscriptions.size).toBe(2);
  } finally {
    view.unmount();
    cleanup();
    requests.length = 0;
  }
});

test("hidden transcript layout does not change its follow position", () => {
  const message: ChatTranscriptProps["messages"][number] = {
    role: "user",
    content: "Scroll position",
    timestamp: 1,
  };
  const transcript = (visible: boolean) => (
    <ChatTranscript
      messages={[message]}
      entryIds={["scroll"]}
      visible={visible}
    />
  );
  const ui = render(transcript(true));
  try {
    act(() =>
      listEvents.onLayout?.({ nativeEvent: { layout: { height: 500 } } }),
    );
    act(() => listEvents.onContentSizeChange?.());
    ui.rerender(transcript(false));
    act(() =>
      listEvents.onScroll?.({
        nativeEvent: {
          contentOffset: { y: 0 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 0 },
        },
      }),
    );
    ui.rerender(transcript(true));
    expect(
      ui.queryByRole("button", { name: "Jump to latest message" }),
    ).toBeNull();
    act(() => listEvents.onScrollBeginDrag?.());
    act(() =>
      listEvents.onScroll?.({
        nativeEvent: {
          contentOffset: { y: 100 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 500 },
        },
      }),
    );
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();
    ui.rerender(transcript(false));
    act(() =>
      listEvents.onScroll?.({
        nativeEvent: {
          contentOffset: { y: 500 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 500 },
        },
      }),
    );
    ui.rerender(transcript(true));
    act(() =>
      listEvents.onScroll?.({
        nativeEvent: {
          contentOffset: { y: 0 },
          contentSize: { height: 0 },
          layoutMeasurement: { height: 500 },
        },
      }),
    );
    act(() =>
      listEvents.onScroll?.({
        nativeEvent: {
          contentOffset: { y: 1965 },
          contentSize: { height: 581 },
          layoutMeasurement: { height: 632 },
        },
      }),
    );
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();
    act(() => listEvents.onScrollBeginDrag?.());
    act(() =>
      listEvents.onMomentumScrollEnd?.({
        nativeEvent: {
          contentOffset: { y: 500 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 500 },
        },
      }),
    );
    expect(
      ui.queryByRole("button", { name: "Jump to latest message" }),
    ).toBeNull();
  } finally {
    ui.unmount();
  }
});

test("unchanged transcript rows retain rendering while actions stay current", () => {
  countedTextRenders = 0;
  const messages: ChatTranscriptProps["messages"] = [
    { role: "user", content: "Counting first message", timestamp: 1 },
  ];
  const entryIds = ["first"];
  const copied: string[] = [];
  const edited: string[] = [];
  const props = {
    messages,
    entryIds,
    onCopy: (text: string) => copied.push(`old:${text}`),
    onEdit: () => edited.push("old"),
    onFork: () => {},
    canFork: () => true,
  };
  const ui = render(<ChatTranscript {...props} />);
  try {
    const initialRenders = countedTextRenders;
    ui.rerender(<ChatTranscript {...props} visible={false} />);
    ui.rerender(
      <ChatTranscript
        {...props}
        visible
        onCopy={(text) => copied.push(text)}
        onEdit={() => edited.push("new")}
        canFork={() => true}
      />,
    );
    expect(countedTextRenders).toBe(initialRenders);
    fireEvent.click(ui.getByRole("button", { name: "Copy" }));
    fireEvent.click(ui.getByRole("button", { name: "Edit" }));
    expect(copied).toEqual(["Counting first message"]);
    expect(edited).toEqual(["new"]);
    ui.rerender(<ChatTranscript {...props} canFork={() => false} />);
    expect(ui.queryByRole("button", { name: "Fork" })).toBeNull();
    ui.rerender(
      <ChatTranscript
        {...props}
        messages={[
          ...messages,
          { role: "user", content: "New message", timestamp: 2 },
        ]}
        entryIds={[...entryIds, "second"]}
      />,
    );
    expect(ui.getByText("New message")).toBeTruthy();
  } finally {
    ui.unmount();
  }
});

function scrollEvent(y: number, height = 1000, viewport = 500): ScrollEvent {
  return {
    nativeEvent: {
      contentOffset: { y },
      contentSize: { height },
      layoutMeasurement: { height: viewport },
    },
  };
}

function controlledFrames() {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++next;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    if (id != null) frames.delete(id);
  };
  return {
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      act(() => {
        for (const callback of callbacks) callback(0);
      });
    },
    restore() {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
    },
  };
}

test("stream and resize follow is coalesced and cannot overtake a drag or history page", () => {
  const frames = controlledFrames();
  scrollCalls.length = 0;
  let loads = 0;
  const messages: ChatTranscriptProps["messages"] = [
    { role: "user", content: "First", timestamp: 1 },
  ];
  const ui = render(
    <ChatTranscript
      messages={messages}
      entryIds={["first"]}
      historyHasMore
      onLoadOlder={() => {
        loads++;
      }}
    />,
  );
  try {
    act(() => {
      listEvents.onLayout?.({ nativeEvent: { layout: { height: 500 } } });
      listEvents.onContentSizeChange?.();
      listEvents.onContentSizeChange?.();
    });
    frames.flush();
    expect(scrollCalls).toEqual([{ animated: false }]);
    act(() => {
      listEvents.onContentSizeChange?.();
      listEvents.onLayout?.({ nativeEvent: { layout: { height: 400 } } });
      listEvents.onScroll?.(scrollEvent(100, 1100, 400));
      listEvents.onScrollBeginDrag?.();
      listEvents.onScroll?.(scrollEvent(0, 1100, 400));
      listEvents.onScroll?.(scrollEvent(0, 1100, 400));
    });
    frames.flush();
    expect(scrollCalls).toHaveLength(1);
    expect(loads).toBe(1);
    act(() => {
      listEvents.onScrollEndDrag?.(scrollEvent(0, 1100, 400));
      listEvents.onMomentumScrollBegin?.();
      listEvents.onMomentumScrollEnd?.(scrollEvent(100, 1100, 400));
    });
    ui.rerender(
      <ChatTranscript
        messages={[
          { role: "user", content: "Older", timestamp: 0 },
          ...messages,
        ]}
        entryIds={["older", "first"]}
        historyHasMore
        onLoadOlder={() => {
          loads++;
        }}
      />,
    );
    act(() => {
      listEvents.onContentSizeChange?.();
      listEvents.onScroll?.(scrollEvent(700, 1100, 400));
    });
    frames.flush();
    expect(scrollCalls).toHaveLength(1);
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();

    act(() => {
      listEvents.onScrollBeginDrag?.();
      listEvents.onScrollEndDrag?.(scrollEvent(699, 1100, 400));
    });
    frames.flush();
    frames.flush();
    expect(
      ui.queryByRole("button", { name: "Jump to latest message" }),
    ).toBeNull();
    expect(scrollCalls).toHaveLength(2);
  } finally {
    ui.unmount();
    frames.restore();
  }
});

test("accepted send waits for a gesture; a newer gesture or hidden tab supersedes it", () => {
  const frames = controlledFrames();
  scrollCalls.length = 0;
  const messages: ChatTranscriptProps["messages"] = [
    { role: "user", content: "First", timestamp: 1 },
  ];
  const view = (followRequest: number, visible = true) => (
    <ChatTranscript
      messages={messages}
      entryIds={["first"]}
      followRequest={followRequest}
      visible={visible}
    />
  );
  const ui = render(view(0));
  try {
    act(() => listEvents.onContentSizeChange?.());
    frames.flush();
    act(() => {
      listEvents.onScrollBeginDrag?.();
      listEvents.onScroll?.(scrollEvent(100));
    });
    ui.rerender(view(1));
    frames.flush();
    expect(scrollCalls).toHaveLength(1);
    act(() => listEvents.onMomentumScrollEnd?.(scrollEvent(100)));
    frames.flush();
    expect(scrollCalls).toHaveLength(2);
    expect(
      ui.queryByRole("button", { name: "Jump to latest message" }),
    ).toBeNull();

    act(() => listEvents.onScrollBeginDrag?.());
    ui.rerender(view(2));
    act(() => {
      listEvents.onScrollBeginDrag?.();
      listEvents.onMomentumScrollEnd?.(scrollEvent(100));
    });
    frames.flush();
    expect(scrollCalls).toHaveLength(2);
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();

    act(() => listEvents.onScrollBeginDrag?.());
    ui.rerender(view(3));
    ui.rerender(view(3, false));
    ui.rerender(view(3, true));
    frames.flush();
    expect(scrollCalls).toHaveLength(2);
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();
  } finally {
    ui.unmount();
    frames.restore();
  }
});

test("live text changes retain saved row identity", () => {
  const messages: ChatTranscriptProps["messages"] = [
    { role: "user", content: "Counting first message", timestamp: 1 },
  ];
  const ids = ["first"];
  const live = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
  });
  countedTextRenders = 0;
  const ui = render(
    <ChatTranscript
      messages={messages}
      entryIds={ids}
      liveMessage={live("one")}
    />,
  );
  try {
    const savedRow = listEvents.data?.[0];
    const rendered = countedTextRenders;
    ui.rerender(
      <ChatTranscript
        messages={messages}
        entryIds={ids}
        liveMessage={live("two")}
      />,
    );
    expect(listEvents.data?.[0]).toBe(savedRow);
    expect(countedTextRenders).toBe(rendered);
  } finally {
    ui.unmount();
  }
});

test("delayed send receipts cannot override newer scrolling or navigation", async () => {
  const frames = controlledFrames();
  scrollCalls.length = 0;
  const receipts = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  const messages: ChatTranscriptProps["messages"] = [
    { role: "user", content: "First", timestamp: 1 },
  ];
  const ids = ["first"];
  function Consumer({ selection }: { selection: string }) {
    const intents = React.useRef(new TranscriptFollowIntents());
    const [followRequest, setFollowRequest] = React.useState(0);
    const nextReceipt = React.useRef(0);
    intents.current.select(selection);
    async function send() {
      const ticket = intents.current.begin("chat");
      await receipts[nextReceipt.current++].promise;
      if (intents.current.accepts(ticket))
        setFollowRequest((value) => value + 1);
    }
    return (
      <>
        <button onClick={() => void send()}>Send</button>
        <ChatTranscript
          messages={messages}
          entryIds={ids}
          visible={selection === "chat"}
          followRequest={followRequest}
          onUserGesture={() => intents.current.gesture("chat")}
        />
      </>
    );
  }
  const ui = render(<Consumer selection="chat" />);
  try {
    act(() => listEvents.onContentSizeChange?.());
    frames.flush();
    fireEvent.click(ui.getByRole("button", { name: "Send" }));
    act(() => {
      listEvents.onScrollBeginDrag?.();
      listEvents.onScroll?.(scrollEvent(100));
      listEvents.onMomentumScrollEnd?.(scrollEvent(100));
    });
    await act(async () => {
      receipts[0].resolve();
      await receipts[0].promise;
    });
    frames.flush();
    expect(scrollCalls).toHaveLength(1);
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();

    fireEvent.click(ui.getByRole("button", { name: "Send" }));
    ui.rerender(<Consumer selection="other" />);
    ui.rerender(<Consumer selection="chat" />);
    await act(async () => {
      receipts[1].resolve();
      await receipts[1].promise;
    });
    frames.flush();
    expect(scrollCalls).toHaveLength(1);
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();

    act(() => listEvents.onScrollBeginDrag?.());
    fireEvent.click(ui.getByRole("button", { name: "Send" }));
    await act(async () => {
      receipts[2].resolve();
      await receipts[2].promise;
    });
    frames.flush();
    expect(scrollCalls).toHaveLength(1);
    act(() => listEvents.onMomentumScrollEnd?.(scrollEvent(100)));
    frames.flush();
    expect(scrollCalls).toHaveLength(2);
    expect(
      ui.queryByRole("button", { name: "Jump to latest message" }),
    ).toBeNull();
  } finally {
    ui.unmount();
    frames.restore();
  }
});

test("closing an inspected disclosure reattaches only at the actual end", () => {
  const frames = controlledFrames();
  scrollCalls.length = 0;
  const messages: ChatTranscriptProps["messages"] = [
    {
      role: "assistant",
      model: "fixture",
      provider: "fixture",
      content: [
        { type: "toolCall", toolCallId: "tool", toolName: "read", input: {} },
      ],
    },
  ];
  const ui = render(<ChatTranscript messages={messages} entryIds={["call"]} />);
  try {
    act(() => {
      listEvents.onLayout?.({ nativeEvent: { layout: { height: 500 } } });
      listEvents.onContentSizeChange?.(320, 1000);
      listEvents.onScroll?.(scrollEvent(500));
    });
    frames.flush();
    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    act(() => {
      listEvents.onContentSizeChange?.(320, 1200);
      listEvents.onScroll?.(scrollEvent(500, 1200));
      listEvents.onContentSizeChange?.(320, 1200);
    });
    frames.flush();
    expect(scrollCalls).toHaveLength(1);
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();

    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    act(() => listEvents.onContentSizeChange?.(320, 1000));
    frames.flush();
    expect(scrollCalls).toHaveLength(1);
    expect(
      ui.queryByRole("button", { name: "Jump to latest message" }),
    ).toBeNull();
    act(() => listEvents.onContentSizeChange?.(320, 1100));
    frames.flush();
    expect(scrollCalls).toHaveLength(2);

    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    act(() => {
      listEvents.onContentSizeChange?.(320, 1300);
      listEvents.onScroll?.(scrollEvent(500, 1300));
    });
    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    act(() => listEvents.onContentSizeChange?.(320, 1200));
    frames.flush();
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();
    act(() => listEvents.onContentSizeChange?.(320, 1400));
    frames.flush();
    expect(scrollCalls).toHaveLength(2);
  } finally {
    ui.unmount();
    frames.restore();
  }
});

test("a late native offset clamp reattaches after collapsing at the end", () => {
  const frames = controlledFrames();
  scrollCalls.length = 0;
  const messages: ChatTranscriptProps["messages"] = [
    {
      role: "assistant",
      model: "fixture",
      provider: "fixture",
      content: [
        { type: "toolCall", toolCallId: "tool", toolName: "read", input: {} },
      ],
    },
  ];
  const ui = render(<ChatTranscript messages={messages} entryIds={["call"]} />);
  try {
    act(() => {
      listEvents.onLayout?.({ nativeEvent: { layout: { height: 500 } } });
      listEvents.onContentSizeChange?.(320, 1000);
      listEvents.onScroll?.(scrollEvent(500));
    });
    frames.flush();
    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    act(() => {
      listEvents.onContentSizeChange?.(320, 1200);
      listEvents.onScroll?.(scrollEvent(650, 1200));
    });
    fireEvent.click(ui.getByRole("button", { name: /Process details/ }));
    act(() => listEvents.onContentSizeChange?.(320, 1000));
    frames.flush();
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();
    act(() => listEvents.onScroll?.(scrollEvent(500, 1000)));
    frames.flush();
    expect(
      ui.queryByRole("button", { name: "Jump to latest message" }),
    ).toBeNull();
    expect(scrollCalls).toHaveLength(1);
    act(() => listEvents.onContentSizeChange?.(320, 1100));
    frames.flush();
    expect(scrollCalls).toHaveLength(2);
  } finally {
    ui.unmount();
    frames.restore();
  }
});

test("VoiceOver scrolls detach and return to following without drag events", async () => {
  const frames = controlledFrames();
  screenReaderEnabled = true;
  scrollCalls.length = 0;
  let gestures = 0;
  const messages: ChatTranscriptProps["messages"] = [
    { role: "user", content: "First", timestamp: 1 },
  ];
  const ui = render(
    <ChatTranscript
      messages={messages}
      entryIds={["first"]}
      onUserGesture={() => {
        gestures++;
      }}
    />,
  );
  try {
    await act(async () => {});
    act(() => {
      listEvents.onLayout?.({ nativeEvent: { layout: { height: 500 } } });
      listEvents.onContentSizeChange?.(320, 1000);
      listEvents.onScroll?.(scrollEvent(500));
    });
    frames.flush();
    act(() => listEvents.onScroll?.(scrollEvent(100)));
    expect(gestures).toBe(1);
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();
    act(() => {
      listEvents.onContentSizeChange?.(320, 1200);
      listEvents.onScroll?.(scrollEvent(100, 1200));
    });
    frames.flush();
    expect(scrollCalls).toHaveLength(1);
    act(() => listEvents.onScroll?.(scrollEvent(700, 1200)));
    expect(gestures).toBe(2);
    expect(
      ui.queryByRole("button", { name: "Jump to latest message" }),
    ).toBeNull();
    act(() => listEvents.onContentSizeChange?.(320, 1300));
    frames.flush();
    expect(scrollCalls).toHaveLength(2);
  } finally {
    ui.unmount();
    screenReaderEnabled = false;
    frames.restore();
  }
});

test("a newer screen-reader change wins over the initial asynchronous read", async () => {
  const frames = controlledFrames();
  const initial = Promise.withResolvers<boolean>();
  readScreenReader = () => initial.promise;
  scrollCalls.length = 0;
  const messages: ChatTranscriptProps["messages"] = [
    { role: "user", content: "First", timestamp: 1 },
  ];
  const ui = render(
    <ChatTranscript messages={messages} entryIds={["first"]} />,
  );
  try {
    act(() => screenReaderChange?.(true));
    await act(async () => {
      initial.resolve(false);
      await initial.promise;
    });
    act(() => {
      listEvents.onLayout?.({ nativeEvent: { layout: { height: 500 } } });
      listEvents.onContentSizeChange?.(320, 1000);
      listEvents.onScroll?.(scrollEvent(500));
    });
    frames.flush();
    act(() => listEvents.onScroll?.(scrollEvent(100)));
    expect(
      ui.getByRole("button", { name: "Jump to latest message" }),
    ).toBeTruthy();
  } finally {
    ui.unmount();
    readScreenReader = () => Promise.resolve(screenReaderEnabled);
    frames.restore();
  }
});
