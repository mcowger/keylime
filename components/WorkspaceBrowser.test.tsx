import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import React, { act } from "react";
import { WorkspaceBrowser } from "./WorkspaceBrowser";

// Load the testing library after the DOM test environment is installed.
const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react/pure.js");

const originalDecoder = globalThis.VideoDecoder;
const originalChunk = globalThis.EncodedVideoChunk;
const originalContext = window.HTMLCanvasElement.prototype.getContext;
const painted: number[] = [];
class FakeChunk {
  type: EncodedVideoChunkType;
  timestamp: number;
  constructor(init: EncodedVideoChunkInit) { this.type = init.type; this.timestamp = init.timestamp; }
}
class FakeDecoder {
  static instances: FakeDecoder[] = [];
  static supported = true;
  static async isConfigSupported() { return { supported: FakeDecoder.supported }; }
  state: CodecState = "unconfigured";
  decodeQueueSize = 0;
  private readonly output: VideoFrameOutputCallback;
  constructor(init: VideoDecoderInit) { this.output = init.output; FakeDecoder.instances.push(this); }
  configure() { this.state = "configured"; }
  close() { this.state = "closed"; }
  decode(chunk: FakeChunk) {
    this.emit(chunk.timestamp);
  }
  emit(timestamp: number) { this.output({ timestamp, displayWidth: 1280, displayHeight: 720, close() {} } as VideoFrame); }
}
globalThis.VideoDecoder = FakeDecoder as unknown as typeof VideoDecoder;
globalThis.EncodedVideoChunk = FakeChunk as unknown as typeof EncodedVideoChunk;
window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: (frame: VideoFrame) => { painted.push(frame.timestamp); } })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
after(() => {
  globalThis.VideoDecoder = originalDecoder;
  globalThis.EncodedVideoChunk = originalChunk;
  window.HTMLCanvasElement.prototype.getContext = originalContext;
});
type TestPacket = { type: "key" | "delta"; timestamp: number; capturedAt: number; width: number; height: number; data: string };
const packet = (timestamp: number, type: "key" | "delta" = "key"): TestPacket => ({ type, timestamp, capturedAt: 1000, width: 1280, height: 720, data: "AQID" });
const batch = (...packets: TestPacket[]) => Response.json({ width: 1280, height: 720, serverTime: 1000, packets });
const startResult = (streamId = "stream-1") => Response.json({ streamId, codec: "avc1.42E01E", width: 1280, height: 720 });
const pendingVideo = (signal?: AbortSignal | null) => {
  const { promise, reject } = Promise.withResolvers<Response>();
  signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  return promise;
};

test("decoded video paints and stops immediately when hidden or deselected", async (t) => {
  const originalFetch = globalThis.fetch;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  let hidden = false;
  let pulls = 0;
  const commands: Array<{ op: string; input: { id: string; streamId?: string } }> = [];
  let pullSignal: AbortSignal | null | undefined;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "/api/sessions/session%201/browser/video");
    const command = JSON.parse(String(init?.body));
    commands.push(command);
    if (command.op === "start") return Promise.resolve(startResult());
    if (command.op === "stop") return Promise.resolve(Response.json({}));
    if (++pulls === 1) return Promise.resolve(batch(packet(1)));
    pullSignal = init?.signal;
    return pendingVideo(init?.signal);
  }) as typeof fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else Reflect.deleteProperty(document, "hidden");
  });
  painted.length = 0;
  const pages = [{ id: "page 1", title: "Page", url: "https://example.com" }];
  const view = render(<WorkspaceBrowser sessionId="session 1" pages={pages} active={false} />);
  assert.equal(commands.length, 0);
  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active />));
  await waitFor(() => assert.deepEqual(painted, [1]));
  await waitFor(() => assert.ok(pullSignal));
  const canvas = view.getByLabelText("Live browser page");
  assert.equal(canvas.style.display, "block");
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  await act(async () => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(pullSignal?.aborted, true);
  assert.equal(canvas.style.display, "none");
  assert.ok(view.getByRole("button", { name: "Take control" }));
  assert.deepEqual(commands.at(-1), { op: "stop", input: { id: "page 1", streamId: "stream-1" } });
  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active={false} />));
  const count = commands.length;
  await act(async () => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(commands.length, count);
});

test("unavailable video falls back to labeled snapshots and stops when hidden", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalBitmap = globalThis.createImageBitmap;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  let hidden = false;
  let snapshots = 0;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  globalThis.createImageBitmap = (async () => ({ width: 1280, height: 720, timestamp: 99, close() {} })) as unknown as typeof createImageBitmap;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/video")) return Promise.resolve(Response.json({ error: "Video unavailable" }, { status: 503 }));
    snapshots++;
    return Promise.resolve(new Response(new Blob(["jpeg"]), { headers: { "X-Browser-Viewport-Width": "1280", "X-Browser-Viewport-Height": "720" } }));
  }) as typeof fetch;
  t.after(() => {
    cleanup(); globalThis.fetch = originalFetch; globalThis.createImageBitmap = originalBitmap;
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else Reflect.deleteProperty(document, "hidden");
  });
  painted.length = 0;
  const view = render(<WorkspaceBrowser sessionId="session" pages={[{ id: "one", title: "One", url: "https://example.com" }]} active />);
  await waitFor(() => assert.deepEqual(painted, [99]));
  assert.ok(view.getByText("Snapshot mode (video unavailable)."));
  assert.equal(view.getByLabelText("Live browser page").style.display, "block");
  await act(async () => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(view.getByLabelText("Live browser page").style.display, "none");
  assert.equal(snapshots, 1);
});

test("unsupported video codec releases the stream before trying snapshots", async (t) => {
  const originalFetch = globalThis.fetch;
  const commands: string[] = [];
  FakeDecoder.supported = false;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/video")) {
      const command = JSON.parse(String(init?.body));
      commands.push(command.op);
      return Promise.resolve(command.op === "start" ? startResult() : Response.json({}));
    }
    commands.push("frame");
    return pendingVideo(init?.signal);
  }) as typeof fetch;
  t.after(() => { cleanup(); globalThis.fetch = originalFetch; FakeDecoder.supported = true; });
  const view = render(<WorkspaceBrowser sessionId="session" pages={[{ id: "one", title: "One", url: "https://example.com" }]} active />);
  await waitFor(() => assert.deepEqual(commands, ["start", "stop", "frame"]));
  assert.ok(view.getByText("Snapshot mode (video unavailable)."));
});

test("takeover validates navigation and discards queued actions on release", async (t) => {
  const originalFetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  const actions: Array<{ id: string; action: { type: string; url?: string } }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/video")) return pendingVideo(init?.signal);
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
    if (String(input).endsWith("/video")) return pendingVideo(init?.signal);
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
  let pulls = 0;
  const actions: Array<Record<string, unknown>> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/video")) {
      const command = JSON.parse(String(init?.body));
      if (command.op === "start") return Promise.resolve(startResult());
      if (command.op === "stop") return Promise.resolve(Response.json({}));
      if (++pulls === 1) return Promise.resolve(batch(packet(2)));
      return pendingVideo(init?.signal);
    }
    actions.push(JSON.parse(String(init?.body)).action);
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  t.after(() => { cleanup(); globalThis.fetch = originalFetch; });
  const view = render(<WorkspaceBrowser sessionId="session" pages={[{ id: "one", title: "One", url: "https://example.com" }]} active />);
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  await waitFor(() => assert.ok(painted.includes(2)));
  const image = view.getByLabelText("Live browser page");
  image.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 650, bottom: 380, width: 640, height: 360, toJSON() {} });
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
  fireEvent(window, new Event("offline"));
  fireEvent.wheel(image, { clientX: 330, clientY: 200, deltaY: 25 });
  assert.equal(actions.length, 6);
});

test("navigation discards old decoder output and resumes with a fresh stream", async (t) => {
  const originalFetch = globalThis.fetch;
  const navigation = Promise.withResolvers<Response>();
  const commands: Array<{ op: string; input: { streamId?: string } }> = [];
  const pulled = new Set<string>();
  let starts = 0;
  painted.length = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/control")) return navigation.promise;
    const command = JSON.parse(String(init?.body));
    commands.push(command);
    if (command.op === "start") return Promise.resolve(startResult(`stream-${++starts}`));
    if (command.op === "stop") return Promise.resolve(Response.json({}));
    const id = command.input.streamId as string;
    if (!pulled.has(id) && id !== "stream-2") {
      pulled.add(id);
      return Promise.resolve(batch(packet(id === "stream-1" ? 10 : 30)));
    }
    return pendingVideo(init?.signal);
  }) as typeof fetch;
  t.after(() => { cleanup(); globalThis.fetch = originalFetch; });
  const view = render(<WorkspaceBrowser sessionId="session" pages={[{ id: "one", title: "One", url: "https://example.com" }]} active />);
  await waitFor(() => assert.deepEqual(painted, [10]));
  const oldDecoder = FakeDecoder.instances.at(-1)!;
  fireEvent.click(view.getByRole("button", { name: "Take control" }));
  fireEvent.click(view.getByRole("button", { name: "Reload" }));
  await waitFor(() => assert.ok(commands.some((item) => item.op === "stop" && item.input.streamId === "stream-1")));
  oldDecoder.emit(10);
  await waitFor(() => assert.equal(starts, 2));
  assert.deepEqual(painted, [10]);
  await act(async () => navigation.resolve(Response.json({})));
  await waitFor(() => assert.deepEqual(painted, [10, 30]));
  assert.equal(view.getByLabelText("Live browser page").style.display, "block");
});

test("a failed control action is not retried and does not release control", async (t) => {
  const originalFetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  let calls = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/video")) return pendingVideo(init?.signal);
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
