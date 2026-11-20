import { beforeEach, expect, mock, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { BrowserVideoNextResultSchema } from "@/lib/api-contracts/runner-lifecycle";

const sessionId = "11111111-1111-4111-8111-111111111111";
const calls: unknown[][] = [];
let offline = false;
let tabs: { id: string; title: string; url: string }[] = [];
let data = "/9j/2Q==";
let width = 1280;
let height = 720;

mock.module("@/lib/api-utils", () => ({
  resolveSessionHostOr404: async (id: string, hostId: string) => {
    calls.push(["resolve", id, hostId]);
    return { host: { id: hostId } };
  },
  hostOfflineResponse: () =>
    offline ? Response.json({ code: "host_offline" }, { status: 503 }) : null,
  apiErrorResponse: (error: unknown) =>
    Response.json({ error: String(error) }, { status: 502 }),
}));
mock.module("@/lib/hosts/hub", () => ({
  hostBrowserList: async (...args: string[]) => {
    calls.push(["list", ...args]);
    return { tabs };
  },
  hostBrowserCapture: async (...args: string[]) => {
    calls.push(["capture", ...args]);
    return { mimeType: "image/jpeg", data, width, height };
  },
  hostBrowserControl: async (...args: unknown[]) => {
    calls.push(["control", ...args]);
    return {};
  },
  hostBrowserVideo: async (...args: unknown[]) => {
    calls.push(["video", ...args]);
    return { packets: [], width: 1280, height: 720, serverTime: 456 };
  },
}));

// The handlers must load after their host dependencies have been mocked.
const { GET: list } = await import("./route");
const { GET: frame } = await import("./frame/route");
const { POST: control } = await import("./control/route");
const { POST: video } = await import("./video/route");
const context = (id = sessionId) => ({ params: Promise.resolve({ id }) });
const request = (query = "") =>
  new Request(`http://localhost/api/sessions/${sessionId}/browser${query}`);

beforeEach(() => {
  calls.length = 0;
  offline = false;
  tabs = [];
  data = "/9j/2Q==";
  width = 1280;
  height = 720;
});

test("discovery routes to the owning remote host and reports an absent live browser", async () => {
  const response = await list(request("?hostId=remote-host"), context());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tabs: [] });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(calls).toEqual([
    ["resolve", sessionId, "remote-host"],
    ["list", "remote-host", sessionId],
  ]);
  tabs = [{ id: "tab-1", title: "Example", url: "https://example.org/" }];
  expect(await (await list(request(), context())).json()).toEqual({ tabs });
});

test("offline host refuses discovery and capture without sending commands", async () => {
  offline = true;
  expect((await list(request(), context())).status).toBe(503);
  expect((await frame(request("/frame?tabId=tab-1"), context())).status).toBe(
    503,
  );
  expect(
    (
      await control(
        new Request("http://localhost/control", {
          method: "POST",
          body: JSON.stringify({ id: "tab-1", actions: [{ type: "reload" }] }),
        }),
        context(),
      )
    ).status,
  ).toBe(503);
  expect(calls).toEqual(
    Array.from({ length: 3 }, () => ["resolve", sessionId, "local"]),
  );
});

test("capture routes the discovered ID to the owning remote host and returns JPEG bytes", async () => {
  const response = await frame(
    request("/frame?tabId=tab%2F1&hostId=remote-host"),
    context(),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-browser-viewport-width")).toBe("1280");
  expect(response.headers.get("x-browser-viewport-height")).toBe("720");
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
    255, 216, 255, 217,
  ]);
  expect(calls).toEqual([
    ["resolve", sessionId, "remote-host"],
    ["capture", "remote-host", sessionId, "tab/1"],
  ]);
});

test("invalid session and tab identifiers and malformed frame data are refused", async () => {
  expect((await list(request(), context("invalid"))).status).toBe(400);
  expect((await frame(request("/frame"), context())).status).toBe(400);
  expect(
    (await frame(request(`/frame?tabId=${"x".repeat(1025)}`), context()))
      .status,
  ).toBe(400);
  expect(calls).toEqual([]);
  data = "not base64";
  expect((await frame(request("/frame?tabId=tab-1"), context())).status).toBe(
    502,
  );
});

test("control validates an entire batch and routes it in order to the owning host", async () => {
  const payload = {
    id: "tab-1",
    actions: [
      {
        type: "key",
        event: "down",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 0,
        repeat: false,
      },
      { type: "text", text: "a" },
    ],
  };
  const send = (body: string, id = sessionId) =>
    control(
      new Request("http://localhost/control?hostId=remote-host", {
        method: "POST",
        body,
      }),
      context(id),
    );
  expect((await send("{")).status).toBe(400);
  expect(
    (
      await send(
        JSON.stringify({
          id: "tab-1",
          actions: [{ type: "reload" }, { type: "unknown" }],
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await send(JSON.stringify({ id: "tab-1", actions: [] }))).status,
  ).toBe(400);
  expect(
    (
      await send(
        JSON.stringify({
          id: "tab-1",
          actions: Array(65).fill({ type: "reload" }),
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await send(
        JSON.stringify({
          id: "tab-1",
          actions: [{ type: "text", text: "x".repeat(1024 * 1024) }],
        }),
      )
    ).status,
  ).toBe(413);
  expect((await send(JSON.stringify(payload), "invalid")).status).toBe(400);
  expect(calls).toEqual([]);
  const response = await send(JSON.stringify(payload));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({});
  expect(calls).toEqual([
    ["resolve", sessionId, "remote-host"],
    ["control", "remote-host", sessionId, payload],
  ]);
});

test("capture rejects invalid viewport dimensions", async () => {
  width = 0;
  expect((await frame(request("/frame?tabId=tab-1"), context())).status).toBe(
    502,
  );
  width = 1280;
  height = Infinity;
  expect((await frame(request("/frame?tabId=tab-1"), context())).status).toBe(
    502,
  );
});

test("video validates commands and routes uncached pulls to the owning host", async () => {
  const send = (body: unknown, id = sessionId) =>
    video(
      new Request("http://localhost/video?hostId=remote-host", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      context(id),
    );
  expect((await send({ op: "next", input: { id: "tab-1" } })).status).toBe(400);
  expect(
    (
      await send({
        op: "start",
        input: { id: "tab-1", endpoint: "http://localhost" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await send({ op: "start", input: { id: "tab-1" } }, "invalid")).status,
  ).toBe(400);
  expect(calls).toEqual([]);
  const command = { op: "next", input: { id: "tab-1", streamId: "stream-1" } };
  const response = await send(command);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    packets: [],
    width: 1280,
    height: 720,
    serverTime: 456,
  });
  expect(calls).toEqual([
    ["resolve", sessionId, "remote-host"],
    ["video", "remote-host", sessionId, command],
  ]);
  offline = true;
  expect((await send(command)).status).toBe(503);
});

test("video packets require bounded data and capture geometry", () => {
  const packet = {
    type: "key",
    timestamp: 123,
    capturedAt: 456,
    width: 1280,
    height: 720,
    data: "AQID",
  };
  const result = {
    width: 1280,
    height: 720,
    serverTime: 456,
    packets: [packet],
  };
  expect(Value.Check(BrowserVideoNextResultSchema, result)).toBe(true);
  expect(
    Value.Check(BrowserVideoNextResultSchema, {
      ...result,
      packets: [{ ...packet, width: 0 }],
    }),
  ).toBe(false);
  expect(
    Value.Check(BrowserVideoNextResultSchema, {
      ...result,
      packets: [{ ...packet, data: "not base64" }],
    }),
  ).toBe(false);
  expect(
    Value.Check(BrowserVideoNextResultSchema, {
      ...result,
      packets: Array(9).fill(packet),
    }),
  ).toBe(false);
});
