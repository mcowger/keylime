import { beforeEach, expect, mock, test } from "bun:test";

const sessionId = "11111111-1111-4111-8111-111111111111";
const calls: unknown[][] = [];
let offline = false;
let tabs: { id: string; title: string; url: string }[] = [];
let data = "/9j/2Q==";
let width = 1280;
let height = 720;

mock.module("@/lib/api-utils", () => ({
  resolveSessionHostOr404: async (id: string) => {
    calls.push(["resolve", id]);
    return { host: { id: "remote-host" } };
  },
  hostOfflineResponse: () => offline ? Response.json({ code: "host_offline" }, { status: 503 }) : null,
  apiErrorResponse: (error: unknown) => Response.json({ error: String(error) }, { status: 502 }),
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
}));

// The handlers must load after their host dependencies have been mocked.
const { GET: list } = await import("./route");
const { GET: frame } = await import("./frame/route");
const { POST: control } = await import("./control/route");
const context = (id = sessionId) => ({ params: Promise.resolve({ id }) });
const request = (query = "") => new Request(`http://localhost/api/sessions/${sessionId}/browser${query}`);

beforeEach(() => {
  calls.length = 0;
  offline = false;
  tabs = [];
  data = "/9j/2Q==";
  width = 1280;
  height = 720;
});

test("discovery routes to the owning remote host and reports an absent live browser", async () => {
  const response = await list(request(), context());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tabs: [] });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(calls).toEqual([["resolve", sessionId], ["list", "remote-host", sessionId]]);
  tabs = [{ id: "tab-1", title: "Example", url: "https://example.org/" }];
  expect(await (await list(request(), context())).json()).toEqual({ tabs });
});

test("offline host refuses discovery and capture without sending commands", async () => {
  offline = true;
  expect((await list(request(), context())).status).toBe(503);
  expect((await frame(request("/frame?tabId=tab-1"), context())).status).toBe(503);
  expect((await control(new Request("http://localhost/control", { method: "POST", body: JSON.stringify({ id: "tab-1", action: { type: "reload" } }) }), context())).status).toBe(503);
  expect(calls).toEqual([["resolve", sessionId], ["resolve", sessionId], ["resolve", sessionId]]);
});

test("capture routes the discovered ID to the owning remote host and returns JPEG bytes", async () => {
  const response = await frame(request("/frame?tabId=tab%2F1"), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-browser-viewport-width")).toBe("1280");
  expect(response.headers.get("x-browser-viewport-height")).toBe("720");
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([255, 216, 255, 217]);
  expect(calls).toEqual([["resolve", sessionId], ["capture", "remote-host", sessionId, "tab/1"]]);
});

test("invalid session and tab identifiers and malformed frame data are refused", async () => {
  expect((await list(request(), context("invalid"))).status).toBe(400);
  expect((await frame(request("/frame"), context())).status).toBe(400);
  expect((await frame(request(`/frame?tabId=${"x".repeat(1025)}`), context())).status).toBe(400);
  expect(calls).toEqual([]);
  data = "not base64";
  expect((await frame(request("/frame?tabId=tab-1"), context())).status).toBe(502);
});

test("control validates its payload and routes one action to the owning host", async () => {
  const payload = { id: "tab-1", action: { type: "reload" } };
  const send = (body: string, id = sessionId) => control(new Request("http://localhost/control", { method: "POST", body }), context(id));
  expect((await send("{" )).status).toBe(400);
  expect((await send(JSON.stringify({ id: "tab-1", action: { type: "unknown" } }))).status).toBe(400);
  expect((await send(JSON.stringify(payload), "invalid")).status).toBe(400);
  expect(calls).toEqual([]);
  const response = await send(JSON.stringify(payload));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({});
  expect(calls).toEqual([["resolve", sessionId], ["control", "remote-host", sessionId, payload]]);
});

test("capture rejects invalid viewport dimensions", async () => {
  width = 0;
  expect((await frame(request("/frame?tabId=tab-1"), context())).status).toBe(502);
  width = 1280;
  height = Infinity;
  expect((await frame(request("/frame?tabId=tab-1"), context())).status).toBe(502);
});
