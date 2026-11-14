import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./paths.ts");
}

test("preserves literal backslashes in session identity", async () => {
  const { sessionPathKey } = await loadSubject();
  assert.notEqual(sessionPathKey("/sessions/a\\b.jsonl"), sessionPathKey("/sessions/a/b.jsonl"));
});

test("preserves case when session paths are case-sensitive", async () => {
  const { sessionPathKey } = await loadSubject();

  assert.notEqual(
    sessionPathKey("/var/lib/pi/Parent.jsonl"),
    sessionPathKey("/var/lib/pi/parent.jsonl"),
  );
});
