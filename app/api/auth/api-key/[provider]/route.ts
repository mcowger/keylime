import { apiErrorResponse } from "@/lib/api-utils";
import {
  type OmpLoginProvider,
  type OmpModel,
  runUtilityCommand,
} from "@/lib/omp/rpc-utility";

type Params = { params: Promise<{ provider: string }> };

// omp stores API keys in its encrypted SQLite credential store (agent.db),
// which omp-web must never write from Node, and the omp RPC login command only
// bridges browser-based flows (providers that prompt for a key before opening
// a URL are rejected by omp's RPC mode). Keys therefore cannot be stored or
// removed from the web UI.
const API_KEY_WRITE_GUIDANCE =
  "omp-web cannot manage stored API keys. Run `omp` in a terminal and use /login (or /logout), " +
  "set the provider's environment variable (e.g. OPENAI_API_KEY), or configure an apiKey on a " +
  "custom provider in ~/.omp/agent/models.yml.";

// GET /api/auth/api-key/[provider] — returns auth status (never returns the actual key)
/**
 * @apiContract getAuthApiKeyProvider
 * @apiUsage Inspect whether a provider resolves models or is authenticated.
 * @apiInputs Provider is an omp provider ID in the path.
 * @apiInvariants Configured is derived from available models or login status, not a direct key lookup; keys are never returned.
 * @apiEffects Queries utility-process model and login state without changing credentials.
 * @apiRecovery Retry the read after a utility error.
 */
export async function GET(_req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    const { models } = await runUtilityCommand<{ models: OmpModel[] }>(
      { type: "get_available_models" },
      120_000,
    );
    const { providers: loginProviders } = await runUtilityCommand<{
      providers: OmpLoginProvider[];
    }>({ type: "get_login_providers" }, 30_000);
    const loginProvider = loginProviders.find((p) => p.id === provider);
    const modelCount = models.filter((m) => m.provider === provider).length;
    return Response.json({
      provider,
      displayName: loginProvider?.name ?? provider,
      configured: modelCount > 0 || loginProvider?.authenticated === true,
      models: modelCount,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// POST /api/auth/api-key/[provider] — not supported against omp's credential store
/**
 * @apiContract postAuthApiKeyProvider
 * @apiUsage API-key storage through this endpoint is unsupported.
 * @apiInputs Provider identifies the provider; the request body is not used.
 * @apiInvariants Always returns 501 and never stores a key.
 * @apiEffects No credential mutation occurs.
 * @apiRecovery Use omp terminal login, the provider environment variable, or custom models.yml configuration.
 */
export async function POST(_req: Request, { params }: Params) {
  const { provider } = await params;
  return Response.json(
    {
      error: `Cannot store an API key for "${provider}" from omp-web. ${API_KEY_WRITE_GUIDANCE}`,
      code: "api_key_store_unsupported",
    },
    { status: 501 },
  );
}

// DELETE /api/auth/api-key/[provider] — not supported against omp's credential store
/**
 * @apiContract deleteAuthApiKeyProvider
 * @apiUsage API-key removal through this endpoint is unsupported.
 * @apiInputs Provider identifies the provider; the request body is not used.
 * @apiInvariants Always returns 501 and does not reveal a key.
 * @apiEffects No credential mutation occurs.
 * @apiRecovery Use omp terminal logout or remove the relevant external configuration.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const { provider } = await params;
  return Response.json(
    {
      error: `Cannot remove the API key for "${provider}" from omp-web. ${API_KEY_WRITE_GUIDANCE}`,
      code: "api_key_remove_unsupported",
    },
    { status: 501 },
  );
}
