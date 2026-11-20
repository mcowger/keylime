import assert from "node:assert/strict";
import test from "node:test";
import { SharedRequests } from "./shared-requests.ts";
import type { HostUriScheme } from "./link-protocol.ts";

type Delivered = { id: string; frames: { t: string; id?: string | number }[] };
type Write = { op: string; tools?: { name: string }[] };

/** `defer`: hold omp's reply to each write until `reply()`, as a slow child would. */
function harness({ defer = false } = {}) {
  const delivered: Delivered[] = [],
    writes: Write[] = [],
    up = new Set(["a"]),
    replies: (() => void)[] = [];
  const shared = new SharedRequests({
    member: () => "a",
    isUp: (id) => up.has(id),
    deliver: (id, lines) =>
      delivered.push({ id, frames: lines.map((line) => JSON.parse(line)) }),
    write: (op, args, onReply) => {
      writes.push({ op, ...args } as Write);
      if (defer && onReply) replies.push(onReply);
      else onReply?.();
    },
  });
  return {
    shared,
    delivered,
    writes,
    up,
    reply: () => {
      for (const onReply of replies.splice(0)) onReply?.();
    },
  };
}

test("first dialog answer wins and native cancellation prevents a late answer", () => {
  const h = harness();
  const q = { t: "ui_request", id: 1, method: "formDialog", args: [] };
  h.shared.note(q, JSON.stringify(q));
  assert.equal(h.shared.answer("a", { t: "ui_response", id: 1 }), true);
  assert.equal(h.shared.answer("a", { t: "ui_response", id: 1 }), false);
  assert.deepEqual(
    h.shared.pending("a"),
    [],
    "settled dialogs are not replayed",
  );
  const cancelled = { ...q, id: 2 };
  h.shared.note(cancelled, JSON.stringify(cancelled));
  h.shared.note({ t: "ui_end", id: 2 }, "");
  assert.equal(h.shared.answer("a", { t: "ui_response", id: 2 }), false);
  assert.deepEqual(h.shared.pending("a"), []);
  const call = { t: "host_tool_call", id: 1, toolName: "open_url" };
  h.shared.setTools("a", [{ name: "open_url" }], []);
  h.shared.note(call, JSON.stringify(call));
  assert.equal(
    h.delivered.at(-1)!.frames[0].t,
    "host_tool_call",
    "a dialog's id never completes a host callback numbered alike",
  );
});

test("callbacks wait for the controller and cannot be answered by a stale link", () => {
  const h = harness();
  h.shared.setTools("a", [{ name: "open_url" }], []);
  h.up.delete("a");
  const call = { t: "host_tool_call", id: "t", toolName: "open_url" };
  h.shared.note(call, JSON.stringify(call));
  assert.deepEqual(h.delivered, []);
  h.up.add("a");
  h.shared.linkChanged();
  assert.deepEqual(h.delivered, [{ id: "a", frames: [call] }]);
  assert.equal(h.shared.answer("b", { t: "host_tool_result", id: "t" }), false);
  assert.equal(h.shared.answer("a", { t: "host_tool_result", id: "t" }), true);
});

test("unregistered callback waits, malformed registrations do not replace the union", () => {
  const h = harness();
  const call = { t: "host_uri_request", id: "u", url: "browser:clip" };
  h.shared.note(call, JSON.stringify(call));
  assert.deepEqual([...h.delivered], []);
  h.shared.setTools("a", [], [{ scheme: "browser", writable: false }]);
  assert.equal(h.delivered[0].id, "a");
  for (const tools of [[null], [{ name: "" }], [{ name: "x", parameters: [] }]])
    assert.throws(() => h.shared.setTools("b", tools, []));
  for (const schemes of [
    ["browser"],
    [{ scheme: "bad scheme", writable: true }],
    [{ scheme: "browser" }],
  ])
    assert.throws(() => h.shared.setTools("b", [], schemes as HostUriScheme[]));
});

test("a repeated completed native callback never executes a second time", () => {
  const h = harness(),
    call = { t: "host_tool_call", id: "once", toolName: "open_url" };
  h.shared.setTools("a", [{ name: "open_url" }], []);
  h.shared.note(call, JSON.stringify(call));
  assert.equal(
    h.shared.answer("a", { t: "host_tool_result", id: "once" }),
    true,
  );
  h.shared.note(call, JSON.stringify(call));
  assert.equal(h.delivered.length, 1);
});

test("a read-only URI registration cannot answer a write request", () => {
  const h = harness();
  h.shared.setTools("a", [], [{ scheme: "browser", writable: false }]);
  const request = { t: "host_uri_request", url: "browser:x" };
  const write = { ...request, id: "w", operation: "write" };
  const read = { ...request, id: "r", operation: "read" };
  h.shared.note(write, JSON.stringify(write));
  h.shared.note(read, JSON.stringify(read));
  assert.deepEqual(h.delivered, [{ id: "a", frames: [read] }]);
});

test("a call that arrives while its registration is briefly missing dispatches once it is restored", () => {
  const h = harness(),
    tool = { name: "open_url", description: "Open" };
  h.shared.setTools("a", [tool], []);
  h.shared.setTools("a", [], []); // omp already advertised the tool when it made the call below.
  const call = { t: "host_tool_call", id: "late", toolName: "open_url" };
  h.shared.note(call, JSON.stringify(call));
  assert.deepEqual(h.delivered, []);
  h.shared.setTools("a", [tool], []);
  assert.deepEqual(h.delivered, [{ id: "a", frames: [call] }]);
});

test("a pending call never dispatches to a different definition registered under its name first", () => {
  const h = harness(),
    original = { name: "open_url", description: "Open" },
    other = { name: "open_url", description: "Other version" };
  h.shared.setTools("a", [original], []);
  h.shared.setTools("a", [], []);
  const call = { t: "host_tool_call", id: "late", toolName: "open_url" };
  h.shared.note(call, JSON.stringify(call));
  h.shared.setTools("a", [other], []);
  assert.deepEqual(
    h.delivered,
    [],
    "the other version is not what omp was advertised",
  );
  h.shared.setTools("a", [original], []);
  assert.deepEqual(h.delivered, [{ id: "a", frames: [call] }]);
});

test("a call omp made before it read a replacement definition keeps the old one, even if the new one registered first", () => {
  const h = harness({ defer: true }),
    original = { name: "open_url", description: "Open" },
    other = { name: "open_url", description: "Other version" };
  h.shared.setTools("a", [original], []);
  h.reply();
  h.shared.setTools("a", [], []);
  h.shared.setTools("a", [other], []); // omp has not confirmed the replacement yet
  const early = { t: "host_tool_call", id: "early", toolName: "open_url" };
  h.shared.note(early, JSON.stringify(early));
  assert.deepEqual(
    h.delivered,
    [],
    "an unconfirmed replacement never takes a call made under the old definition",
  );
  h.reply();
  const late = { t: "host_tool_call", id: "late", toolName: "open_url" };
  h.shared.note(late, JSON.stringify(late));
  assert.deepEqual(
    h.delivered,
    [{ id: "a", frames: [late] }],
    "after omp's reply, calls use the new definition",
  );
  h.shared.setTools("a", [original], []);
  h.reply();
  assert.deepEqual(
    h.delivered.at(-1),
    { id: "a", frames: [early] },
    "the early call waits for its own definition",
  );
});
