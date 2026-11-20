import { Value } from "@sinclair/typebox/value";
import { DeployHostReleaseArgsSchema } from "@/lib/api-contracts/host-control-models";
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
 * @apiUsage Deploy the selected build to a linked standalone host over the managed link.
 * @apiInputs Supply the selected release ID and a new operation ID.
 * @apiInvariants Both binaries come from the same server build. Caller paths, binary names and digests are not accepted. The host refuses busy or incompatible installs.
 * @apiEffects Transfers and hashes both binaries, then hands them off for paired activation and one restart. Acceptance does not confirm the restart.
 * @apiRecovery Read GET /api/hosts/{id}/artifacts with the original operation ID after reconnect or a lost reply. Do not blindly send another deployment.
 */
export async function POST(req: Request, { params }: Context) {
  try {
    const body = await parseJsonWithinLimit<unknown>(req, 1024);
    if (!Value.Check(DeployHostReleaseArgsSchema, body))
      throw new UploadError(400, "invalid_request", "Select a release from the list");
    return Response.json(
      await deployHostRelease((await params).id, requestOwner(req), body, req.signal),
      { status: 202, headers },
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
