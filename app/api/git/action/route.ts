import { Value } from "@sinclair/typebox/value";
import { GitActionRequestSchema } from "@/lib/api-contracts/workspace-models";
import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";

/**
 * @apiContract workspaceGitAction
 * @apiUsage Execute one Git action in an authorized workspace.
 * @apiInputs Send hostId, cwd, action and optional sessionId; a session determines the authoritative host and cwd.
 * @apiInvariants Git runs on the owning host without interactive prompts or force options. Rebase targets existing local refs.
 * @apiEffects Push, pull, fetch or rebase may change repository or remote state; conflicts remain in Git's normal recoverable state.
 * @apiRecovery Inspect repository and remote state after timeout or link loss before deciding what to do; resolve or abort conflicts using Git.
 */
export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid Git action request", code: "invalid_request" },
        { status: 400 },
      );
    }
    if (
      !Value.Check(GitActionRequestSchema, body) ||
      !body.hostId.trim() ||
      !body.cwd.trim()
    ) {
      return Response.json(
        { error: "Invalid Git action request", code: "invalid_request" },
        { status: 400 },
      );
    }
    const resolved = await resolveWorkspaceHost(
      body.hostId,
      body.sessionId ?? null,
    );
    if ("response" in resolved) return resolved.response;
    try {
      const result = await resolved.host.workspaceOps.gitAction(
        resolved.cwd ?? body.cwd.trim(),
        body.action,
        resolved.owner,
      );
      if (result.ok) return Response.json(result.value);
      if (result.code === "git_outcome_unknown") {
        return Response.json(
          { error: result.error, code: result.code, delivery: "unknown" },
          { status: result.status },
        );
      }
      return opErrorResponse(result);
    } catch (error) {
      if (
        error instanceof HostOpError &&
        ["host_offline", "host_timeout", "host_bad_result"].includes(error.code)
      ) {
        return Response.json(
          {
            error: `${error.message}. The Git action may have run; inspect repository and remote state before deciding what to do.`,
            code: error.code,
            delivery: "unknown",
            ...(error.code === "host_offline" ? { hostOffline: true } : {}),
          },
          { status: error.status },
        );
      }
      throw error;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
