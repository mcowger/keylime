import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { TerminalAttachClientSchema, TerminalAttachServerSchema } from "./api-contracts/terminal-attach";
import { terminalAttachUpgrade } from "./terminal-attach";

const sessionId = "3aa8ab15-162b-4bee-97c8-2b35a65a7b32";
test("terminal attachment validates identity and requires a WebSocket upgrade", () => {
  let upgraded = false;
  const upgrade = () => { upgraded = true; return true; };
  const base = `http://localhost/api/terminal/attach?hostId=local&sessionId=${sessionId}`;
  assert.equal(terminalAttachUpgrade(new Request(base), upgrade)?.status, 426);
  assert.equal(terminalAttachUpgrade(new Request("http://localhost/api/terminal/attach?hostId=local&sessionId=invalid", { headers: { upgrade: "websocket" } }), upgrade)?.status, 400);
  assert.equal(upgraded, false);
  assert.equal(terminalAttachUpgrade(new Request(base, { headers: { upgrade: "websocket" } }), upgrade), undefined);
  assert.equal(upgraded, true);
});

test("terminal attachment frames enforce version, size and dimensions", () => {
  assert.equal(Value.Check(TerminalAttachClientSchema, { type: "hello", version: 1, cols: 80, rows: 24 }), true);
  assert.equal(Value.Check(TerminalAttachClientSchema, { type: "hello", version: 2, cols: 80, rows: 24 }), false);
  assert.equal(Value.Check(TerminalAttachClientSchema, { type: "resize", cols: 0, rows: 24 }), false);
  assert.equal(Value.Check(TerminalAttachClientSchema, { type: "input", data: "x".repeat(65537) }), false);
  assert.equal(Value.Check(TerminalAttachServerSchema, { type: "snapshot", data: "\u001b[H", cols: 80, rows: 24, cursor: 0 }), true);
  assert.equal(Value.Check(TerminalAttachServerSchema, { type: "notice", message: "Use Ctrl-] to detach" }), true);
});
