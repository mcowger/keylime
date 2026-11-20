import { apiErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import type { UsageGranularity, UsageTimeRange } from "@/lib/usage-types";

/**
 * @apiContract getUsage
 * @apiUsage Obtain a usage report derived from the selected daemon's session transcripts and persistent usage database, not an authoritative provider bill.
 * @apiInputs Optional hostId selects the daemon; omission selects the local daemon. range accepts today, 7d, 30d, 90d, month or all (default 30d); granularity accepts daily, monthly or projects (default daily). Optional project filters the report. from and to are integer Unix epoch milliseconds and override range only when both parse as numbers; refresh=true or 1 invalidates caches. Invalid range or granularity falls back to its default.
 * @apiInvariants Never falls back to another host. Pricing uses available usage and model rates and can be incomplete or estimated.
 * @apiEffects Refresh invalidates usage and session-file-list caches on the selected daemon; report generation can synchronize its SQLite database.
 * @apiRecovery Upgrade the selected daemon on 501 host_upgrade_required; reconnect it on 503 or check its identity on 404. Use refresh when underlying files changed but cached data appears stale.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const target = resolveHostOrError(
      url.searchParams.get("hostId") ?? undefined,
    );
    if ("response" in target) return target.response;
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

    const report = await target.host.getUsageReport({
      range,
      granularity,
      project: projectParam || undefined,
      from: Number.isFinite(from) ? from : undefined,
      to: Number.isFinite(to) ? to : undefined,
      forceRefresh,
    });

    return Response.json(report);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
