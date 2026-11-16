import type { TestContext } from "node:test";

/** Capture only this test's expected diagnostics; unrelated output stays visible. */
export function captureExpectedConsole(
  t: TestContext,
  method: "error" | "warn" | "info" | "log",
  expected: (...args: unknown[]) => boolean,
): unknown[][] {
  const original = console[method];
  const captured: unknown[][] = [];
  t.mock.method(console, method, (...args: unknown[]) => {
    if (expected(...args)) captured.push(args);
    else original.apply(console, args);
  });
  return captured;
}
