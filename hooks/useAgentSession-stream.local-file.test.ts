// open_file with a local:// URL asks the server which file it is; that lookup must end, one way or the other.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import type { HostToolHandlers } from "./useAgentSession-stream";

const { runHostTool, LOCAL_FILE_LOOKUP_TIMEOUT_MS } =
  await import("./useAgentSession-stream.ts");

test("a local:// lookup the server never answers ends the open_file call with an error, not a hang", async (t) => {
  // Client deadlines are an AbortController and a timer: AbortSignal.timeout is missing in older browsers.
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(
    AbortSignal,
    "timeout",
  );
  assert.ok(timeoutDescriptor);
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: undefined,
  });
  t.after(() =>
    Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  t.mock.method(
    globalThis,
    "fetch",
    (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  );
  const opened: Parameters<NonNullable<HostToolHandlers["openFile"]>>[] = [];
  const settled: { result: { text: string; isError: boolean } | null } = {
    result: null,
  };
  const call = runHostTool(
    "open_file",
    { path: "local://note.md" },
    {
      openUrl: () => "",
      openFile: (...args) => {
        opened.push(args);
      },
    },
    "s1",
  );
  call.then((result) => {
    settled.result = result;
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  t.mock.timers.tick(LOCAL_FILE_LOOKUP_TIMEOUT_MS - 1);
  await flush();
  assert.equal(settled.result, null, "still waiting before the deadline");
  t.mock.timers.tick(1);
  await flush();
  const result = settled.result as { text: string; isError: boolean } | null;
  assert.ok(result, "the call settles at the deadline");
  assert.equal(result.isError, true);
  assert.match(result.text, /did not answer/);
  assert.equal(aborted, true, "the stalled request is cancelled");
  assert.deepEqual(opened, [], "no tab opens");
});

test("a local:// lookup that answers in time is not cut short", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request: { signal?: AbortSignal | null } = {};
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      request.signal = init?.signal;
      return Response.json({ path: "/sessions/s1/local/note.md" });
    },
  );
  const opened: Parameters<NonNullable<HostToolHandlers["openFile"]>>[] = [];
  const result = await runHostTool(
    "open_file",
    { path: "local://note.md" },
    {
      openUrl: () => "",
      openFile: (...args) => {
        opened.push(args);
      },
    },
    "s1",
  );
  assert.deepEqual(result, { text: "Opened local://note.md", isError: false });
  assert.deepEqual(
    opened,
    [["/sessions/s1/local/note.md", "note.md", undefined]],
    "no owner other than the caller was named",
  );
  // The deadline timer is not left running after the answer: nothing fires when it would have.
  t.mock.timers.tick(LOCAL_FILE_LOOKUP_TIMEOUT_MS * 2);
  assert.ok(request.signal);
  assert.equal(
    request.signal.aborted,
    false,
    "a completed lookup leaves no deadline timer",
  );
});

test("canceling one local-file lookup closes its HTTP request without interrupting another", async (t) => {
  const arrived = new Map<string, ServerResponse>();
  let bothArrived!: () => void;
  const ready = new Promise<void>((resolve) => {
    bothArrived = resolve;
  });
  let canceledClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    canceledClosed = resolve;
  });
  let otherClosed = false;
  const server = createServer((req, res) => {
    const sid = req.url!.split("/")[3];
    arrived.set(sid, res);
    res.on("close", () => {
      if (sid === "canceled") canceledClosed();
      else otherClosed = true;
    });
    if (arrived.size === 2) bothArrived();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controllers = [new AbortController(), new AbortController()];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const realFetch = globalThis.fetch;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.mock.method(
    globalThis,
    "fetch",
    (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      realFetch(new URL(url instanceof Request ? url.url : url, origin), init),
  );
  const opened: string[] = [];
  const handlers = {
    openUrl: () => "",
    openFile: (path: string) => {
      opened.push(path);
    },
  };
  const canceled = runHostTool(
    "open_file",
    { path: "local://canceled.md" },
    handlers,
    "canceled",
    controllers[0].signal,
  );
  const other = runHostTool(
    "open_file",
    { path: "local://other.md" },
    handlers,
    "other",
    controllers[1].signal,
  );
  await ready;
  controllers[0].abort();
  const result = await canceled;
  await closed;
  assert.equal(result.isError, true);
  assert.equal(otherClosed, false, "the other HTTP lookup is still connected");
  const otherResponse = arrived.get("other");
  assert.ok(otherResponse);
  otherResponse
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ path: "/sessions/other/local/other.md" }));
  assert.equal((await other).isError, false);
  assert.deepEqual(opened, ["/sessions/other/local/other.md"]);
});
