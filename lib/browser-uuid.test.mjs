import assert from "node:assert/strict";
import test from "node:test";
import { browserUUID } from "./browser-uuid";

test("HTTP fallback produces cryptographically random UUID v4 identifiers", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let calls = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues(bytes) {
        bytes.set(Array.from({ length: 16 }, (_, index) => index + calls++));
        return bytes;
      },
    },
  });
  try {
    const first = browserUUID();
    const second = browserUUID();
    assert.match(
      first,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(first, "00020406-080a-4c0e-9012-1416181a1c1e");
    assert.notEqual(first, second);
    assert.equal(calls, 32);
  } finally {
    Object.defineProperty(globalThis, "crypto", original);
  }
});
