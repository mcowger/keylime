import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./terminal-input");
}

function key(
  keyValue: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
  > = {},
) {
  return {
    key: keyValue,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

test("maps navigation and editing keys to terminal sequences", async () => {
  const { toTerminalKeyData } = await loadSubject();

  assert.equal(toTerminalKeyData(key("ArrowDown")), "\x1b[B");
  assert.equal(toTerminalKeyData(key("Home")), "\x1b[H");
  assert.equal(toTerminalKeyData(key("Delete")), "\x1b[3~");
  assert.equal(toTerminalKeyData(key("Tab", { shiftKey: true })), "\x1b[Z");
  assert.equal(toTerminalKeyData(key("Enter", { shiftKey: true })), "\n");
});

test("maps legacy control and alt keys used by pi-tui", async () => {
  const { toTerminalKeyData } = await loadSubject();

  assert.equal(toTerminalKeyData(key("c", { ctrlKey: true })), "\x03");
  assert.equal(toTerminalKeyData(key("]", { ctrlKey: true })), "\x1d");
  assert.equal(toTerminalKeyData(key("ArrowLeft", { altKey: true })), "\x1bb");
  assert.equal(toTerminalKeyData(key("x", { altKey: true })), "\x1bx");
  assert.equal(toTerminalKeyData(key("v", { ctrlKey: true })), null);
  assert.equal(toTerminalKeyData(key("x", { metaKey: true })), null);
});

test("leaves printable text to the text input and wraps pasted text", async () => {
  const { asBracketedPaste, toTerminalKeyData } = await loadSubject();

  assert.equal(toTerminalKeyData(key("a")), null);
  assert.equal(toTerminalKeyData(key(" ")), null);
  assert.equal(
    asBracketedPaste("first\nsecond"),
    "\x1b[200~first\nsecond\x1b[201~",
  );
});

test("touch Ctrl encodes control characters and consumes only a single-key input", async () => {
  const { applyTerminalControl } = await import("./terminal-control");
  for (const [input, output] of [
    [" ", "\x00"],
    ["c", "\x03"],
    ["3", "\x1b"],
    ["4", "\x1c"],
    ["5", "\x1d"],
    ["6", "\x1e"],
    ["7", "\x1f"],
    ["8", "\x7f"],
    ["[", "\x1b"],
    ["?", "\x7f"],
    ["2", "2"],
  ]) {
    assert.deepEqual(applyTerminalControl(input, true), {
      data: output,
      consumed: true,
    });
  }
  assert.deepEqual(applyTerminalControl("c", false), {
    data: "c",
    consumed: false,
  });
  assert.deepEqual(applyTerminalControl("pasted text", true), {
    data: "pasted text",
    consumed: false,
  });
  assert.deepEqual(applyTerminalControl("\x1b[A", true), {
    data: "\x1b[A",
    consumed: false,
  });
});
