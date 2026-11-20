import { Value } from "@sinclair/typebox/value";
import { DeployHostReleaseArgsSchema, type HostReleaseDeployFrame } from "@/lib/api-contracts/host-control-models";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { deployHostRelease, listHostReleases } from "@/lib/hosts/host-releases";
import { UploadError, uploadErrorResponse } from "@/lib/uploads";
import { requestOwner } from "@/lib/web-auth";

type Context = { params: Promise<{ id: string }> };
const headers = { "cache-control": "no-store" };

/**
 * @apiContract listHostReleases
 * @apiUsage List builds available to deploy to the selected standalone host.
 * @apiInputs Select the linked host in the URL.
 * @apiInvariants Only complete daemon and runner pairs matching the host OS and CPU are listed. The server reads its own builds, not paths supplied by the client.
 * @apiEffects Returns opaque build IDs and UTC build times, newest first. Does not transfer or install anything.
 * @apiRecovery An empty list means no complete compatible build was found. Build a release on the server and open the list again.
 */
export async function GET(_req: Request, { params }: Context) {
  try {
    return Response.json(await listHostReleases((await params).id), { headers });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

/**
 * @apiContract deployHostRelease
 * @apiUsage Deploy the selected build to a linked standalone host and stream progress as NDJSON.
 * @apiInputs Supply the selected release ID and a new operation ID.
 * @apiInvariants Both binaries come from the same server build. Caller paths, binary names and digests are not accepted. The host refuses busy or incompatible installs.
 * @apiEffects Streams cumulative host-acknowledged bytes across both binaries, then reports installation after both are staged. Acceptance does not confirm the restart.
 * @apiRecovery A pending result or lost reply requires GET /api/hosts/{id}/artifacts with the original operation ID. Disconnect cancels remaining transfer, but can race activation. Do not blindly send another deployment.
 */
export async function POST(req: Request, { params, disableIdleTimeout }: Context & { disableIdleTimeout: () => void }) {
  try {
    const body = await parseJsonWithinLimit<unknown>(req, 1024);
    if (!Value.Check(DeployHostReleaseArgsSchema, body))
      throw new UploadError(400, "invalid_request", "Select a release from the list");
    const { id } = await params;
    const owner = requestOwner(req);
    const cancellation = new AbortController();
    const signal = AbortSignal.any([req.signal, cancellation.signal]);
    const encoder = new TextEncoder();
    disableIdleTimeout();
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (frame: HostReleaseDeployFrame) => {
          if (!signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        };
        emit({ type: "transfer" });
        try {
          const result = await deployHostRelease(id, owner, body, signal, (frame) => {
            // Don't queue up byte updates for a slow reader. Phase changes and the result always go through.
            if (frame.type !== "transfer" || (controller.desiredSize ?? 0) > 0) emit(frame);
          });
          emit({ type: "result", result });
        } catch (error) {
          if (!signal.aborted) {
            const response = uploadErrorResponse(error);
            const { code, error: message } = await response.json();
            emit({ type: "error", status: response.status, code, error: message });
          }
        } finally {
          if (!cancellation.signal.aborted) controller.close();
        }
      },
      cancel() { cancellation.abort(); },
    }), {
      headers: { ...headers, "content-type": "application/x-ndjson; charset=utf-8", "x-accel-buffering": "no" },
    });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
