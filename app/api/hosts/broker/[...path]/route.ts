import {
  readBodyWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import { sharesCredentials } from "@/lib/hosts/cluster";
import { loadPools } from "@/lib/hosts/pools";
import { hostFromBearer } from "@/lib/hosts/host-bearer";
import { LOCAL_HOST_ID, type HostRecord } from "@/lib/hosts/registry";
import { AuthBrokerUnavailableError, brokerFetch } from "@/lib/omp/auth-broker";

// A linked host's daemon forwards omp's auth-broker calls here (lib/omp/auth-broker.ts runs the broker). proxy.ts does
// not gate the /v1/ paths: the host's bearer token is checked before anything else is read.

const MAX_BODY_BYTES = 1024 * 1024;
const noStore = { "cache-control": "no-store" };
const fail = (error: string, status: number) =>
  Response.json({ error }, { status, headers: noStore });

// Anything not listed is 404, including POST /v1/credential: a host cannot add or replace a credential.
const ALLOWED: readonly (readonly [method: string, path: RegExp])[] = [
  [
    "GET",
    /^\/v1\/(?:healthz|snapshot|snapshot\/stream|credentials\/disabled|usage|usage\/history|usage\/clients)$/,
  ],
  ["POST", /^\/v1\/credential\/\d+\/(?:refresh|disable|block)$/],
  ["DELETE", /^\/v1\/credential\/\d+\/blocks?$/],
  ["POST", /^\/v1\/usage\/(?:observed|stale)$/],
];
const REQUEST_HEADERS = [
  "content-type",
  "accept",
  "if-none-match",
  "omp-auth-broker-capabilities",
];
const RESPONSE_HEADERS = ["content-type", "etag", "cache-control", "vary"];
// A path the allow-list has not vetted reaches the log only as plain `/v1/` text.
const PLAIN_PATH = /^\/v1\/[A-Za-z0-9/_-]*$/;

/** Never a token, a query, a body or an error message: a broker failure names only its class. */
function log(
  hostId: string,
  method: string,
  path: string,
  status: number,
  reason?: string,
) {
  console.log(
    `[keylime] broker ${hostId} ${method} ${path} ${status}${reason ? ` ${reason}` : ""}`,
  );
}

function only(source: Headers, names: readonly string[]): Headers {
  const picked = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) picked.set(name, value);
  }
  return picked;
}

/** The sharing host (own flag or cluster member) the bearer token names, or the refusal to answer with (a 403 and a pool 503 are logged; a 401 has no host to name). */
function admit(request: Request, path: string): HostRecord | Response {
  const host = hostFromBearer(request);
  if (host instanceof Response) return host;
  // `local` is refused by id: a hand-edited hosts.json can give its record the flag.
  let shares: boolean;
  try {
    shares = host.id !== LOCAL_HOST_ID && sharesCredentials(host, loadPools());
  } catch {
    log(
      host.id,
      request.method,
      PLAIN_PATH.test(path) ? path : "-",
      503,
      "pools_unreadable",
    );
    return fail("The host pool configuration cannot be read", 503);
  }
  if (!shares) {
    log(host.id, request.method, PLAIN_PATH.test(path) ? path : "-", 403);
    return fail("Credential sharing is off for this host", 403);
  }
  return host;
}

async function forward(
  request: Request,
  {
    params,
    disableIdleTimeout,
  }: { params: Promise<{ path: string[] }>; disableIdleTimeout: () => void },
) {
  const path = `/${(await params).path.join("/")}`;
  const first = admit(request, path);
  if (first instanceof Response) return first;
  if (
    !ALLOWED.some(
      ([method, allowed]) => method === request.method && allowed.test(path),
    )
  ) {
    log(first.id, request.method, PLAIN_PATH.test(path) ? path : "-", 404);
    return fail("Not found", 404);
  }

  // Public to proxy.ts, so Bun's idle timeout is still on: the snapshot stream and the long poll stay open without traffic.
  disableIdleTimeout();
  let body: ArrayBuffer | undefined;
  if (request.method !== "GET") {
    try {
      body = (await readBodyWithinLimit(request, MAX_BODY_BYTES)).buffer;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError)
        return fail("Request body is too large", 413);
      throw error;
    }
  }

  // The body can take as long as the sender likes, and no request of this host is abortable (abortBrokerRequests) until
  // brokerFetch registers it: a host revoked or switched off meanwhile must not get through. No await from here to that call.
  const host = admit(request, path);
  if (host instanceof Response) return host;

  let upstream: Response;
  try {
    upstream = await brokerFetch(host.id, path + new URL(request.url).search, {
      method: request.method,
      headers: only(request.headers, REQUEST_HEADERS),
      body,
      signal: request.signal,
    });
  } catch (error) {
    const unavailable = error instanceof AuthBrokerUnavailableError;
    const reason = unavailable
      ? (error.reason ?? "fetch_failed")
      : // The host disconnected, or abortBrokerRequests cut it off.
        request.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ? "aborted"
        : "fetch_failed";
    log(host.id, request.method, path, unavailable ? 503 : 502, reason);
    return unavailable
      ? fail("The auth broker is unavailable", 503)
      : fail("The auth broker request failed", 502);
  }
  log(host.id, request.method, path, upstream.status);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: only(upstream.headers, RESPONSE_HEADERS),
  });
}

/**
 * @apiContract hostBrokerHealth
 * @apiContract hostBrokerSnapshot
 * @apiContract hostBrokerSnapshotStream
 * @apiContract hostBrokerDisabledCredentials
 * @apiContract hostBrokerUsage
 * @apiContract hostBrokerUsageHistory
 * @apiContract hostBrokerUsageClients
 * @apiUsage Read an allowed auth-broker resource through the host credential-sharing proxy.
 * @apiInputs Supply a host bearer token, allowed path and optional query; only selected request headers pass through.
 * @apiInvariants The non-local host must remain admitted for credential sharing; paths outside the allow-list are refused and payloads remain broker-defined.
 * @apiEffects Forwards the request and streams the upstream status and body with selected response headers.
 * @apiRecovery Re-establish sharing or service availability after refusal; revocation can abort an in-flight request.
 */
export const GET = forward;
/**
 * @apiContract hostBrokerRefreshCredential
 * @apiContract hostBrokerDisableCredential
 * @apiContract hostBrokerBlockCredential
 * @apiContract hostBrokerObservedUsage
 * @apiContract hostBrokerStaleUsage
 * @apiUsage Send an allowed auth-broker mutation through the credential-sharing proxy.
 * @apiInputs Supply host bearer authentication, an allowed path and a body no larger than 1 MiB; queries and selected headers are forwarded.
 * @apiInvariants Admission is checked before forwarding and after reading the body; broker payload semantics are opaque to this proxy.
 * @apiEffects The upstream receives the request; its status and body are passed through, potentially as a stream.
 * @apiRecovery A revoked host or aborted request may leave upstream outcome uncertain; consult broker state before repeating a mutation.
 */
export const POST = forward;
/**
 * @apiContract hostBrokerDeleteCredentialBlock
 * @apiContract hostBrokerDeleteCredentialBlocks
 * @apiUsage Delete an allowed auth-broker credential block through the sharing proxy.
 * @apiInputs Supply host bearer authentication and an allowed path; query and selected headers pass through, and a body is limited to 1 MiB.
 * @apiInvariants Admission is repeated after reading the body; disallowed paths are refused and payload semantics belong to the broker.
 * @apiEffects Forwards the deletion and passes through upstream status and body; revocation can abort in-flight work.
 * @apiRecovery After an uncertain response, consult broker state before repeating the deletion.
 */
export const DELETE = forward;
