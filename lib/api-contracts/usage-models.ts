import { Type, type Static } from "@sinclair/typebox";

const S = Type.String();
const N = Type.Number();
const obj = Type.Object;
const range = Type.Union([
  Type.Literal("today"),
  Type.Literal("7d"),
  Type.Literal("30d"),
  Type.Literal("90d"),
  Type.Literal("month"),
  Type.Literal("all"),
]);
const granularity = Type.Union([
  Type.Literal("daily"),
  Type.Literal("monthly"),
  Type.Literal("projects"),
]);

export const UsageQuerySchema = obj(
  {
    range: Type.Optional(range),
    granularity: Type.Optional(granularity),
    project: Type.Optional(S),
    from: Type.Optional(Type.Integer()),
    to: Type.Optional(Type.Integer()),
    forceRefresh: Type.Optional(Type.Boolean()),
  },
  {
    description:
      "Filters for one daemon's transcript usage report. From and to are Unix epoch milliseconds.",
  },
);

export const UsageReportSchema = obj(
  {
    timeRange: range,
    granularity,
    summary: obj({
      totalCost: N,
      totalTokens: N,
      inputTokens: N,
      outputTokens: N,
      reasoningTokens: N,
      cacheReadTokens: N,
      cacheWriteTokens: N,
      cacheSavings: N,
      activeDays: N,
      tokensPerActiveDay: N,
      cachePercentage: N,
      costQuality: obj({ providerReported: N, modelPriced: N, unpriced: N }),
    }),
    providers: Type.Array(
      obj({ provider: S, name: S, cost: N, tokens: N, share: N, color: S }),
    ),
    timeSeries: Type.Array(
      obj({
        date: S,
        label: S,
        timestamp: N,
        totalCost: N,
        totalTokens: N,
        byProvider: Type.Record(S, obj({ cost: N, tokens: N })),
      }),
    ),
    modelBreakdown: Type.Array(
      obj({
        model: S,
        provider: S,
        cost: N,
        tokens: N,
        inputTokens: N,
        outputTokens: N,
        cacheReadTokens: N,
        cacheWriteTokens: N,
        reasoningTokens: N,
        share: N,
        recordsCount: N,
      }),
    ),
    dayBreakdown: Type.Array(
      obj({
        date: S,
        label: S,
        cost: N,
        tokens: N,
        inputTokens: N,
        outputTokens: N,
        cacheReadTokens: N,
        share: N,
      }),
    ),
    projectBreakdown: Type.Array(
      obj({
        project: S,
        projectName: S,
        cost: N,
        tokens: N,
        share: N,
        sessionsCount: N,
      }),
    ),
    scanInfo: obj({
      transcriptsScanned: N,
      transcriptsOutsideWindow: N,
      usageRecordsCount: N,
      durationSeconds: N,
      scannedAt: N,
    }),
  },
  {
    description:
      "Transcript-derived token and estimated cost totals and breakdowns from one daemon, not a provider invoice.",
  },
);

export type UsageQueryOptions = Static<typeof UsageQuerySchema>;
export type UsageReport = Static<typeof UsageReportSchema>;
