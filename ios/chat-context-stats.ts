import { formatCompactNumber } from "../lib/format";
import { formatCost } from "../lib/subagent-format";
import type { operations } from "./generated/web-http";

export type SessionContextStatistics =
  operations["getSessionContextStats"]["responses"][200]["content"]["application/json"];
export type ContextStats = NonNullable<SessionContextStatistics["stats"]>;

export function formatCacheHitRate(rate: number): string {
  let decimals = 2;
  let value = rate.toFixed(decimals);
  while (
    decimals < 15 &&
    ((rate > 0 && Number(value) === 0) || (rate < 100 && Number(value) === 100))
  ) {
    value = rate.toFixed(++decimals);
  }
  return `${value}%`;
}

export function formatContextMetrics(
  window: number | undefined,
  maxTokens: number | undefined,
  current: number | null,
  average: number | null,
) {
  return [
    window ? `${formatCompactNumber(window)} window` : null,
    maxTokens ? `max out ${formatCompactNumber(maxTokens)}` : null,
    current != null && average != null
      ? `${current.toFixed(1)} t/s · avg ${average.toFixed(1)}`
      : current != null || average != null
        ? `${(current ?? average)!.toFixed(1)} t/s`
        : null,
  ]
    .filter(Boolean)
    .join("  ");
}

export function formatSessionCosts(
  costs: NonNullable<
    operations["listSessionSubagents"]["responses"][200]["content"]["application/json"]["costs"]
  >,
) {
  return {
    agent: formatCost(costs.agent) ?? "$0.00",
    subagents: formatCost(costs.subagents) ?? "$0.00",
    total: formatCost(costs.agent + costs.subagents) ?? "$0.00",
  };
}
