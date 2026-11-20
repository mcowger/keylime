import type { UsageReport } from "./api-contracts/usage-models";

export type UsageTimeRange = UsageReport["timeRange"];
export type UsageGranularity = UsageReport["granularity"];
export type UsageMetricView = "cost" | "tokens";
export type UsageBreakdownView = "model" | "day" | "project";
export type CostQualityTier = "provider_reported" | "model_priced" | "unpriced";

export interface ModelRates {
  input: number; // USD per million tokens
  output: number; // USD per million tokens
  cacheRead: number; // USD per million tokens
  cacheWrite: number; // USD per million tokens
}

export interface UsageRecord {
  timestamp: number;
  sessionId: string;
  sessionCwd: string;
  provider: string;
  model: string;
  input: number; // uncached input tokens
  output: number; // output tokens
  reasoning: number; // reasoning / thought tokens
  cacheRead: number; // prompt cache read tokens
  cacheWrite: number; // prompt cache write tokens
  totalTokens: number;
  cost: number; // USD
  cacheSavings: number; // USD
  costQuality: CostQualityTier;
  /**
   * Id of the transcript entry the usage came from (for a `task` result
   * summary: the task entry id + `#` + the subagent id). omp copies entries
   * with their ids and timestamps (`/tan`, `/fork`, branches), so the same id
   * + timestamp in several files is one billed request.
   */
  entryId?: string;
  /**
   * For a `task` result summary: the subagent transcript it duplicates
   * (`<artifacts dir>/<id>.jsonl`). The summary only counts while neither it
   * nor a copy of it has that transcript with usage from before the summary,
   * since the transcript is counted in full.
   */
  subagentFile?: string;
  /**
   * Start of the session that owns the transcript (its header timestamp).
   * Among copies of one request, the earliest-started session's row counts.
   */
  sessionStarted: number;
}

export type UsageSummary = UsageReport["summary"];
export type ProviderUsageSummary = UsageReport["providers"][number];
export type ModelUsageSummary = UsageReport["modelBreakdown"][number];
export type TimeSeriesPoint = UsageReport["timeSeries"][number];
export type DayUsageSummary = UsageReport["dayBreakdown"][number];
export type ProjectUsageSummary = UsageReport["projectBreakdown"][number];
