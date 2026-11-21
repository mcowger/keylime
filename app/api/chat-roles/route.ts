import { apiErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import { getRpcSession } from "@/lib/rpc-manager";
import { isValidSessionId } from "@/lib/session-file-references-core";
import { ChatRolesSchema } from "@/lib/api-contracts/configuration-models";
import { Value } from "@sinclair/typebox/value";
import { listHostChatRoles } from "@/lib/hosts/hub";

/**
 * @apiContract getChatRoles
 * @apiUsage Resolve chat roles for the selected workspace and daemon.
 * @apiInputs Supply an absolute cwd, optional hostId, optional existing sessionId, optional current composer thinkingLevel and optional currentProvider and currentModelId together.
 * @apiInvariants The owning daemon resolves OMP workspace settings and models; unresolved roles have null model fields. A live session supplies its own model and thinking state. For a temporary runner, the supplied current model is resolved from its available registry; inactive sessions without a composer selector have unknown inherited effort.
 * @apiEffects Queries a live runner, or starts a temporary workspace runner and waits for model discovery; never starts a saved session.
 * @apiRecovery Correct the workspace or provider configuration, or upgrade and reconnect the selected daemon.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const cwd = params.get("cwd");
  if (!cwd) return Response.json({ error: "Workspace path is required", code: "path_required" }, { status: 400 });
  const target = resolveHostOrError(params.get("hostId") ?? undefined);
  if ("response" in target) return target.response;
  try {
    const sessionId = params.get("sessionId");
    if (sessionId !== null && !isValidSessionId(sessionId))
      return Response.json({ error: "Invalid session ID", code: "invalid_session_id" }, { status: 400 });
    const currentProvider = params.get("currentProvider");
    const currentModelId = params.get("currentModelId");
    if ((currentProvider !== null || currentModelId !== null) && (!currentProvider?.trim() || !currentModelId?.trim()))
      return Response.json({ error: "currentProvider and currentModelId must be non-empty strings together", code: "invalid_current_model" }, { status: 400 });
    const session = sessionId ? getRpcSession(sessionId, target.host.id) : undefined;
    if (session?.isAlive()) {
      if (session.cwd !== cwd)
        return Response.json({ error: "Session workspace does not match", code: "workspace_mismatch" }, { status: 400 });
      const result = await session.send({ type: "get_chat_roles" });
      if (!Value.Check(ChatRolesSchema, result))
        return Response.json({ error: "Invalid chat roles response from runner", code: "invalid_runner_result" }, { status: 502 });
      return Response.json(result);
    }
    const thinkingLevel = params.get("thinkingLevel") ?? undefined;
    const result = await listHostChatRoles(target.host.id, cwd, thinkingLevel, currentProvider && currentModelId ? { provider: currentProvider, modelId: currentModelId } : undefined);
    if (sessionId && thinkingLevel === undefined) return Response.json({ roles: result.roles.map((role) => ({
      ...role, effectiveThinkingLevel: role.thinkingLevel === null ? null : role.effectiveThinkingLevel,
    })) });
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
