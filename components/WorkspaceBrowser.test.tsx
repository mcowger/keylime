import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { WorkspaceBrowser } from "./WorkspaceBrowser";

// Load the testing library after the DOM test environment is installed.
const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react/pure.js");

test("browser frames are requested only while selected and visible", async (t) => {
  const originalFetch = globalThis.fetch;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  let hidden = false;
  const requests: Array<{ url: string; signal: AbortSignal }> = [];
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    requests.push({ url: String(input), signal });
    const { promise, reject } = Promise.withResolvers<Response>();
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    return promise;
  }) as typeof fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else Reflect.deleteProperty(document, "hidden");
  });

  const pages = [{ id: "page 1", title: "Page", url: "https://example.com" }];
  const view = render(<WorkspaceBrowser sessionId="session 1" pages={pages} active={false} />);
  assert.equal(requests.length, 0);

  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active />));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/sessions/session%201/browser/frame?tabId=page+1");
  assert.equal(requests[0].signal.aborted, false);
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  assert.ok(view.getByRole("button", { name: "Release control" }));

  await act(async () => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests.length, 1);
  assert.ok(view.getByRole("button", { name: "Take control" }));

  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active={false} />));
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(requests.length, 1);

  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active />));
  assert.equal(requests.length, 2);
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active={false} />));
  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active />));
  assert.ok(view.getByRole("button", { name: "Take control" }));
  assert.equal(requests[1].signal.aborted, true);
});

test("takeover validates navigation and discards queued actions on release", async (t) => {
  const originalFetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  const actions: Array<{ id: string; action: { type: string; url?: string } }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/frame?")) {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      return promise;
    }
    actions.push(JSON.parse(String(init?.body)));
    return pending.promise;
  }) as typeof fetch;
  t.after(() => { cleanup(); globalThis.fetch = originalFetch; });
  const pages = [{ id: "one", title: "One", url: "https://example.com" }, { id: "two", title: "Two", url: "https://example.org" }];
  const view = render(<WorkspaceBrowser sessionId="session" pages={pages} active />);
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  const address = view.getByRole("textbox", { name: "Address (HTTP or HTTPS)" });
  fireEvent.change(address, { target: { value: "file:///private" } });
  fireEvent.click(view.getByRole("button", { name: "Go" }));
  assert.equal(actions.length, 0);
  assert.ok(view.getByRole("alert"));
  fireEvent.change(address, { target: { value: "https://example.org/path" } });
  fireEvent.click(view.getByRole("button", { name: "Go" }));
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  assert.deepEqual(actions, [{ id: "one", action: { type: "navigate", url: "https://example.org/path" } }]);
  fireEvent.change(view.getByLabelText("Page"), { target: { value: "two" } });
  assert.ok(view.getByRole("button", { name: "Take control" }));
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  fireEvent.click(view.getByRole("button", { name: "Reload" }));
  assert.equal(actions.length, 1);
  await act(async () => pending.resolve(Response.json({})));
  await waitFor(() => assert.equal(actions.length, 2));
  assert.deepEqual(actions[1], { id: "two", action: { type: "reload" } });
  fireEvent(window, new Event("offline"));
  assert.ok(view.getByRole("button", { name: "Take control" }));
});

test("takeover sends keyboard and composition input in order without clipboard transfers", async (t) => {
  const originalFetch = globalThis.fetch;
  const actions: Array<{ type: string; event?: string; key?: string; text?: string }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/frame?")) {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      return promise;
    }
    actions.push(JSON.parse(String(init?.body)).action);
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  t.after(() => { cleanup(); globalThis.fetch = originalFetch; });
  const view = render(<WorkspaceBrowser sessionId="session" pages={[{ id: "one", title: "One", url: "https://example.com" }]} active />);
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  const keyboard = view.getByRole("textbox", { name: "Browser keyboard" });
  fireEvent.keyDown(keyboard, { key: "Enter", code: "Enter", keyCode: 13 });
  fireEvent.keyUp(keyboard, { key: "Enter", code: "Enter", keyCode: 13 });
  fireEvent.keyDown(keyboard, { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true });
  fireEvent.paste(keyboard);
  fireEvent.compositionStart(keyboard);
  fireEvent.input(keyboard, { target: { value: "あ" } });
  fireEvent.compositionEnd(keyboard, { data: "あ" });
  await waitFor(() => assert.equal(actions.length, 3));
  assert.deepEqual(actions.map(({ type, event, key, text }) => ({ type, event, key, text })), [
    { type: "key", event: "down", key: "Enter", text: undefined },
    { type: "key", event: "up", key: "Enter", text: undefined },
    { type: "text", event: undefined, key: undefined, text: "あ" },
  ]);
});

test("pointer input requires a fresh frame and scales wheel coordinates to the viewport", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:frame";
  URL.revokeObjectURL = () => {};
  const actions: Array<Record<string, unknown>> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/frame?")) return Promise.resolve(new Response(new Blob(["frame"]), { headers: { "X-Browser-Viewport-Width": "1280", "X-Browser-Viewport-Height": "720" } }));
    actions.push(JSON.parse(String(init?.body)).action);
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  t.after(() => { cleanup(); globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; });
  const view = render(<WorkspaceBrowser sessionId="session" pages={[{ id: "one", title: "One", url: "https://example.com" }]} active />);
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  const image = await view.findByRole("img", { name: "Live browser page" });
  image.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 650, bottom: 380, width: 640, height: 360, toJSON() {} });
  fireEvent.load(image);
  let captured = false;
  image.setPointerCapture = () => { captured = true; };
  image.hasPointerCapture = () => captured;
  const pointer = (type: string, pointerType: string, x: number, y: number) => {
    const event = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1 });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType } });
    fireEvent(image, event);
  };
  pointer("pointerdown", "mouse", 330, 200);
  pointer("pointermove", "mouse", 350, 220);
  pointer("pointerup", "mouse", 350, 220);
  captured = false;
  pointer("pointerdown", "touch", 330, 200);
  pointer("pointerup", "touch", 330, 200);
  fireEvent.wheel(image, { clientX: 330, clientY: 200, deltaY: 25 });
  await waitFor(() => assert.equal(actions.length, 6));
  assert.deepEqual(actions.map((action) => action.type), ["pointer", "pointer", "pointer", "touch", "touch", "wheel"]);
  assert.deepEqual(actions.slice(0, 3).map((action) => action.buttons), [1, 1, 0]);
  assert.deepEqual(actions[3], { type: "touch", event: "start", points: [{ id: 1, x: 640, y: 360 }], modifiers: 0 });
  assert.deepEqual(actions[4], { type: "touch", event: "end", points: [], modifiers: 0 });
  assert.deepEqual(actions[5], { type: "wheel", x: 640, y: 360, deltaX: 0, deltaY: 25, modifiers: 0 });
  fireEvent.error(image);
  fireEvent.wheel(image, { clientX: 330, clientY: 200, deltaY: 25 });
  assert.equal(actions.length, 6);
});

test("a failed control action is not retried and does not release control", async (t) => {
  const originalFetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  let calls = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/frame?")) {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      return promise;
    }
    calls++;
    return calls === 1 ? pending.promise : Promise.resolve(calls === 3 ? Response.json({ code: "host_offline" }, { status: 503 }) : Response.json({}));
  }) as typeof fetch;
  t.after(() => { cleanup(); globalThis.fetch = originalFetch; });
  const view = render(<WorkspaceBrowser sessionId="session" pages={[{ id: "one", title: "One", url: "https://example.com" }]} active />);
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  fireEvent.click(view.getByRole("button", { name: "Forward" }));
  await act(async () => pending.resolve(new Response(null, { status: 500 })));
  assert.equal(calls, 1);
  assert.ok(view.getByRole("alert"));
  assert.ok(view.getByRole("button", { name: "Release control" }));
  fireEvent.click(view.getByRole("button", { name: "Reload" }));
  await waitFor(() => assert.equal(calls, 2));
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  await waitFor(() => assert.ok(view.getByRole("button", { name: "Take control" })));
  assert.equal(calls, 3);
});
