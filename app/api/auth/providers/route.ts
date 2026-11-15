import {
  type OmpLoginProvider,
  runUtilityCommand,
} from "@/lib/omp/rpc-utility";

// Login-capable providers via the omp RPC get_login_providers command. This is
// omp's own /login list (OAuth subscriptions plus key-creation flows), so no
// hardcoded exclusions or display-name overrides are needed anymore.
/**
 * @apiContract getAuthProviders
 * @apiUsage List available omp login providers and authentication status.
 * @apiInputs No request parameters are used.
 * @apiInvariants Unavailable providers are omitted; this is not a list of all known providers.
 * @apiEffects Queries the utility process without changing credentials.
 * @apiRecovery Retry the read after a utility error.
 */
export async function GET() {
  try {
    const response = await runUtilityCommand<{ providers?: unknown }>(
      { type: "get_login_providers" },
      30_000,
    );
    const providers = Array.isArray(response.providers)
      ? response.providers.filter(
          (provider): provider is OmpLoginProvider =>
            typeof provider === "object" &&
            provider !== null &&
            typeof (provider as OmpLoginProvider).id === "string" &&
            typeof (provider as OmpLoginProvider).name === "string" &&
            typeof (provider as OmpLoginProvider).authenticated === "boolean",
        )
      : [];
    const result = providers
      .filter((p) => p.available !== false)
      .map((p) => ({
        id: p.id,
        name: p.name,
        usesCallbackServer: false,
        loggedIn: p.authenticated,
      }));
    return Response.json({ providers: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ providers: [], error: message }, { status: 500 });
  }
}
