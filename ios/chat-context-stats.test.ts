import { expect, test } from "bun:test";
import {
  formatCacheHitRate,
  formatContextMetrics,
  formatSessionCosts,
} from "./chat-context-stats";

test("cache hit formatting preserves tiny and nearly complete rates", () => {
  expect(formatCacheHitRate(0)).toBe("0.00%");
  expect(formatCacheHitRate(0.001)).toBe("0.001%");
  expect(formatCacheHitRate(99.999)).toBe("99.999%");
});

test("formats PWA fixture window, speed, cache, and reported costs", () => {
  expect(formatContextMetrics(66_000, 4_000, 36.5, 36.5)).toBe(
    "66k window  max out 4k  36.5 t/s · avg 36.5",
  );
  expect(formatContextMetrics(undefined, undefined, null, null)).toBe("");
  expect(formatContextMetrics(undefined, undefined, null, 3.25)).toBe(
    "3.3 t/s",
  );
  expect(formatCacheHitRate(0)).toBe("0.00%");
  expect(formatSessionCosts({ agent: 8.73, subagents: 22.11 })).toEqual({
    agent: "$8.73",
    subagents: "$22.11",
    total: "$30.84",
  });
  expect(formatSessionCosts({ agent: 0.0001, subagents: 0 })).toEqual({
    agent: "$0.0001",
    subagents: "$0.00",
    total: "$0.0001",
  });
});
