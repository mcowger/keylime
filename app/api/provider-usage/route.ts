import { getProviderUsage } from "@/lib/provider-usage";

const IDENTIFIER_RE = /^[A-Za-z0-9._:/-]{1,200}$/;

function readIdentifier(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return IDENTIFIER_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * @apiContract getProviderUsage
 * @apiUsage Read provider usage for an optional provider and model context.
 * @apiInputs Identifiers are trimmed, 1–200 characters from letters, digits, dot, underscore, colon, slash and hyphen; refresh=true requests refresh.
 * @apiInvariants Invalid supplied identifiers return 400; omitted identifiers are not filters.
 * @apiEffects May query upstream usage and use cached usage data; no provider configuration is changed.
 * @apiRecovery Retry a 502 when usage becomes available, optionally requesting refresh.
 */
export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const rawProvider = searchParams.get("provider");
  const rawModel = searchParams.get("model");
  const provider = readIdentifier(rawProvider);
  const modelId = readIdentifier(rawModel);

  if ((rawProvider !== null && !provider) || (rawModel !== null && !modelId)) {
    return Response.json(
      {
        error: "Invalid provider or model identifier",
        code: "invalid_usage_query",
      },
      { status: 400 },
    );
  }

  try {
    return Response.json(
      await getProviderUsage(
        { provider, modelId },
        searchParams.get("refresh") === "true",
      ),
    );
  } catch {
    return Response.json(
      {
        error: "Provider usage is currently unavailable",
        code: "provider_usage_unavailable",
      },
      { status: 502 },
    );
  }
}
