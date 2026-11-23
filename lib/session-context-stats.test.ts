import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getSessionContextStats,
  getSessionHistoryPage,
  SessionFileTooLargeError,
  SessionHistoryChangedError,
} from "./session-reader";

function fixture(entries: unknown[], version = 3) {
  const dir = mkdtempSync(join(tmpdir(), "keylime-context-stats-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    [{ type: "session", version, id: "disk-id", cwd: dir }, ...entries]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function message(
  id: string,
  parentId: string | null,
  value: Record<string, unknown>,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00Z",
    message: value,
  };
}

test("aggregates only the compaction-aware active branch and keeps bodies out of the index", (t) => {
  const secret = "SECRET_BODY_AND_IMAGE_DATA";
  const { file, cleanup } = fixture([
    message("old", null, {
      role: "assistant",
      timestamp: 1000,
      content: [],
      usage: { output: 999 },
    }),
    message("kept", "old", {
      role: "user",
      timestamp: 2000,
      content: [{ type: "image", data: secret, mimeType: "image/png" }],
    }),
    {
      type: "compaction",
      id: "compact",
      parentId: "kept",
      timestamp: "1970-01-01T00:00:00Z",
      summary: secret,
      firstKeptEntryId: "kept",
      tokensBefore: 10,
    },
    message("abandoned", "compact", {
      role: "assistant",
      content: [{ type: "toolCall" }],
      usage: { input: 500 },
    }),
    {
      type: "branch_summary",
      id: "branch",
      parentId: "compact",
      timestamp: "1970-01-01T00:00:04Z",
      summary: secret,
    },
    message("assistant", "branch", {
      role: "assistant",
      provider: "p",
      model: "m",
      timestamp: "1970-01-01T00:00:08Z",
      content: [
        { type: "text", text: secret },
        { type: "toolCall", id: "t", name: "read", arguments: { secret } },
      ],
      usage: {
        input: 10,
        output: 20,
        cacheRead: 3,
        cacheWrite: 2,
        cost: { total: 0.25, other: secret },
        extra: secret,
      },
    }),
    message("result", "assistant", {
      role: "toolResult",
      timestamp: 9000,
      content: [{ type: "image", data: secret }],
      details: { secret },
    }),
    {
      type: "custom_message",
      id: "custom",
      parentId: "result",
      timestamp: "1970-01-01T00:00:10Z",
      customType: "note",
      content: secret,
      display: true,
    },
    message("unknown", "custom", {
      role: "newRole",
      timestamp: 11000,
      content: secret,
    }),
    message("partial", "unknown", {
      role: "assistant",
      timestamp: 15000,
      content: "malformed",
      usage: {
        input: "bad",
        output: 8,
        cacheRead: null,
        cost: { total: "bad" },
      },
    }),
  ]);
  t.after(cleanup);
  const originalParse = JSON.parse;
  let parses = 0;
  const parseMock = t.mock.method(
    JSON,
    "parse",
    (...args: Parameters<typeof JSON.parse>) => {
      parses++;
      return originalParse(...args);
    },
  );
  t.after(() => parseMock.mock.restore());
  const result = getSessionContextStats(file, "external-id", "Name");
  assert.deepEqual(result, {
    model: { provider: "p", modelId: "m" },
    stats: {
      sessionId: "external-id",
      sessionFile: file,
      sessionName: "Name",
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 8,
      tokens: { input: 10, output: 28, cacheRead: 3, cacheWrite: 2, total: 43 },
      cost: 0.25,
    },
    speedSamples: [5, 2],
  });
  assert.ok(parses > 0);
  parses = 0;
  assert.deepEqual(getSessionContextStats(file, "external-id", "Name"), result);
  assert.equal(
    parses,
    0,
    "a cached aggregate does not parse or seek message bodies",
  );
  const page = getSessionHistoryPage(file, null, 1);
  assert.equal(JSON.stringify(page.treeEntries).includes(secret), false);
  const index = [
    ...(globalThis.__ompSessionHistoryIndexes?.values() ?? []),
  ].find((candidate) =>
    candidate.treeEntries.some((entry) => entry.id === "partial"),
  );
  assert.ok(index);
  assert.equal(JSON.stringify(index).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("normalizes timestamps and retains the last 32 plausible speeds", (t) => {
  const entries: unknown[] = [
    message("root", null, { role: "user", timestamp: 0, content: "start" }),
  ];
  let parent = "root";
  for (let i = 1; i <= 35; i++) {
    const id = `a${i}`;
    entries.push(
      message(id, parent, {
        role: "assistant",
        timestamp: i * 2000,
        content: [],
        usage: { output: i * 2 },
      }),
    );
    parent = id;
  }
  entries.push(
    message("bad", parent, {
      role: "assistant",
      timestamp: 71000,
      content: [],
      usage: { output: 20000 },
    }),
  );
  entries.push(
    message("missing", "bad", {
      role: "assistant",
      timestamp: "invalid",
      content: [],
      usage: null,
    }),
  );
  const { file, cleanup } = fixture(entries);
  t.after(cleanup);
  const result = getSessionContextStats(file, "id");
  assert.deepEqual(
    result.speedSamples,
    Array.from({ length: 32 }, (_, i) => i + 4),
  );
  assert.equal(result.stats?.assistantMessages, 37);
  assert.equal(result.stats?.tokens.output, 21260);
});

test("malformed negative and overflowing usage stays finite and nonnegative", (t) => {
  const { file, cleanup } = fixture([
    message("first", null, {
      role: "assistant",
      content: [],
      usage: {
        input: -4,
        output: Number.MAX_VALUE,
        cacheRead: -1,
        cost: { total: Number.MAX_VALUE },
      },
    }),
    message("second", "first", {
      role: "assistant",
      content: [],
      usage: { output: Number.MAX_VALUE, cost: { total: Number.MAX_VALUE } },
    }),
  ]);
  t.after(cleanup);
  const stats = getSessionContextStats(file, "id").stats;
  assert.equal(stats?.tokens.input, 0);
  assert.equal(stats?.tokens.cacheRead, 0);
  assert.equal(stats?.tokens.output, Number.MAX_VALUE);
  assert.equal(stats?.tokens.total, Number.MAX_VALUE);
  assert.equal(stats?.cost, Number.MAX_VALUE);
});

test("legacy migrations preserve selected messages and timestamp semantics", (t) => {
  for (const version of [1, 2]) {
    const entries = [
      message("root", null, { role: "user", content: "old" }),
      message("hook", "root", {
        role: "hookMessage",
        timestamp: 2000,
        content: "hook",
      }),
      {
        type: "compaction",
        id: "compact",
        parentId: "hook",
        timestamp: "1970-01-01T00:00:00Z",
        summary: "sum",
        firstKeptEntryIndex: 2,
        firstKeptEntryId: "hook",
      },
      message("answer", "compact", {
        role: "assistant",
        timestamp: 4000,
        content: [],
        usage: { output: 10 },
      }),
    ];
    if (version === 1)
      for (const entry of entries) {
        Reflect.deleteProperty(entry, "id");
        Reflect.deleteProperty(entry, "parentId");
      }
    const { file, cleanup } = fixture(entries, version);
    t.after(cleanup);
    const result = getSessionContextStats(file, "id");
    assert.equal(result.stats?.totalMessages, 3);
    assert.equal(result.stats?.userMessages, 0);
    assert.equal(result.stats?.assistantMessages, 1);
    assert.deepEqual(result.speedSamples, [5]);
  }
});

test("empty, replaced and oversized files do not reuse stale statistics", (t) => {
  const { file, cleanup } = fixture([]);
  t.after(cleanup);
  assert.deepEqual(getSessionContextStats(file, "id"), {
    stats: null,
    model: null,
    speedSamples: [],
  });
  appendFileSync(
    file,
    JSON.stringify(message("u", null, { role: "user", content: "new" })) + "\n",
  );
  assert.equal(getSessionContextStats(file, "id").stats?.userMessages, 1);
  truncateSync(file, 1024 * 1024 * 1024 + 1);
  assert.throws(
    () => getSessionContextStats(file, "id"),
    SessionFileTooLargeError,
  );
});

test("rejects a file changed during the projected scan", (t) => {
  const { file, cleanup } = fixture([
    message("race", null, { role: "user", content: "trigger" }),
  ]);
  t.after(cleanup);
  const originalParse = JSON.parse;
  let changed = false;
  const parseMock = t.mock.method(
    JSON,
    "parse",
    (...args: Parameters<typeof JSON.parse>) => {
      const parsed: unknown = originalParse(...args);
      if (
        !changed &&
        typeof parsed === "object" &&
        parsed !== null &&
        "id" in parsed &&
        parsed.id === "race"
      ) {
        changed = true;
        appendFileSync(
          file,
          JSON.stringify(
            message("later", "race", { role: "user", content: "later" }),
          ) + "\n",
        );
      }
      return parsed;
    },
  );
  t.after(() => parseMock.mock.restore());
  assert.throws(
    () => getSessionContextStats(file, "id"),
    SessionHistoryChangedError,
  );
  assert.equal(changed, true);
  assert.equal(getSessionContextStats(file, "id").stats?.userMessages, 2);
});
