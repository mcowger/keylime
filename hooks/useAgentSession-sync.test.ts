import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { SessionContext } from "../lib/types";
import type { CoalescableEvent } from "../lib/message-update-coalescer";
import type { AgentEvent } from "./useAgentSession-stream";
import type { SessionLiveFields } from "./useAgentSession-sync";

const { createSessionCatchUp, MISSING_BASE_RETRY_MS } =
  await import("./useAgentSession-sync.ts");

test("a newer user delivery cannot block recovery of an unrelated assistant partial", async (t) => {
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
  const context = {
    messages: [],
    entryIds: [],
    thinkingLevel: "off",
    model: null,
    todoPhases: [],
  };
  let displayed = "visible before the gap";
  let release!: () => void;
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve(
            Response.json({
              sessionId: "s1",
              mode: "append",
              baseEntryId: null,
              context,
              cursor: { firstEntryId: null, lastEntryId: null },
              hasMore: false,
              leafId: null,
              live: {
                cursor: { streamId: "stream", sequence: 2 },
                isStreaming: true,
                isPromptRunning: true,
                isCompacting: false,
                streamingMessage: {
                  role: "assistant",
                  content: [{ type: "text", text: "recovered partial" }],
                },
                toolEvents: [],
              },
            }),
          );
        started();
      }),
  );
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1",
    scope: () => "same-run",
    history() {},
    subscribe: () => false,
    live(snapshot, fields) {
      if (fields.message) {
        const message = snapshot.streamingMessage as {
          content: { text: string }[];
        };
        displayed = message.content[0].text;
      }
    },
  });
  catchUp.seed(context);
  catchUp.observe({
    type: "connected",
    web: { streamId: "stream", sequence: 1 },
  });
  const pending = catchUp.request();
  await requested;
  catchUp.observe({
    type: "message_end",
    message: { role: "user", content: "steering" },
    web: { streamId: "stream", sequence: 3 },
  });
  release();
  await pending;
  assert.equal(displayed, "recovered partial");
});

test("a held full response cannot resurrect truncated entries and fresh catch-up recovers later appends", async (t) => {
  let displayed!: SessionContext;
  let requests = 0;
  let release!: () => void;
  let started!: () => void;
  const following = new Promise<void>((resolve) => {
    started = resolve;
  });
  const context = (ids: string[]): SessionContext => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids,
    thinkingLevel: "off",
    model: null,
    todoPhases: [],
  });
  t.mock.method(globalThis, "fetch", (url: Parameters<typeof fetch>[0]) => {
    requests += 1;
    const page = (ids: string[], mode: string, baseEntryId: string | null) =>
      Response.json({
        sessionId: "s1",
        mode,
        baseEntryId,
        context: context(ids),
        cursor: { firstEntryId: "a", lastEntryId: ids.at(-1) },
        hasMore: false,
        leafId: ids.at(-1),
        live: null,
      });
    if (requests === 1)
      return Promise.resolve(page(["a", "b"], "replace", null));
    assert.equal(
      JSON.parse(
        new URL(
          url instanceof Request ? url.url : url,
          "http://localhost",
        ).searchParams.get("cursor")!,
      ).lastEntryId,
      "b",
    );
    return new Promise<Response>((resolve) => {
      release = () => resolve(page(["d"], "append", "b"));
      started();
    });
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1",
    scope: () => "same-view",
    history(next) {
      displayed = next;
    },
    live() {},
    subscribe: () => false,
  });
  catchUp.seed(context(["a", "b", "c"]));
  const fullReadPosition = catchUp.position();
  await catchUp.request();
  assert.deepEqual(displayed.entryIds, ["a", "b"]);
  catchUp.seed(context(["a", "b", "c"]), fullReadPosition);
  assert.deepEqual(displayed.entryIds, ["a", "b"]);
  await following;
  release();
  await new Promise<void>(setImmediate);
  assert.deepEqual(displayed.entryIds, ["a", "b", "d"]);
  assert.equal(requests, 2);
});

test("backfill publishes older pages before deferred live catch-up", async (t) => {
  const context = (ids: string[]): SessionContext => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  const page = Promise.withResolvers<Response>();
  let displayed!: SessionContext;
  let completed = false;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : input, "http://localhost");
    requests.push(url.pathname + url.search);
    if (url.searchParams.has("before")) {
      assert.equal(url.searchParams.get("historyRevision"), "rev");
      return page.promise;
    }
    assert.deepEqual(JSON.parse(url.searchParams.get("cursor")!), { firstEntryId: "a", lastEntryId: "d" });
    return Promise.resolve(Response.json({ sessionId: "s1", mode: "append", baseEntryId: "d", context: context(["e"]), cursor: { firstEntryId: "a", lastEntryId: "e" }, hasMore: false, leafId: null, live: null }));
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "scope", history(next) { displayed = next; },
    live() {}, subscribe: () => false,
  });
  catchUp.seed(context(["c", "d"]));
  catchUp.backfill("rev", () => { completed = true; });
  const sync = catchUp.request();
  assert.equal(requests.length, 1);
  assert.deepEqual(displayed.entryIds, ["c", "d"]);
  page.resolve(Response.json({ context: context(["a", "b"]), historyHasMore: false, historyRevision: "rev" }));
  assert.equal(completed, false);
  await sync;
  assert.deepEqual(displayed.entryIds, ["a", "b", "c", "d", "e"]);
  assert.equal(completed, true);
});

test("backfill assembles multiple older pages in chronological order", async (t) => {
  const context = (ids: string[]): SessionContext => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  let displayed!: SessionContext;
  const completed = Promise.withResolvers<void>();
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : input, "http://localhost");
    const before = url.searchParams.get("before");
    const ids = before === "e" ? ["c", "d"] : ["a", "b"];
    assert.ok(before === "e" || before === "c");
    return Promise.resolve(Response.json({ context: context(ids), historyHasMore: before === "e", historyRevision: "rev" }));
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "scope", history(next) { displayed = next; },
    live() {}, subscribe: () => false,
  });
  catchUp.seed(context(["e", "f"]), null, false);
  catchUp.backfill("rev", completed.resolve);
  await completed.promise;
  assert.deepEqual(displayed.entryIds, ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(displayed.messages.map((message) => message.role === "user" ? message.content : null), ["a", "b", "c", "d", "e", "f"]);
});
test("failed backfill and failed replacement do not declare the tail complete", async (t) => {
  const context: SessionContext = {
    messages: [{ role: "user", content: "new" }], entryIds: ["new"],
    thinkingLevel: "off", model: null, todoPhases: [],
  };
  let complete = true;
  t.mock.method(globalThis, "fetch", () => Promise.resolve(new Response(null, { status: 503 })));
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "scope",
    history(_context, _leaf, _metadata, ready) { complete = ready === true; },
    live() {}, subscribe: () => false,
  });
  catchUp.seed(context, null, false);
  catchUp.backfill("rev");
  await catchUp.request();
  assert.equal(complete, false);
});


test("changed history discards backfill and replaces the partial transcript", async (t) => {
  const context = (ids: string[]): SessionContext => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  let displayed!: SessionContext;
  const started = Promise.withResolvers<void>();
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(input instanceof Request ? input.url : input, "http://localhost");
    if (url.searchParams.has("before")) return Promise.resolve(new Response(null, { status: 409 }));
    assert.equal(url.searchParams.has("cursor"), false);
    started.resolve();
    return Promise.resolve(Response.json({ sessionId: "s1", mode: "replace", baseEntryId: null, context: context(["x"]), cursor: { firstEntryId: "x", lastEntryId: "x" }, hasMore: false, leafId: null, live: null }));
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "scope", history(next) { displayed = next; },
    live() {}, subscribe: () => false,
  });
  catchUp.seed(context(["c", "d"]));
  catchUp.backfill("rev");
  await started.promise;
  await catchUp.request();
  assert.deepEqual(displayed.entryIds, ["x"]);
});

test("backfill cannot publish after selecting another branch", async (t) => {
  const context = (ids: string[]): SessionContext => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  const page = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", () => page.promise);
  let displayed!: SessionContext;
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "scope", history(next) { displayed = next; },
    live() {}, subscribe: () => false,
  });
  catchUp.seed(context(["c"]));
  catchUp.backfill("rev");
  catchUp.select({ leafId: "branch", includePreCompaction: false });
  page.resolve(Response.json({ context: context(["a", "b"]), historyHasMore: false, historyRevision: "rev" }));
  await new Promise<void>(setImmediate);
  assert.deepEqual(displayed.entryIds, ["c"]);
});

// omp's delta updates through catch-up and the coalescer, wired as useAgentSession wires them.
const { createMessageUpdateCoalescer } =
  await import("../lib/message-update-coalescer.ts");

function deltaPipeline(t: TestContext) {
  const shown: (string | undefined)[] = [];
  const liveCalls: SessionLiveFields[] = [];
  let page: unknown;
  let scheduled: (() => void)[] = [];
  t.mock.method(globalThis, "fetch", async () => Response.json(page));
  const dispatch = (event: CoalescableEvent) => {
    if (event.type === "message_update") {
      const message = event.message as { content: { text?: string }[] };
      shown.push(message.content[0]?.text);
    }
  };
  const coalescer = createMessageUpdateCoalescer(dispatch, (flush) => {
    scheduled.push(flush);
    return () => {
      scheduled = scheduled.filter((job) => job !== flush);
    };
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1",
    scope: () => "run",
    history() {},
    subscribe: () => false,
    live(snapshot, fields) {
      liveCalls.push(fields);
      coalescer.flush();
      if (fields.message)
        dispatch({
          type: "message_update",
          message: snapshot.streamingMessage,
        });
      coalescer.seed(
        snapshot.streamingMessageId ?? null,
        snapshot.streamingMessage,
        snapshot.cursor.sequence,
        fields.message,
      );
    },
  });
  const web = (sequence: number) => ({ streamId: "s", sequence });
  return {
    shown,
    liveCalls,
    web,
    feed(event: AgentEvent) {
      if (catchUp.observe(event) !== "stale") coalescer.push(event);
    },
    fire() {
      for (const flush of scheduled.splice(0)) flush();
    },
    delta: (sequence: number, assistantMessageEvent: object): AgentEvent => ({
      type: "message_update",
      messageId: "m1",
      message: { role: "assistant" },
      assistantMessageEvent,
      web: web(sequence),
    }),
    async snapshot(
      sequence: number,
      text: string,
      { busy = true }: { busy?: boolean } = {},
    ) {
      page = {
        sessionId: "s1",
        mode: "replace",
        baseEntryId: null,
        context: { messages: [], entryIds: [] },
        cursor: { firstEntryId: null, lastEntryId: null },
        hasMore: false,
        leafId: null,
        live: {
          cursor: { streamId: "s", sequence },
          isStreaming: busy,
          isPromptRunning: busy,
          isCompacting: false,
          streamingMessage: {
            role: "assistant",
            content: [{ type: "text", text }],
          },
          streamingMessageId: "m1",
          toolEvents: [],
        },
      };
      await catchUp.request();
    },
  };
}

test("a delta already in a catch-up snapshot is not applied again when its frame arrives after it", async (t) => {
  const pipe = deltaPipeline(t);
  pipe.feed({
    type: "message_start",
    messageId: "m1",
    message: { role: "assistant", content: [] },
    web: pipe.web(1),
  });
  pipe.feed(
    pipe.delta(2, {
      type: "text_start",
      contentIndex: 0,
      block: { type: "text", text: "" },
    }),
  );
  // The snapshot is taken at sequence 3, so it holds "ab"; frame 3 is still on its way.
  await pipe.snapshot(3, "ab");
  pipe.feed(
    pipe.delta(3, { type: "text_delta", contentIndex: 0, delta: "ab" }),
  );
  pipe.feed(pipe.delta(4, { type: "text_delta", contentIndex: 0, delta: "c" }));
  pipe.fire();
  assert.equal(pipe.shown.at(-1), "abc");
});

test("a snapshot no field takes still completes deltas that arrived without their message", async (t) => {
  const pipe = deltaPipeline(t);
  pipe.feed({ type: "connected", web: pipe.web(4) });
  // No base: both deltas are held.
  pipe.feed(pipe.delta(5, { type: "text_delta", contentIndex: 0, delta: "c" }));
  pipe.feed({ type: "auto_compaction_start", web: pipe.web(6) });
  pipe.feed(pipe.delta(7, { type: "text_delta", contentIndex: 0, delta: "d" }));
  // Older than the lifecycle frame and the last delta: no field applies, yet it holds delta 5.
  await pipe.snapshot(5, "abc", { busy: false });
  assert.deepEqual(pipe.liveCalls.at(-1), {
    message: false,
    lifecycle: false,
    tools: null,
  });
  pipe.fire();
  assert.equal(pipe.shown.at(-1), "abcd");
});

// Base-less deltas through the coalescer into catch-up, reads failing at once, on a clock the test moves (performance.now and timers).
function missingBasePipeline(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 10_000;
  t.mock.method(performance, "now", () => clock);
  const requests: (RequestInfo | URL)[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: Parameters<typeof fetch>[0]) => {
      requests.push(url);
      throw new TypeError("Failed to fetch");
    },
  );
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1",
    scope: () => "run",
    history() {},
    subscribe: () => false,
    live() {},
  });
  const coalescer = createMessageUpdateCoalescer(
    () => {},
    () => () => {},
    () => catchUp.requestMissingBase(),
  );
  let sequence = 0;
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve)); // the failed read ends
  return {
    requests,
    catchUp,
    async delta() {
      sequence += 1;
      coalescer.push({
        type: "message_update",
        messageId: "m1",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "x",
        },
        web: { streamId: "s", sequence },
      });
      await settle();
    },
    async wait(ms: number) {
      clock += ms;
      t.mock.timers.tick(ms);
      await settle();
    },
  };
}

test("deltas without a message while reads fail fast send one context request per window", async (t) => {
  const pipe = missingBasePipeline(t);
  for (let i = 0; i < 20; i += 1) await pipe.delta();
  assert.equal(pipe.requests.length, 1, "twenty base-less deltas, one request");
  await pipe.wait(MISSING_BASE_RETRY_MS);
  assert.equal(
    pipe.requests.length,
    2,
    "the window's end sends the one request the dropped deltas were owed",
  );
  await pipe.wait(MISSING_BASE_RETRY_MS);
  assert.equal(pipe.requests.length, 2, "nothing more without another delta");
  await pipe.delta();
  assert.equal(
    pipe.requests.length,
    3,
    "a delta after a quiet window asks at once",
  );
});

test("a base-less delta dropped inside the window still gets a request when it ends, though no delta follows", async (t) => {
  const pipe = missingBasePipeline(t);
  await pipe.delta();
  await pipe.delta();
  assert.equal(pipe.requests.length, 1);
  await pipe.wait(MISSING_BASE_RETRY_MS - 1);
  assert.equal(pipe.requests.length, 1, "not before the window ends");
  await pipe.wait(1);
  assert.equal(
    pipe.requests.length,
    2,
    "the trailing request, with the stream quiet",
  );
});

test("invalidate (select, disconnect) starts a fresh window and drops the trailing request", async (t) => {
  const pipe = missingBasePipeline(t);
  await pipe.delta();
  await pipe.delta();
  pipe.catchUp.disconnect();
  await pipe.wait(MISSING_BASE_RETRY_MS);
  assert.equal(
    pipe.requests.length,
    1,
    "the pending trailing request was cancelled",
  );
  await pipe.delta();
  assert.equal(
    pipe.requests.length,
    2,
    "and the window was reset: this delta asks at once",
  );
});
