import {
  closeHostLink,
  hostsSnapshot,
  listHosts,
  notifyHostsChange,
} from "@/lib/hosts/hub";
import {
  createHost,
  HostRegistryUnreadableError,
  revokeHost,
  UnknownHostError,
  updateHost,
} from "@/lib/hosts/registry";
import { isRecord } from "@/lib/type-guards";

const MAX_LABEL_LENGTH = 100;
const noStore = { "cache-control": "no-store" };

const fail = (error: string, status: number) =>
  Response.json({ error }, { status, headers: noStore });

function hasOnlyKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) && Object.keys(value).every((key) => keys.includes(key))
  );
}

function failFor(error: unknown) {
  if (error instanceof HostRegistryUnreadableError) {
    return fail(
      "The linked-hosts registry (keylime/hosts.json) cannot be read; fix or remove it before changing hosts",
      503,
    );
  }
  if (error instanceof UnknownHostError) return fail("Unknown host", 404);
  throw error;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** `undefined` when absent, `null` when invalid. */
function parseLabel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && label.length <= MAX_LABEL_LENGTH ? label : null;
}

/** Where a daemon should dial: the origin the browser used, through a reverse proxy if there is one. */
function requestOrigin(req: Request): string {
  const first = (name: string) =>
    req.headers.get(name)?.split(",")[0]?.trim() || null;
  const own = new URL(req.url);
  const proto = first("x-forwarded-proto") ?? own.protocol.slice(0, -1);
  const host = first("x-forwarded-host") ?? req.headers.get("host") ?? own.host;
  try {
    const url = new URL(`${proto}://${host}`);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : own.origin;
  } catch {
    return own.origin;
  }
}

/**
 * @apiContract getHosts
 * @apiUsage Load the linked-host snapshot for host management.
 * @apiInputs No request parameters.
 * @apiInvariants Responses are not cached and do not contain enrollment tokens.
 * @apiEffects Reads the host snapshot. Each linked host's connectionId changes on every accepted hello, including an online replacement, and is null before its first hello.
 * @apiRecovery Refresh the snapshot if host status changes.
 */
export function GET() {
  const { hosts } = hostsSnapshot();
  return Response.json({ hosts }, { headers: noStore });
}

/**
 * @apiContract postHosts
 * @apiUsage Create a linked host and obtain its one-time enrollment token.
 * @apiInputs JSON label, trimmed and non-empty, at most 100 characters.
 * @apiInvariants The token is returned at creation, not in subsequent host snapshots; the login command uses the request's externally visible origin.
 * @apiEffects Persists the host and notifies listeners.
 * @apiRecovery Correct an invalid label or repair the host registry before retrying.
 */
export async function POST(req: Request) {
  const body = await readBody(req);
  const label = parseLabel(body?.label);
  if (!label)
    return fail(
      `label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`,
      400,
    );
  try {
    const { host, token } = createHost(label);
    notifyHostsChange();
    return Response.json(
      {
        host: listHosts().find((h) => h.id === host.id),
        token,
        command: `keylime host login --url ${requestOrigin(req)}`,
      },
      { headers: noStore },
    );
  } catch (error) {
    return failFor(error);
  }
}

/**
 * @apiContract patchHosts
 * @apiUsage Rename one host.
 * @apiInputs JSON host id and label.
 * @apiInvariants An empty local label resets its name.
 * @apiEffects Persists the name and notifies listeners.
 * @apiRecovery Correct invalid input, use an existing host, or repair unavailable registry storage.
 */
export async function PATCH(req: Request) {
  const body = await readBody(req);
  if (!body || typeof body.id !== "string" || !body.id)
    return fail("id is required", 400);
  const isLocal = body.id === "local";
  if (!hasOnlyKeys(body, ["id", "label"]))
    return fail("Only label can be updated", 400);
  // An empty name resets this machine to its default name.
  const label =
    isLocal && typeof body.label === "string" && !body.label.trim()
      ? ""
      : parseLabel(body.label);
  if (label === null || label === undefined)
    return fail(
      `label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`,
      400,
    );
  try {
    updateHost(body.id, { label });
    notifyHostsChange();
    return Response.json(
      { host: hostsSnapshot().hosts.find((h) => h.id === body.id) },
      { headers: noStore },
    );
  } catch (error) {
    return failFor(error);
  }
}

/**
 * @apiContract deleteHosts
 * @apiUsage Revoke a linked host by id.
 * @apiInputs The id query parameter identifies the remote host; local cannot be revoked.
 * @apiInvariants The registry record is removed before the live link is closed.
 * @apiEffects Removes the record, closes its link and notifies listeners; future daemon reconnects are unauthorized.
 * @apiRecovery Supply a known remote id or repair registry storage before retrying.
 */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id is required", 400);
  if (id === "local") return fail("This machine cannot be revoked", 400);
  try {
    // Registry first: with the record gone a daemon that redials gets 401 instead of reconnecting.
    if (!revokeHost(id)) return fail("Unknown host", 404);
    closeHostLink(id);
    notifyHostsChange();
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return failFor(error);
  }
}
