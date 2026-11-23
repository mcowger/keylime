import "../../tests/setup-dom.ts";
import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import type * as ReactTypes from "react";
import type { BrowserLink } from "../browser-link";
import type { operations } from "../generated/web-http";

const React = createRequire(new URL("../../package.json", import.meta.url))(
  "react",
) as typeof ReactTypes;
const nativeRequire = createRequire(
  new URL("../ChatHeaderContext.tsx", import.meta.url),
);
mock.module(nativeRequire.resolve("react"), () => React);
type NativeProps = {
  children?: ReactTypes.ReactNode;
  accessibilityLabel?: string;
  onPress?: () => void;
  visible?: boolean;
};
const container = ({ children }: NativeProps) =>
  React.createElement("div", null, children);
mock.module(nativeRequire.resolve("react-native"), () => ({
  Modal: ({ children, visible }: NativeProps) =>
    visible ? React.createElement("div", null, children) : null,
  Pressable: ({ children, accessibilityLabel, onPress }: NativeProps) =>
    React.createElement(
      "button",
      { "aria-label": accessibilityLabel, onClick: onPress },
      children,
    ),
  SafeAreaView: container,
  ScrollView: container,
  Text: ({ children }: NativeProps) =>
    React.createElement("span", null, children),
  View: container,
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  useColorScheme: () => "dark",
}));
mock.module("../native-network", () => ({ copyText: async () => {} }));

type ContextResponse =
  operations["getSessionContextStats"]["responses"][200]["content"]["application/json"];
const aggregate: ContextResponse = {
  stats: {
    sessionId: "session",
    sessionFile: "/remote/session.jsonl",
    sessionName: "Example",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 10, output: 8, cacheRead: 80, cacheWrite: 0, total: 98 },
    cost: 1,
  },
  model: { provider: "example", modelId: "model" },
  speedSamples: [4, 8],
};
const requests: string[] = [];
let loadStats: (path: string) => Promise<ContextResponse> = async () =>
  aggregate;
class KeylimeHttpError extends Error {
  constructor(readonly status?: number) {
    super("Server request failed");
  }
}
mock.module("../keylime-http", () => ({
  KeylimeHttpError,
  requestJson: async (_origin: string, path: string) => {
    requests.push(path);
    if (path.includes("/context-stats?")) return loadStats(path);
    if (path.includes("/subagents?"))
      return { subagents: [], costs: { agent: 1, subagents: 2 } };
    if (path.includes("/state?"))
      return {
        running: true,
        state: {
          contextUsage: { tokens: 123, contextWindow: 1000, percent: 12.3 },
          tokensPerSecond: 10,
        },
      };
    if (path.startsWith("/api/models?"))
      return {
        modelList: [
          {
            provider: "example",
            id: "model",
            contextWindow: 1000,
            maxTokens: 256,
          },
        ],
      };
    throw new Error(`Unexpected request: ${path}`);
  },
}));
// Native and React mocks must be installed before loading the component and renderer.
const { render, fireEvent, waitFor, act } =
  await import("@testing-library/react/pure.js");
const { ChatHeaderContext } = await import("../ChatHeaderContext");

function props(
  overrides: Partial<ReactTypes.ComponentProps<typeof ChatHeaderContext>> = {},
) {
  return {
    origin: "https://example.test",
    hostId: "remote",
    sessionId: "session",
    link: {
      command: () => {
        throw new Error("Unexpected runner command");
      },
    } as unknown as BrowserLink,
    linkStatus: "open" as const,
    usage: null,
    modelIdentity: null,
    busy: false,
    running: false,
    colors: { panel: "black", border: "gray", text: "white", muted: "gray" },
    ...overrides,
  };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

test("loads aggregate once from the owning host without history or runner commands", async () => {
  requests.length = 0;
  loadStats = async () => aggregate;
  const ui = render(
    React.createElement(ChatHeaderContext, props({ running: true })),
  );
  try {
    fireEvent.click(ui.getByRole("button", { name: "Session context" }));
    await waitFor(() => expect(ui.getByText("88.89%")).toBeTruthy());
    expect(ui.getByText("123 / 1k (12.3%)")).toBeTruthy();
    expect(ui.getByText("/remote/session.jsonl")).toBeTruthy();
    expect(ui.getByText("Example")).toBeTruthy();
    expect(ui.getByText("$3.00")).toBeTruthy();
    expect(ui.getByText(/max out 256/)).toBeTruthy();
    expect(ui.getByText(/10.0 t\/s · avg 7.3/)).toBeTruthy();
    expect(requests.filter((path) => path.includes("/context-stats?"))).toEqual(
      ["/api/sessions/session/context-stats?hostId=remote"],
    );
    expect(
      requests.some(
        (path) => path.includes("tail=") || path.includes("before="),
      ),
    ).toBe(false);
    expect(
      requests.some((path) => path === "/api/sessions/session?hostId=remote"),
    ).toBe(false);
  } finally {
    ui.unmount();
  }
});

test("offers host upgrade guidance when statistics are unsupported", async () => {
  requests.length = 0;
  loadStats = async () => {
    throw new KeylimeHttpError(501);
  };
  const ui = render(React.createElement(ChatHeaderContext, props()));
  try {
    fireEvent.click(ui.getByRole("button", { name: "Session context" }));
    await waitFor(() =>
      expect(
        ui.getByText("Update the session's host daemon to show statistics."),
      ).toBeTruthy(),
    );
    expect(ui.queryByText("Cache Hit")).toBeNull();
    expect(
      requests.filter((path) => path.includes("/context-stats?")),
    ).toHaveLength(1);
    expect(requests.some((path) => path.includes("tail="))).toBe(false);
  } finally {
    ui.unmount();
  }
});

test("fences old host and session responses after changing identity", async () => {
  requests.length = 0;
  const old = deferred<ContextResponse>();
  loadStats = (path) =>
    path.includes("hostId=remote")
      ? old.promise
      : Promise.resolve({
          ...aggregate,
          stats: {
            ...aggregate.stats!,
            sessionId: "other",
            sessionName: "New session",
          },
        });
  const ui = render(React.createElement(ChatHeaderContext, props()));
  try {
    fireEvent.click(ui.getByRole("button", { name: "Session context" }));
    ui.rerender(
      React.createElement(
        ChatHeaderContext,
        props({ hostId: "another", sessionId: "other" }),
      ),
    );
    fireEvent.click(ui.getByRole("button", { name: "Session context" }));
    await waitFor(() => expect(ui.getByText("New session")).toBeTruthy());
    await act(async () => {
      old.resolve(aggregate);
      await old.promise;
    });
    expect(ui.getByText("New session")).toBeTruthy();
    expect(ui.queryByText("Example")).toBeNull();
    expect(requests.filter((path) => path.includes("/context-stats?"))).toEqual(
      [
        "/api/sessions/session/context-stats?hostId=remote",
        "/api/sessions/other/context-stats?hostId=another",
      ],
    );
  } finally {
    ui.unmount();
  }
});

test("closing fences the old response and reopening shares a pending request", async () => {
  requests.length = 0;
  const pending = deferred<ContextResponse>();
  loadStats = () => pending.promise;
  const ui = render(React.createElement(ChatHeaderContext, props()));
  try {
    fireEvent.click(ui.getByRole("button", { name: "Session context" }));
    fireEvent.click(ui.getByRole("button", { name: "Close session context" }));
    fireEvent.click(ui.getByRole("button", { name: /Session context/ }));
    expect(
      requests.filter((path) => path.includes("/context-stats?")),
    ).toHaveLength(1);
    await act(async () => {
      pending.resolve(aggregate);
      await pending.promise;
    });
    await waitFor(() => expect(ui.getByText("Example")).toBeTruthy());
  } finally {
    ui.unmount();
  }
});

test("changing running state does not duplicate a pending aggregate request", async () => {
  requests.length = 0;
  const pending = deferred<ContextResponse>();
  loadStats = () => pending.promise;
  const ui = render(React.createElement(ChatHeaderContext, props()));
  try {
    fireEvent.click(ui.getByRole("button", { name: "Session context" }));
    ui.rerender(
      React.createElement(
        ChatHeaderContext,
        props({ running: true, busy: true }),
      ),
    );
    expect(
      requests.filter((path) => path.includes("/context-stats?")),
    ).toHaveLength(1);
    await act(async () => {
      pending.resolve(aggregate);
      await pending.promise;
    });
    await waitFor(() => expect(ui.getByText("Example")).toBeTruthy());
  } finally {
    ui.unmount();
  }
});

test("a response received after closing cannot populate a later opening", async () => {
  requests.length = 0;
  const pending = deferred<ContextResponse>();
  loadStats = () => pending.promise;
  const ui = render(React.createElement(ChatHeaderContext, props()));
  try {
    fireEvent.click(ui.getByRole("button", { name: "Session context" }));
    fireEvent.click(ui.getByRole("button", { name: "Close session context" }));
    await act(async () => {
      pending.resolve(aggregate);
      await pending.promise;
    });
    loadStats = async () => ({ ...aggregate, stats: null });
    fireEvent.click(ui.getByRole("button", { name: /Session context/ }));
    await waitFor(() =>
      expect(ui.getByText("Session statistics unavailable")).toBeTruthy(),
    );
    expect(ui.queryByText("Example")).toBeNull();
  } finally {
    ui.unmount();
  }
});

test("refreshes only running sessions and never overlaps aggregate requests", async () => {
  requests.length = 0;
  const first = deferred<ContextResponse>();
  loadStats = () => first.promise;
  const timers: Array<() => void> = [];
  const originalSetInterval = globalThis.setInterval;
  const ui = render(React.createElement(ChatHeaderContext, props()));
  try {
    globalThis.setInterval = ((callback: () => void) => {
      timers.push(callback);
      return 0;
    }) as typeof setInterval;
    try {
      fireEvent.click(ui.getByRole("button", { name: "Session context" }));
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
    expect(timers).toHaveLength(2);
    act(() => timers.forEach((timer) => timer()));
    expect(
      requests.filter((path) => path.includes("/context-stats?")),
    ).toHaveLength(1);
    ui.rerender(
      React.createElement(ChatHeaderContext, props({ running: true })),
    );
    act(() => timers.forEach((timer) => timer()));
    expect(
      requests.filter((path) => path.includes("/context-stats?")),
    ).toHaveLength(1);
    await act(async () => {
      first.resolve(aggregate);
      await first.promise;
    });
    loadStats = async () => aggregate;
    act(() => timers.forEach((timer) => timer()));
    await waitFor(() =>
      expect(
        requests.filter((path) => path.includes("/context-stats?")),
      ).toHaveLength(2),
    );
    ui.rerender(
      React.createElement(ChatHeaderContext, props({ running: false })),
    );
    act(() => timers.forEach((timer) => timer()));
    expect(
      requests.filter((path) => path.includes("/context-stats?")),
    ).toHaveLength(2);
  } finally {
    globalThis.setInterval = originalSetInterval;
    ui.unmount();
  }
});
