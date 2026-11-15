import { apiErrorResponse } from "@/lib/api-utils";
import { getUsageReport } from "@/lib/usage-service";
import type { UsageGranularity, UsageTimeRange } from "@/lib/usage-types";

/**
 * @apiContract getUsage
 * @apiUsage Obtain a usage report derived from local session transcripts and the persistent usage database, not an authoritative provider bill.
 * @apiInputs range accepts today, 7d, 30d, 90d, month or all (default 30d); granularity accepts daily, monthly or projects (default daily). Optional project filters the report. from and to are integer Unix epoch milliseconds and override range only when both parse as numbers; refresh=true or 1 invalidates caches. Invalid range or granularity falls back to its default.
 * @apiInvariants Parsed usage and file listings are cached; pricing is calculated from available usage and model rates and can be incomplete or estimated.
 * @apiEffects A refresh invalidates in-memory usage and session-file-list caches; report generation can synchronize the local SQLite database.
 * @apiRecovery Retry a failed read; use refresh when underlying files changed but cached data appears stale. Estimates should not be used to reconcile invoices without provider records.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rangeParam = url.searchParams.get("range");
    const granularityParam = url.searchParams.get("granularity");
    const projectParam = url.searchParams.get("project");
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const refreshParam = url.searchParams.get("refresh");

    const validRanges: UsageTimeRange[] = [
      "today",
      "7d",
      "30d",
      "90d",
      "month",
      "all",
    ];
    const range: UsageTimeRange = validRanges.includes(
      rangeParam as UsageTimeRange,
    )
      ? (rangeParam as UsageTimeRange)
      : "30d";

    const validGranularities: UsageGranularity[] = [
      "daily",
      "monthly",
      "projects",
    ];
    const granularity: UsageGranularity = validGranularities.includes(
      granularityParam as UsageGranularity,
    )
      ? (granularityParam as UsageGranularity)
      : "daily";

    const from = fromParam ? parseInt(fromParam, 10) : undefined;
    const to = toParam ? parseInt(toParam, 10) : undefined;
    const forceRefresh = refreshParam === "true" || refreshParam === "1";

    const report = await getUsageReport({
      range,
      granularity,
      project: projectParam || undefined,
      from: !isNaN(from as number) ? from : undefined,
      to: !isNaN(to as number) ? to : undefined,
      forceRefresh,
    });

    return Response.json(report);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
