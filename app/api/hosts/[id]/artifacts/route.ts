import { Value } from "@sinclair/typebox/value";
import {
  ActivateHostArtifactArgsSchema,
  HostArtifactActivationArgsSchema,
  StageHostArtifactArgsSchema,
} from "@/lib/api-contracts/host-control-models";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { hostArtifactActivationOp } from "@/lib/hosts/hub";
import {
  stageHostArtifact,
  UploadError,
  uploadErrorResponse,
} from "@/lib/uploads";
import { requestOwner } from "@/lib/web-auth";

type Context = { params: Promise<{ id: string }> };
const noStore = { "cache-control": "no-store" };

/**
 * @apiContract stageHostArtifact
 * @apiUsage Stage a binary, runner or other file on a connected daemon for manual installation.
 * @apiInputs Select the host in the URL and pass the ID of a completed upload to that host.
 * @apiInvariants The completed upload must belong to the requesting web login, be nonempty and not be in use by a session or workspace. The caller cannot choose a destination path.
 * @apiEffects Moves the file to the daemon's private artifact staging directory and returns its path. Does not install, run or restart anything.
 * @apiRecovery If confirmation is lost, inspect keylime/host-artifacts/<upload id> under the daemon's agent directory before uploading again.
 */
export async function POST(req: Request, { params }: Context) {
  try {
    const { id: hostId } = await params;
    const body = await parseJsonWithinLimit<unknown>(req, 1024);
    if (!Value.Check(StageHostArtifactArgsSchema, body))
      throw new UploadError(
        400,
        "invalid_request",
        "Expected a completed upload ID",
      );
    return Response.json(
      await stageHostArtifact(body.id, requestOwner(req), hostId),
      { headers: noStore },
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

/**
 * @apiContract activateHostArtifact
 * @apiUsage Install a staged binary and restart its selected standalone remote daemon.
 * @apiInputs Supply the staged artifact ID, a new operation ID, the target executable and its expected SHA-256.
 * @apiInvariants The staging and activation belong to the selected host and its original server link. The daemon chooses the installed path. Reusing an admitted operation ID does not repeat the install.
 * @apiEffects Hands installation and restart to the daemon. The worker preflights the verified copy, then force-drains the host and restarts it even when busy. Active sessions, terminals and host operations can be interrupted and pending results lost. Returns acceptance or known state, not a guarantee that the restart completed.
 * @apiRecovery Read the activation status with the same operation ID after reconnect or a lost response. Do not send another install when the outcome is unknown.
 */
export async function PATCH(req: Request, { params }: Context) {
  try {
    const { id } = await params;
    const body = await parseJsonWithinLimit<unknown>(req, 1024);
    if (!Value.Check(ActivateHostArtifactArgsSchema, body))
      throw new UploadError(400, "invalid_request", "Expected a staged artifact, target and SHA-256");
    return Response.json(
      await hostArtifactActivationOp(id, "activateHostArtifact", body),
      { status: 202, headers: noStore },
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}

/**
 * @apiContract getHostArtifactActivation
 * @apiUsage Check whether a standalone host install and restart finished.
 * @apiInputs Supply the original operationId in the query on the same host.
 * @apiInvariants The receipt is read on the daemon and scoped to the same server relationship; absence doesn't establish success or failure.
 * @apiEffects Reads the outcome and backup path if available without installing or restarting.
 * @apiRecovery Retry this read on disconnect. If the outcome cannot be established, inspect the host before installing again.
 */
export async function GET(req: Request, { params }: Context) {
  try {
    const { id } = await params;
    const args = { operationId: new URL(req.url).searchParams.get("operationId") };
    if (!Value.Check(HostArtifactActivationArgsSchema, args))
      throw new UploadError(400, "invalid_request", "Expected an activation operation ID");
    return Response.json(
      await hostArtifactActivationOp(id, "hostArtifactActivationStatus", args),
      { headers: noStore },
    );
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
