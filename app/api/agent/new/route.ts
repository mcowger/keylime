import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import {
  WebRpcError,
  startNewRpcSession,
  type AgentSessionWrapper,
} from "@/lib/rpc-manager";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { validateAgentImages } from "@/lib/image-attachments";
import { isRecord } from "@/lib/type-guards";

function newSessionErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json(
      { error: "New session request is too large", code: "request_too_large" },
      { status: 413 },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json(
      { error: "Invalid JSON request body", code: "invalid_json" },
      { status: 400 },
    );
  }
  // host_offline falls through to apiErrorResponse: 503 {hostOffline: true}.
  if (
    (error instanceof WebRpcError && error.code !== "host_offline") ||
    error instanceof RpcCommandError
  ) {
    return Response.json(
      {
        error: error.message,
        code:
          error instanceof WebRpcError
            ? error.code
            : (error.code ?? "rpc_command_failed"),
      },
      { status: 400 },
    );
  }
  return apiErrorResponse(error);
}
export async function POST(req: Request) {
  try {
    const body = await parseJsonWithinLimit<{
      cwd?: string;
      hostId?: unknown;
      [key: string]: unknown;
    }>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    if (!isRecord(body))
      return Response.json(
        {
          error: "A session request object is required",
          code: "invalid_request",
        },
        { status: 400 },
      );
    const {
      cwd: requestedCwd,
      hostId,
      workspaceId,
      projectId,
      ...command
    } = body;
    if (
      body.poolId !== undefined ||
      body.creationId !== undefined ||
      body.ref !== undefined
    )
      return Response.json(
        {
          error: "Choose a registered workspace on a host",
          code: "invalid_workspace_target",
        },
        { status: 400 },
      );
    if (
      Object.hasOwn(command, "uploadProofs") ||
      Object.hasOwn(command, "uploads")
    ) {
      return Response.json(
        {
          error: "Files attach only to an existing session",
          code: "invalid_uploads",
        },
        { status: 400 },
      );
    }
    const {
      provider,
      modelId,
      toolNames,
      thinkingLevel,
      advisor,
      name,
      ...promptCommand
    } = command as {
      provider?: string;
      modelId?: string;
      toolNames?: string[];
      thinkingLevel?: string;
      advisor?: boolean;
      name?: string;
      [key: string]: unknown;
    };
    // A session id has no meaning for a fresh spawn and must never reach the
    // child RPC: a stale or forged id would address the wrong session.
    delete promptCommand.sessionId;
    if (typeof promptCommand.type !== "string" || !promptCommand.type.trim()) {
      return Response.json(
        { error: "command type is required", code: "command_type_required" },
        { status: 400 },
      );
    }
    if (
      [provider, modelId, thinkingLevel, name].some(
        (value) =>
          value !== undefined && (typeof value !== "string" || !value.trim()),
      ) ||
      (toolNames !== undefined &&
        (!Array.isArray(toolNames) ||
          toolNames.some(
            (value) => typeof value !== "string" || !value.trim(),
          ))) ||
      (advisor !== undefined && typeof advisor !== "boolean") ||
      (promptCommand.message !== undefined &&
        typeof promptCommand.message !== "string")
    ) {
      return Response.json(
        {
          error: "Invalid session initialization fields",
          code: "invalid_creation_intent",
        },
        { status: 400 },
      );
    }
    const imageError = validateAgentImages(promptCommand.images);
    if (imageError)
      return Response.json(
        { error: imageError, code: "invalid_images" },
        { status: 400 },
      );

    const initialize = async (
      session: AgentSessionWrapper,
      preserveUnknownDelivery: boolean,
    ) => {
      if (provider && modelId)
        await session.send(
          { type: "set_model", provider, modelId },
          { preserveUnknownDelivery },
        );
      if (thinkingLevel)
        await session.send(
          { type: "set_thinking_level", level: thinkingLevel },
          { preserveUnknownDelivery },
        );
      if (name)
        await session.send(
          { type: "set_session_name", name },
          { preserveUnknownDelivery },
        );
      if (promptCommand.type === "ensure_session") return null;
      return session.send(promptCommand, { preserveUnknownDelivery });
    };
    const preparing =
      promptCommand.type !== "ensure_session" ||
      !!(provider && modelId) ||
      !!thinkingLevel ||
      !!name;

    if (!requestedCwd || typeof requestedCwd !== "string") {
      return Response.json(
        { error: "cwd is required", code: "cwd_required" },
        { status: 400 },
      );
    }
    const target = resolveHostOrError(hostId);
    if ("response" in target) return target.response;
    const started = await startNewRpcSession(
      target.host,
      requestedCwd,
      toolNames,
      advisor === true,
      preparing,
    );
    if (!started.ok) return opErrorResponse(started);
    const { session, realSessionId } = started.value;
    try {
      const run = async () =>
        Response.json({
          success: true,
          sessionId: realSessionId,
          data: await initialize(session, false),
        });
      return await (preparing ? session.withPendingCommand(run, true) : run());
    } catch (error) {
      if (error instanceof WebRpcError && error.code === "host_offline") {
        return Response.json(
          {
            error: error.message,
            code: error.code,
            hostOffline: true,
            delivery: error.delivery,
            sessionId: realSessionId,
          },
          { status: 503 },
        );
      }
      await session.destroyAndWait();
      throw error;
    }
  } catch (error) {
    return newSessionErrorResponse(error);
  }
}
