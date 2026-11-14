import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import type {
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceSettingsRequest,
} from "@/lib/workspace-creation-types";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveWorkspaceHost(
      params.get("hostId") ?? undefined,
      null,
    );
    if ("response" in resolved) return resolved.response;
    const action = params.get("action");
    if (action === "branches" || action === "settings" || action === "status") {
      const projectPath = params.get("projectPath") ?? "";
      const result =
        action === "branches"
          ? await resolved.host.workspaceOps.workspaceBranches(projectPath)
          : action === "settings"
            ? await resolved.host.workspaceOps.workspaceCreationSettings({
                projectPath: projectPath || undefined,
              })
            : await resolved.host.workspaceOps.workspaceCreationStatus(
                params.get("id") ?? "",
              );
      return result.ok ? Response.json(result.value) : opErrorResponse(result);
    }
    const result = await resolved.host.workspaceOps.listWorktrees(
      params.get("cwd") ?? "",
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (
      isRecord(body) &&
      (body.action === "create" ||
        body.action === "settings" ||
        body.action === "delete")
    ) {
      if (
        !isRecord(body.input) ||
        (body.hostId !== undefined && typeof body.hostId !== "string")
      )
        return Response.json(
          { error: "Invalid request", code: "invalid_request" },
          { status: 400 },
        );
      const resolved = await resolveWorkspaceHost(
        body.hostId as string | undefined,
        null,
      );
      if ("response" in resolved) return resolved.response;
      const result =
        body.action === "create"
          ? await resolved.host.workspaceOps.createWorkspace(
              body.input as unknown as WorkspaceCreateRequest,
            )
          : body.action === "settings"
            ? await resolved.host.workspaceOps.workspaceCreationSettings(
                body.input as unknown as WorkspaceSettingsRequest,
              )
            : await resolved.host.workspaceOps.removeRegisteredWorktree(
                body.input as unknown as WorkspaceDeleteRequest,
              );
      if (!result.ok) return opErrorResponse(result);
      if (body.action === "delete") invalidateHostSessionList(resolved.host.id);
      return Response.json(result.value);
    }
    return Response.json(
      { error: "Invalid request", code: "invalid_request" },
      { status: 400 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
