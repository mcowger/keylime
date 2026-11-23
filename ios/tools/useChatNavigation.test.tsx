import "../../tests/setup-dom.ts";
import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import type * as ReactTypes from "react";
import type { BrowserLink, BrowserLinkHandlers } from "../browser-link";
import type { ChatTranscriptProps } from "../ChatTranscript";
import type { ChatContext } from "../useChatSession";

const React = createRequire(new URL("../../package.json", import.meta.url))(
  "react",
) as typeof ReactTypes;
mock.module(
  createRequire(new URL("../useChatSession.ts", import.meta.url)).resolve(
    "react",
  ),
  () => React,
);
let listEvents: {
  onContentSizeChange?: () => void;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  onScroll?: (event: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => void;
} = {};
let countedTextRenders = 0;
mock.module("../AuthenticatedMedia", () => ({
  AuthenticatedMedia: () => null,
}));
mock.module("../ChatMarkdown", () => ({ ChatMarkdown: () => null }));
mock.module("../TranscriptIcons", () => ({ TranscriptIcon: () => null }));
mock.module("../node_modules/react-native/index.js", () => ({
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
  }: {
    data: unknown[];
    keyExtractor: (row: unknown) => string;
    renderItem: (props: { item: unknown }) => ReactTypes.ReactNode;
    onContentSizeChange?: () => void;
    onLayout?: typeof listEvents.onLayout;
    onScroll?: typeof listEvents.onScroll;
  }) => {
    listEvents = { onContentSizeChange, onLayout, onScroll };
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
    act(() =>
      listEvents.onScroll?.({
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
