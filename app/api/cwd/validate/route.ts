import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { allowFileRoot } from "@/lib/file-access";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { comparableProjectPath } from "@/lib/comparable-path";

// POST /api/cwd/validate  body: { cwd: string; hostId?: string }
// Validates a candidate workspace on `hostId` (this machine when absent) before the UI selects it.
/**
 * @apiContract workspaceValidateCwd
 * @apiUsage Validate a candidate working directory before selection.
 * @apiInputs Send cwd and optional hostId; cwd is trimmed.
 * @apiInvariants The daemon validates its own filesystem path; validation is not a session grant.
 * @apiEffects Checks the candidate without selecting it.
 * @apiRecovery Correct the path or host and validate again after a failure.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: unknown; hostId?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return Response.json(
        { error: "Path is required", code: "path_required" },
        { status: 400 },
      );
    }

    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const result = await target.host.sessionOps.validateCwd(cwd);
    if (!result.ok) return opErrorResponse(result);
    // Browsable only on this machine: another host's paths do not exist here.
    if (target.host.id === LOCAL_HOST_ID) allowFileRoot(result.value.cwd);
    return Response.json({
      success: true,
      cwd: result.value.cwd,
      projectRoot: result.value.projectRoot,
      projectKey:
        result.value.projectKey ??
        comparableProjectPath(result.value.projectRoot),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
