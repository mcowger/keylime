import {
  handleLinkUpgrade,
  handleOutdatedLinkPost,
  type LinkSocketData,
} from "@/lib/hosts/hub";

// The `ompweb host` daemon's link (lib/hosts/hub.ts). proxy.ts does not run
// for this path: the hub checks the host's bearer token before it upgrades.

// GET /api/hosts/link — the link's WebSocket; undefined once upgraded (server/app.ts).
/**
 * @apiContract hostLinkUpgrade
 * @apiUsage Connect a host daemon's WebSocket to the server hub.
 * @apiInputs Supply the host bearer token and WebSocket upgrade request.
 * @apiInvariants The hub authenticates before upgrading; the ordinary proxy gate does not handle this path.
 * @apiEffects A successful upgrade hands the socket to the hub rather than returning a normal HTTP response.
 * @apiRecovery Reconnect after a dropped link; an upgrade refusal requires correcting authentication or availability.
 */
export function GET(
  req: Request,
  { upgrade }: { upgrade: (data: LinkSocketData) => boolean },
) {
  return handleLinkUpgrade(req, upgrade);
}

// POST /api/hosts/link — only refuses a daemon from before the WebSocket (its hello POST) with 426.
/**
 * @apiContract hostLinkLegacyHello
 * @apiUsage Detect a daemon using the obsolete HTTP hello protocol.
 * @apiInputs The legacy hello POST is not used to establish a link.
 * @apiInvariants This endpoint refuses legacy clients rather than negotiating a session.
 * @apiEffects Returns an upgrade-required response; no WebSocket is established.
 * @apiRecovery Update the daemon and connect using the WebSocket link.
 */
export function POST(req: Request) {
  return handleOutdatedLinkPost(req);
}
