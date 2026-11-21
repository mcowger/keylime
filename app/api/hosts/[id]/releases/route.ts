import { Value } from "@sinclair/typebox/value";
import {
  DeployHostReleaseArgsSchema,
  type HostReleaseDeployFrame,
} from "@/lib/api-contracts/host-control-models";
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
 * @apiEffects Returns opaque build IDs, UTC build times, and whether each build matches the host's installed binaries, newest first. An older daemon without digest reporting yields unverified; other comparison failures yield unknown. Does not transfer or install anything.
 * @apiRecovery An empty list means no complete compatible build was found. An unverified build may be deployed with operator confirmation. An unknown comparison blocks deployment; check the host link and binary access.
 */
export async function GET(req: Request, { params }: Context) {
  try {
    return Response.json(
      await listHostReleases((await params).id, req.signal),
      { headers },
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

/**
 * @apiContract deployHostRelease
 * @apiUsage Deploy the selected build to a linked standalone host and stream progress as NDJSON.
 * @apiInputs Supply the selected release ID and a new operation ID.
 * @apiInvariants Both binaries come from the same server build. Caller paths, binary names and digests are not accepted. The installed binaries must differ from the selected build when the daemon reports digests; a daemon without digest reporting allows an unverified deployment. Other digest failures block it. Incompatible installs are refused and a missing runner is added without overwriting an existing file.
 * @apiEffects Streams cumulative host-acknowledged bytes across both binaries, then requests installation after both are staged. Installation force-drains and restarts a busy host, interrupting active sessions, terminals and host operations; pending results can be lost. Acceptance does not confirm the restart.
 * @apiRecovery A pending result or lost reply requires GET /api/hosts/{id}/artifacts with the original operation ID. Disconnect cancels remaining transfer, but can race activation. Do not blindly send another deployment.
 */
export async function POST(
  req: Request,
  { params, disableIdleTimeout }: Context & { disableIdleTimeout: () => void },
) {
  try {
    const body = await parseJsonWithinLimit<unknown>(req, 1024);
    if (!Value.Check(DeployHostReleaseArgsSchema, body))
      throw new UploadError(
        400,
        "invalid_request",
        "Select a release from the list",
      );
    const { id } = await params;
    const owner = requestOwner(req);
    const cancellation = new AbortController();
    const signal = AbortSignal.any([req.signal, cancellation.signal]);
    const encoder = new TextEncoder();
    disableIdleTimeout();
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = (frame: HostReleaseDeployFrame) => {
            if (!signal.aborted)
              controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          };

          try {
            const result = await deployHostRelease(
              id,
              owner,
              body,
              signal,
              (frame) => {
                // Don't queue up byte updates for a slow reader. Phase changes and the result always go through.
                if (
                  frame.type !== "transfer" ||
                  (controller.desiredSize ?? 0) > 0
                )
                  emit(frame);
              },
            );
            emit({ type: "result", result });
          } catch (error) {
            if (!signal.aborted) {
              const response = uploadErrorResponse(error);
              const { code, error: message } = await response.json();
              emit({
                type: "error",
                status: response.status,
                code,
                error: message,
              });
            }
          } finally {
            if (!cancellation.signal.aborted) controller.close();
          }
        },
        cancel() {
          cancellation.abort();
        },
      }),
      {
        headers: {
          ...headers,
          "content-type": "application/x-ndjson; charset=utf-8",
          "x-accel-buffering": "no",
        },
      },
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
