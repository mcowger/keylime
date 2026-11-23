import { expect, test } from "bun:test";
import {
  applyCoveredToolEvent,
  applyToolEvent,
  reconcileToolSnapshot,
  retainEndedTools,
  type ChatToolResult,
} from "./chat-tool-state";

const start = {
  type: "tool_execution_start",
  toolCallId: "call",
  toolName: "bash",
};
const update = {
  type: "tool_execution_update",
  toolCallId: "call",
  partialResult: {
    content: [{ type: "text", text: "working" }],
    details: { phase: 1 },
  },
};
const end = {
  type: "tool_execution_end",
  toolCallId: "call",
  result: {
    content: [{ type: "text", text: "failed" }],
    details: { exitCode: 1 },
  },
  isError: true,
};
const saved: ChatToolResult = {
  role: "toolResult",
  toolCallId: "call",
  toolName: "bash",
  content: [{ type: "text", text: "saved" }],
  isError: true,
};

test("tool frames seed, replace accumulated partial output, and finish with error", () => {
  let results = applyToolEvent({}, start, []);
  expect(results.call).toEqual({
    role: "toolResult",
    toolCallId: "call",
    toolName: "bash",
    content: [],
    partial: true,
  });
  results = applyToolEvent(results, update, []);
  expect(results.call).toEqual({
    role: "toolResult",
    toolCallId: "call",
    toolName: "bash",
    content: update.partialResult.content,
    details: { phase: 1 },
    partial: true,
  });
  results = applyToolEvent(results, end, []);
  expect(results.call).toEqual({
    role: "toolResult",
    toolCallId: "call",
    toolName: "bash",
    content: end.result.content,
    details: { exitCode: 1 },
    isError: true,
  });
  expect(applyToolEvent(results, update, [])).toEqual(results);
});

test("refresh after end keeps the result until persisted history wins", () => {
  let results = applyToolEvent({}, start, []);
  results = applyToolEvent(results, end, []);
  results = reconcileToolSnapshot(results, [], []);
  expect(results.call?.content).toEqual(end.result.content);
  expect(results.call?.isError).toBe(true);
  results = reconcileToolSnapshot(results, [], [saved]);
  expect(results).toEqual({});
  expect(applyToolEvent(results, end, [saved])).toEqual({});
});

test("covered buffered end survives a snapshot that omits completed calls", () => {
  let results = reconcileToolSnapshot({}, [start, update], []);
  results = reconcileToolSnapshot(results, [], []);
  results = applyCoveredToolEvent(results, end, []);
  expect(results.call?.content).toEqual(end.result.content);
  expect(results.call?.isError).toBe(true);
  expect(applyCoveredToolEvent(results, start, [])).toEqual(results);
  expect(reconcileToolSnapshot(results, [], [saved])).toEqual({});
  expect(applyCoveredToolEvent({}, end, [saved])).toEqual({});
});

test("snapshots replace running calls and retain ended calls across run boundaries", () => {
  let results = applyToolEvent({}, end, []);
  results = applyToolEvent(results, { ...start, toolCallId: "other" }, []);
  expect(Object.keys(retainEndedTools(results))).toEqual(["call"]);
  expect(Object.keys(reconcileToolSnapshot(results, [], []))).toEqual(["call"]);
});
