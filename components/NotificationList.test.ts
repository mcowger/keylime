import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";
import React from "react";
const { act, cleanup, render } = await import("@testing-library/react/pure.js");

const { NotificationList } = await import("@/components/NotificationList");
const { notificationHistory } = await import("@/lib/notification-history");
const { OPEN_SESSION_EVENT } = await import("@/lib/notification-client");

before(() => {
  window.Element.prototype.setPointerCapture = () => {};
  // The list syncs read marks and removals to the server; these tests only watch the list.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
    })) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  notificationHistory.clear();
});

type PointerOptions = { pointerType?: string; detail?: number };
type Point = [number, number];
function pointer(
  target: Element,
  type: string,
  x: number,
  y: number,
  { pointerType = "touch", detail = 1 }: PointerOptions = {},
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
    pointerType: { value: pointerType },
  });
  act(() => {
    target.dispatchEvent(event);
  });
}
function drag(
  target: Element,
  points: [Point, ...Point[]],
  options?: PointerOptions,
) {
  const [first, ...rest] = points;
  pointer(target, "pointerdown", ...first, options);
  for (const point of rest) pointer(target, "pointermove", ...point, options);
  pointer(target, "pointerup", ...points[points.length - 1], options);
}
function mount() {
  act(() => {
    notificationHistory.add({
      type: "error",
      hostId: "remote",
      sessionId: "n1-session",
      sessionName: "Agent finished",
      detail: "A long description",
    });
  });
  const view = render(React.createElement(NotificationList));
  return {
    row: () => view.container.querySelector("li")!,
    description: () =>
      view.container.querySelector<HTMLElement>("[aria-expanded]")!,
  };
}
const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 250)));

test("only unread rows carry the unread marker", () => {
  act(() => {
    notificationHistory.add({
      type: "completed",
      sessionId: "old",
      sessionName: "Old",
    });
    notificationHistory.markAllRead();
    notificationHistory.add({
      type: "completed",
      sessionId: "new",
      sessionName: "New",
    });
  });
  const view = render(React.createElement(NotificationList));
  const markedRows = Array.from(view.container.querySelectorAll("li")).filter(
    (li) => li.querySelector('[role="img"]'),
  );
  assert.deepEqual(
    markedRows.map((li) => li.querySelector(".display-heading")!.textContent),
    ["New"],
  );
});

test("a sideways touch swipe from anywhere on the row slides it out, then removes it, in either direction", async () => {
  const gestures: [Point, ...Point[]][] = [
    [
      [100, 50],
      [130, 54],
      [160, 58],
    ],
    [
      [200, 50],
      [170, 46],
      [140, 44],
    ],
  ];
  for (const points of gestures) {
    const { row, description } = mount();
    drag(description(), points);
    assert.equal(row().style.opacity, "0", "the row slides out before it goes");
    await settle();
    assert.equal(notificationHistory.get().length, 0);
    cleanup();
  }
});

test("short, mostly vertical, curved-into-vertical, mouse, and button-started drags keep the row", async () => {
  const { row, description } = mount();
  drag(description(), [
    [100, 50],
    [115, 51],
    [130, 52],
  ]);
  drag(description(), [
    [100, 50],
    [120, 85],
    [150, 120],
  ]);
  // Claimed sideways, then the thumb carries on mostly downward.
  drag(description(), [
    [100, 50],
    [125, 52],
    [150, 120],
  ]);
  // Swiped out, then pulled back toward the start before letting go.
  drag(description(), [
    [100, 50],
    [180, 52],
    [140, 52],
  ]);
  drag(description(), [
    [200, 50],
    [80, 52],
    [140, 52],
  ]);
  drag(
    description(),
    [
      [100, 50],
      [150, 51],
      [200, 52],
    ],
    { pointerType: "mouse" },
  );
  drag(row().querySelector("button")!, [
    [100, 50],
    [150, 51],
    [200, 52],
  ]);
  await settle();
  assert.equal(notificationHistory.get().length, 1);
  assert.equal(row().style.transform, "");
});

test("a swipe that turns back and then out again still dismisses", async () => {
  const { description } = mount();
  drag(description(), [
    [100, 50],
    [180, 52],
    [140, 52],
    [190, 54],
  ]);
  await settle();
  assert.equal(notificationHistory.get().length, 0);
});

test("the click ending a drag is swallowed; taps and keyboard clicks still reach the row", () => {
  const { description } = mount();
  pointer(description(), "pointerdown", 100, 50, { pointerType: "mouse" });
  pointer(description(), "click", 160, 50, { pointerType: "mouse" });
  assert.equal(description().getAttribute("aria-expanded"), "false");
  pointer(description(), "pointerdown", 100, 50);
  pointer(description(), "click", 103, 51);
  assert.equal(description().getAttribute("aria-expanded"), "true");
  // A keyboard click reports no position; an earlier press must not make it look like a drag.
  pointer(description(), "pointerdown", 100, 50);
  pointer(description(), "click", 0, 0, { detail: 0 });
  assert.equal(description().getAttribute("aria-expanded"), "false");
  // A drag out and back to where it started is still a drag, not a tap.
  pointer(description(), "pointerdown", 100, 50);
  pointer(description(), "pointermove", 160, 50);
  pointer(description(), "click", 101, 50);
  assert.equal(description().getAttribute("aria-expanded"), "false");
});

test("clicking or pressing Enter on a row marks it read and opens its session, but not from its controls", () => {
  const opened: Array<{ sessionId: string; hostId: string }> = [];
  const onOpen = (event: Event) =>
    opened.push((event as CustomEvent<(typeof opened)[number]>).detail);
  window.addEventListener(OPEN_SESSION_EVENT, onOpen);
  try {
    const { row } = mount();
    const enter = (target: Element) =>
      act(() => {
        target.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    act(() => row().querySelector<HTMLElement>(".display-heading")!.click());
    assert.deepEqual(opened, [{ sessionId: "n1-session", hostId: "remote" }]);
    assert.equal(notificationHistory.get()[0].read, true);
    assert.equal(row().tabIndex, 0);
    assert.equal(row().style.cursor, "pointer");
    enter(row());
    assert.equal(opened.length, 2);
    // Expandable text expands instead; a released text selection and Enter on the dismiss button do nothing.
    const description = row().querySelector<HTMLElement>("[aria-expanded]")!;
    act(() => description.click());
    assert.equal(description.getAttribute("aria-expanded"), "true");
    window
      .getSelection()!
      .selectAllChildren(row().querySelector(".display-heading")!);
    act(() => row().querySelector<HTMLElement>(".display-heading")!.click());
    window.getSelection()!.removeAllRanges();
    enter(row().querySelector("button")!);
    assert.equal(opened.length, 2);
    // The dismiss button removes the entry without opening it.
    act(() => row().querySelector("button")!.click());
    assert.equal(opened.length, 2);
    assert.equal(notificationHistory.get().length, 0);
  } finally {
    window.removeEventListener(OPEN_SESSION_EVENT, onOpen);
  }
});

test("a row shows the event in the viewer's language, and its session name as the title", () => {
  act(() => {
    notificationHistory.add({
      type: "input",
      sessionId: "s9",
      sessionName: "Deploy",
      detail: "Ship it?",
    });
  });
  const row = render(
    React.createElement(NotificationList),
  ).container.querySelector("li")!;
  assert.equal(row.querySelector(".display-heading")!.textContent, "Deploy");
  assert.match(row.textContent!, /Ship it\?/);
});

test("pressing Space on a row opens its session, like Enter", () => {
  const opened: Array<{ sessionId: string; hostId: string }> = [];
  const onOpen = (event: Event) =>
    opened.push((event as CustomEvent<(typeof opened)[number]>).detail);
  window.addEventListener(OPEN_SESSION_EVENT, onOpen);
  try {
    const { row } = mount();
    act(() => {
      row().dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: " ",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    assert.deepEqual(opened, [{ sessionId: "n1-session", hostId: "remote" }]);
    assert.equal(notificationHistory.get()[0].read, true);
  } finally {
    window.removeEventListener(OPEN_SESSION_EVENT, onOpen);
  }
});

test("an entry whose session no longer exists still renders and opens by id", () => {
  act(() => {
    notificationHistory.add({
      type: "error",
      hostId: "remote",
      sessionId: "gone-session",
      sessionName: null,
    });
  });
  const row = render(
    React.createElement(NotificationList),
  ).container.querySelector("li")!;
  assert.ok(
    row.querySelector(".display-heading")!.textContent!.length > 0,
    "an untitled session still gets a title",
  );
  assert.equal(row.tabIndex, 0);
});

test("a legacy entry without a host is visible but not a conversation link", () => {
  act(() => {
    notificationHistory.add({
      type: "completed",
      sessionId: "legacy-session",
      sessionName: "Legacy notification",
    });
  });
  const row = render(
    React.createElement(NotificationList),
  ).container.querySelector("li")!;
  assert.match(row.textContent!, /Legacy notification/);
  assert.equal(row.hasAttribute("tabindex"), false);
  assert.equal(row.style.cursor, "");
});
