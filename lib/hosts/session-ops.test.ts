import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { sessionOps } = await import("./session-ops.ts");
const { invalidateSessionListCache } = await import("../session-reader.ts");

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** Throwaway agent dir holding one fixture session (as in session-reader.test.ts). */
function withAgentDir(run: () => Promise<void>) {
  const agentDir = mkdtempSync(join(tmpdir(), "keylime-session-ops-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const lines = [
    {
      type: "session",
      version: 3,
      id: SESSION_ID,
      cwd: tmpdir(),
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "hello" },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        provider: "test",
        model: "m",
        content: [{ type: "text", text: "hi" }],
      },
    },
  ];
  writeFileSync(
    join(projectDir, "2026-01-01_fixture.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  });
}

const options = { deferThinking: false, deferMedia: false };

test("readSession returns the session's info and context", () =>
  withAgentDir(async () => {
    const result = await sessionOps.readSession(SESSION_ID, options);
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.ok("info" in result.value);
    assert.equal(result.value.info.id, SESSION_ID);
    assert.ok(result.value.context.messages.length > 0);
  }));

test("readSession tails the active history and rejects invalidated cursors locally", () =>
  withAgentDir(async () => {
    const first = await sessionOps.readSession(SESSION_ID, {
      ...options,
      tail: 1,
    });
    assert.ok(first.ok);
    assert.deepEqual(first.value.context.entryIds, ["a1"]);
    assert.equal(first.value.historyHasMore, true);
    assert.ok(first.value.historyRevision);
    const previous = await sessionOps.readSession(SESSION_ID, {
      ...options,
      tail: 1,
      before: "a1",
      historyRevision: first.value.historyRevision,
    });
    assert.ok(previous.ok);
    assert.deepEqual(previous.value.context.entryIds, ["u1"]);
    assert.equal(previous.value.historyHasMore, false);
    assert.deepEqual(Object.keys(previous.value).sort(), [
      "context",
      "historyHasMore",
      "historyRevision",
    ]);
    const wrongBranch = await sessionOps.readSession(SESSION_ID, {
      ...options,
      tail: 1,
      before: "missing",
      historyRevision: first.value.historyRevision,
    });
    assert.ok(!wrongBranch.ok);
    assert.equal(wrongBranch.code, "session_history_changed");
    const file = join(
      process.env.PI_CODING_AGENT_DIR!,
      "sessions",
      "-project",
      "2026-01-01_fixture.jsonl",
    );
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "replacement" } })}\n`,
    );
    const changed = await sessionOps.readSession(SESSION_ID, {
      ...options,
      tail: 1,
      before: "a1",
      historyRevision: first.value.historyRevision,
    });
    assert.ok(!changed.ok);
    assert.equal(changed.status, 409);
    assert.equal(changed.code, "session_history_changed");
  }));

test("session costs cover both branches independently of paged history", () =>
  withAgentDir(async () => {
    const file = join(
      process.env.PI_CODING_AGENT_DIR!,
      "sessions",
      "-project",
      "2026-01-01_fixture.jsonl",
    );
    const timestamp = "2026-01-01T00:00:00.000Z";
    const usage = (total: number) => ({
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
    });
    const entries: object[] = [
      { type: "session", version: 3, id: SESSION_ID, cwd: tmpdir(), timestamp },
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp,
        message: { role: "user", content: "start" },
      },
      {
        type: "message",
        id: "other",
        parentId: "root",
        timestamp,
        message: {
          role: "assistant",
          provider: "test",
          model: "m",
          content: [{ type: "text", text: "alternate" }],
          usage: usage(1),
        },
      },
      {
        type: "message",
        id: "other-result",
        parentId: "other",
        timestamp,
        message: {
          role: "toolResult",
          toolName: "task",
          toolCallId: "other-call",
          content: [],
          details: { results: [{ id: "Other", exitCode: 0, cost: 20 }] },
        },
      },
    ];
    let parentId = "root";
    for (let i = 0; i < 35; i++) {
      const id = `page-${i}`;
      entries.push({
        type: "message",
        id,
        parentId,
        timestamp,
        message: { role: "user", content: `message ${i}` },
      });
      parentId = id;
    }
    entries.push(
      {
        type: "message",
        id: "current",
        parentId,
        timestamp,
        message: {
          role: "assistant",
          provider: "test",
          model: "m",
          content: [{ type: "text", text: "current" }],
          usage: usage(2),
        },
      },
      {
        type: "message",
        id: "current-result",
        parentId: "current",
        timestamp,
        message: {
          role: "toolResult",
          toolName: "task",
          toolCallId: "current-call",
          content: [],
          details: { results: [{ id: "Current", exitCode: 0, cost: 5 }] },
        },
      },
    );
    writeFileSync(
      file,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    invalidateSessionListCache();

    const page = await sessionOps.readSession(SESSION_ID, {
      ...options,
      tail: 3,
    });
    assert.ok(page.ok);
    assert.equal(page.value.historyHasMore, true);
    assert.ok(!page.value.context.entryIds.includes("other"));
    const snapshot = await sessionOps.readSubagentHistory(SESSION_ID);
    assert.ok(snapshot.ok);
    assert.deepEqual(snapshot.value.costs, { agent: 3, subagents: 25 });

    assert.ok(page.value.historyRevision);
    const previous = await sessionOps.readSession(SESSION_ID, {
      ...options,
      tail: 3,
      before: page.value.context.entryIds[0],
      historyRevision: page.value.historyRevision,
    });
    assert.ok(previous.ok);
    const afterPaging = await sessionOps.readSubagentHistory(SESSION_ID);
    assert.ok(afterPaging.ok);
    assert.deepEqual(afterPaging.value.costs, snapshot.value.costs);
  }));

test("readSession of an unknown id is a 404", () =>
  withAgentDir(async () => {
    const result = await sessionOps.readSession("missing", options);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.status, 404);
    assert.equal(result.code, "session_not_found");
  }));

test("readMedia rejects a hash that is not 64 lowercase hex chars", () =>
  withAgentDir(async () => {
    const result = await sessionOps.readMedia("x");
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.status, 400);
  }));

test("readMedia returns stored bytes and 404s a missing blob", () =>
  withAgentDir(async () => {
    const hash = "a".repeat(64);
    const missing = await sessionOps.readMedia(hash);
    assert.ok(!missing.ok);
    assert.equal(missing.status, 404);
    mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "blobs"), {
      recursive: true,
    });
    writeFileSync(
      join(process.env.PI_CODING_AGENT_DIR!, "blobs", hash),
      "bytes",
    );
    const result = await sessionOps.readMedia(hash);
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.ok(result.value instanceof Uint8Array);
    assert.equal(Buffer.from(result.value).toString(), "bytes");
  }));

test("renameSessionFile renames the session in listSessions", () =>
  withAgentDir(async () => {
    assert.deepEqual(
      await sessionOps.renameSessionFile(SESSION_ID, "Renamed"),
      { ok: true, value: null },
    );
    const session = (await sessionOps.listSessions()).find(
      (s) => s.id === SESSION_ID,
    );
    assert.equal(session?.name, "Renamed");
    const missing = await sessionOps.renameSessionFile("missing", "x");
    assert.ok(!missing.ok);
    assert.equal(missing.status, 404);
  }));
