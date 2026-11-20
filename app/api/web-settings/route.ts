import { broadcastBrowserTransport } from "@/lib/event-stream-hub";
import { apiErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import {
  browserTransportState,
  loadBrowserSettings,
  parseHostSettingsPatch,
  saveBrowserSettings,
} from "@/lib/web-settings";
import { isRecord } from "@/lib/type-guards";

/**
 * @apiContract getWebSettings
 * @apiUsage Read one daemon's policy or the web server's browser transport.
 * @apiInputs Omit scope for host policy and supply hostId to select a daemon (default: local). Use scope=browser without hostId for browser transport.
 * @apiInvariants Host policy never contains environment variables and never falls back to another host's policy.
 * @apiEffects Reads the selected owner's settings without mutation.
 * @apiRecovery Reconnect the selected daemon and retry if unavailable.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.has("scope")) {
    if (params.get("scope") !== "browser" || params.has("hostId")) {
      return Response.json(
        { error: "Invalid settings scope" },
        { status: 400 },
      );
    }
    return Response.json(loadBrowserSettings());
  }
  const target = resolveHostOrError(params.get("hostId") ?? undefined);
  if ("response" in target) return target.response;
  try {
    return Response.json(await target.host.getSettings());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * @apiContract putWebSettings
 * @apiUsage Patch one daemon's policy or set the web server's browser transport.
 * @apiInputs Select the owner as for GET. Retention is in whole days (1–3650) or null to retain indefinitely. Browser scope accepts only browserTransport.
 * @apiInvariants Omitted host fields are preserved; unknown fields are rejected, including agentEnv.
 * @apiEffects Writes only to the selected owner. Changed browser transport is announced to this server's browsers; host policy is not broadcast.
 * @apiRecovery Read the same scope and host after an uncertain response before retrying.
 */
export async function PUT(req: Request) {
  const params = new URL(req.url).searchParams;
  const body: unknown = await req.json().catch(() => null);
  if (params.has("scope")) {
    if (params.get("scope") !== "browser" || params.has("hostId")) {
      return Response.json(
        { error: "Invalid settings scope" },
        { status: 400 },
      );
    }
    if (
      !isRecord(body) ||
      Object.keys(body).length !== 1 ||
      (body.browserTransport !== "ws" && body.browserTransport !== "sse")
    ) {
      return Response.json(
        { error: "Expected browserTransport to be ws or sse" },
        { status: 400 },
      );
    }
    const previous = loadBrowserSettings();
    let settings;
    try {
      settings = saveBrowserSettings({
        browserTransport: body.browserTransport,
      });
    } catch {
      return Response.json(
        { error: "Could not save browser settings" },
        { status: 500 },
      );
    }
    if (previous.browserTransport !== settings.browserTransport)
      broadcastBrowserTransport(browserTransportState(settings));
    return Response.json(settings);
  }
  const patch = parseHostSettingsPatch(body);
  if (!patch)
    return Response.json(
      { error: "Invalid host settings patch" },
      { status: 400 },
    );
  const target = resolveHostOrError(params.get("hostId") ?? undefined);
  if ("response" in target) return target.response;
  try {
    return Response.json(await target.host.setSettings(patch));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
