import "../../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";
import React from "react";
import type { EventStreamChannel } from "@/lib/event-stream";
const { act, cleanup, render, renderHook } =
  await import("@testing-library/react/pure.js");

const { ClampedDescription, ToastProvider, toast } =
  await import("@/components/ui/toast");
const { useNotifications } = await import("@/hooks/useNotifications");
const { notificationHistory } = await import("@/lib/notification-history");

/** The tab side of the shared event-stream worker (lib/event-stream.ts), so a
 * test can deliver frames on the notifications channel the hook opened. */
const eventStreams = new Map<number, EventStreamChannel>();
const eventWorker = {
  onmessage: null as
    | ((event: { data: { id: number; type: string; data: string } }) => void)
    | null,
  onerror: null,
  postMessage(message: {
    op: string;
    id: number;
    channel: EventStreamChannel;
  }) {
    if (message.op === "open") eventStreams.set(message.id, message.channel);
    else if (message.op === "close") eventStreams.delete(message.id);
  },
};
function deliverNotification(message: {
  kind: string;
  event: {
    type: string;
    sessionId: string;
    sessionName: string;
    detail?: string;
  };
}) {
  const id = [...eventStreams].findLast(
    ([, channel]) => channel.kind === "notifications",
  )?.[0];
  assert.ok(id, "useNotifications must hold a notifications channel");
  assert.ok(eventWorker.onmessage);
  eventWorker.onmessage({
    data: {
      id,
      type: "message",
      data: JSON.stringify({ type: "notification", ...message }),
    },
  });
}

before(() => {
  globalThis.AbortController = window.AbortController;
  window.Element.prototype.setPointerCapture = () => {};
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  // `new Worker()` yields the one shared fake (a constructor may return an object).
  globalThis.Worker = function Worker() {
    return eventWorker;
  } as unknown as typeof Worker;
});
afterEach(() => {
  act(() => toast.close());
  cleanup();
  window.getSelection()?.removeAllRanges();
});

function pointer(
  target: EventTarget | null,
  type: string,
  x: number,
  y: number,
  { detail = 1 } = {},
) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    detail,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "mouse" },
  });
  assert.ok(target);
  act(() => {
    target.dispatchEvent(event);
  });
}
function show(
  description: React.ReactNode,
  options: NonNullable<Parameters<typeof toast.info>[2]> = {},
) {
  const opened: number[] = [];
  render(React.createElement(ToastProvider, null));
  act(() => {
    toast.info("Agent finished", description, {
      onClick: () => opened.push(1),
      ...options,
    });
  });
  return {
    opened,
    card: () => document.querySelector<HTMLElement>(".toast-card")!,
  };
}

test("clicking anywhere on a toast card runs its action and closes it", () => {
  const { opened, card } = show("Body");
  assert.equal(card().style.cursor, "pointer");
  const title = card().querySelector<HTMLElement>(".display-serif");
  pointer(title, "pointerdown", 100, 50);
  pointer(title, "click", 102, 51);
  assert.equal(opened.length, 1);
  assert.equal(card()?.hasAttribute("data-ending-style") ?? true, true);
});

test("Enter on the focused card runs its action; Enter inside it does not", () => {
  const { opened, card } = show(
    React.createElement("button", { type: "button" }, "inner"),
  );
  const press = (target: EventTarget | null) => {
    assert.ok(target);
    act(() => {
      target.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  };
  press(card().querySelector("button:not(.toast-close-button)"));
  assert.equal(opened.length, 0);
  press(card());
  assert.equal(opened.length, 1);
});

test("buttons, links, expandable text, drags and text selection do not trigger the card action", () => {
  let pressed = 0;
  const { opened, card } = show(
    React.createElement(
      "span",
      null,
      React.createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            pressed += 1;
          },
        },
        "Open",
      ),
      React.createElement("a", { href: "#x" }, "link"),
      React.createElement(ClampedDescription, null, "long text"),
    ),
  );
  act(() =>
    card()
      .querySelector<HTMLButtonElement>("button:not(.toast-close-button)")!
      .click(),
  );
  assert.equal(pressed, 1);
  act(() => card().querySelector("a")!.click());
  // A press on the clamped text whose click is retargeted to the card, as pointer capture does.
  pointer(card().querySelector("[aria-expanded]"), "pointerdown", 100, 50);
  pointer(card(), "click", 100, 50);
  // A drag that fell short of a swipe.
  const title = card().querySelector<HTMLElement>(".display-serif");
  assert.ok(title);
  pointer(title, "pointerdown", 100, 50);
  pointer(title, "click", 130, 50);
  // A drag pulled back to where it started.
  pointer(title, "pointerdown", 100, 50);
  pointer(title, "pointermove", 160, 50);
  pointer(title, "click", 101, 50);
  window.getSelection()!.selectAllChildren(title);
  act(() => title.click());
  assert.equal(opened.length, 0);
  assert.equal(card()?.hasAttribute("data-ending-style") ?? false, false);
});

test("a toast without an action keeps the default cursor", () => {
  render(React.createElement(ToastProvider, null));
  act(() => {
    toast.info("Saved");
  });
  assert.equal(
    document.querySelector<HTMLElement>(".toast-card")!.style.cursor,
    "",
  );
});

test("a session notification toast opens its session from a card click; one without a session does not", () => {
  const sessions: string[] = [];
  render(React.createElement(ToastProvider, null));
  renderHook(() =>
    useNotifications({
      sessionId: null,
      onOpenSession: (id) => sessions.push(id),
    }),
  );
  // Toasts closed by earlier tests can still be leaving the shared manager, so
  // each card is found by its own title (the session name).
  const deliver = (sessionId: string, sessionName: string) => {
    act(() => {
      deliverNotification({
        kind: "toast",
        event: { type: "completed", sessionId, sessionName },
      });
    });
    return Array.from(
      document.querySelectorAll<HTMLElement>(".toast-card"),
    ).find(
      (card) =>
        card.querySelector(".display-serif")?.textContent === sessionName,
    );
  };
  const withSession = deliver("s1", "Fix bug");
  assert.ok(withSession);
  // The card is the only way in: no separate Open link.
  assert.equal(
    withSession.querySelectorAll("button:not(.toast-close-button), a").length,
    0,
  );
  act(() => withSession.querySelector<HTMLElement>(".display-serif")!.click());
  assert.deepEqual(sessions, ["s1"]);
  // Session notifications are listed; opening one from its toast reads it.
  assert.deepEqual(
    notificationHistory
      .get()
      .filter((e) => e.id === "s1:completed")
      .map((e) => e.read),
    [true],
  );
  const withoutSession = deliver("", "No session");
  assert.ok(withoutSession);
  assert.equal(withoutSession.style.cursor, "");
  act(() =>
    withoutSession.querySelector<HTMLElement>(".display-serif")!.click(),
  );
  assert.deepEqual(sessions, ["s1"]);
});

test("a notification the OS showed is listed in history", async () => {
  const created: string[] = [];
  // Bare `Notification` in the code under test resolves to the global, not window.
  globalThis.Notification = window.Notification = class {
    static permission = "granted";
    constructor(title: string) {
      created.push(title);
    }
  } as unknown as typeof Notification;
  try {
    renderHook(() =>
      useNotifications({
        sessionId: null,
        onOpenSession: () => {},
      }),
    );
    await act(async () => {
      deliverNotification({
        kind: "os",
        event: {
          type: "error",
          sessionId: "s9",
          sessionName: "Shown by OS",
          detail: "boom",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(created, ["Shown by OS"]);
    assert.deepEqual(
      notificationHistory
        .get()
        .filter((e) => e.id === "s9:error")
        .map((e) => [e.event.sessionName, e.read]),
      [["Shown by OS", false]],
    );
  } finally {
    Reflect.deleteProperty(window, "Notification");
    Reflect.deleteProperty(globalThis, "Notification");
    act(() => notificationHistory.clear());
  }
});

test("a push the service worker showed reloads the list from the server; other messages are ignored", async () => {
  const worker = new window.EventTarget();
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: worker,
  });
  const requests: [string, string][] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (
    url: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    requests.push([init.method ?? "GET", String(url)]);
    const entries = [
      {
        id: "s7:error",
        event: { type: "error", sessionId: "s7", sessionName: "Pushed" },
        at: 1,
        read: false,
      },
    ];
    return { ok: true, json: async () => ({ entries }) };
  }) as unknown as typeof fetch;
  try {
    renderHook(() =>
      useNotifications({
        sessionId: null,
        onOpenSession: () => {},
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    requests.length = 0;
    const post = (data: unknown) =>
      act(async () => {
        worker.dispatchEvent(new window.MessageEvent("message", { data }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    await post("junk");
    await post({ type: "something-else" });
    assert.deepEqual(requests, []);
    await post({
      type: "omp-notification-shown",
      notification: {
        type: "error",
        title: "Pushed",
        body: "Run failed",
        tag: "s7:error",
        sessionId: "s7",
      },
    });
    assert.deepEqual(requests, [["GET", "/api/notifications/history"]]);
    assert.deepEqual(
      notificationHistory.get().map((e) => e.id),
      ["s7:error"],
    );
  } finally {
    globalThis.fetch = previousFetch;
    Reflect.deleteProperty(window.navigator, "serviceWorker");
    act(() => notificationHistory.clear());
  }
});
