import {
  handleBrowserLinkUpgrade,
  type BrowserLinkData,
} from "@/lib/browser-link";

// GET /api/events/link — the browser link (lib/browser-link.ts); undefined once upgraded (server/app.ts). Gated like
// every API route: the password gate and origin check run before the upgrade, which binds the socket to its web session.
/**
 * @apiContract getEventsLink
 * @apiUsage Upgrade the browser shared worker to one WebSocket multiplexing subscriptions and agent commands.
 * @apiInputs A WebSocket upgrade request passes the API password and origin gates; the server binds it to the requesting web session.
 * @apiInvariants Resume tokens and uploads are scoped to that session; session subscriptions observe rather than spawn processes, while explicit commands can start them.
 * @apiEffects Successful upgrade hands ownership to the browser link; detached links retain subscriptions for a 120-second resume window before disposal.
 * @apiRecovery Refused upgrades return 426 upgrade_required; reconnect within the resume window or resync and resubscribe, with the worker able to fall back to SSE.
 */
export function GET(
  req: Request,
  { upgrade }: { upgrade: (data: BrowserLinkData) => boolean },
) {
  return handleBrowserLinkUpgrade(req, upgrade);
}
