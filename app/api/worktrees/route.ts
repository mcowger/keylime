import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import { workspacePromptNames } from "@/lib/workspace-prompt";
import type {
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceSettingsRequest,
} from "@/lib/workspace-creation-types";

/**
 * @apiContract workspaceWorktreesGet
 * @apiUsage List worktrees or inspect branches, creation settings or creation status.
 * @apiInputs action selects branches, settings or status; otherwise cwd lists worktrees. hostId selects the daemon.
 * @apiInvariants projectPath and cwd are host-machine paths; status uses the job id.
 * @apiEffects Returns host snapshots without creating a worktree.
 * @apiRecovery Poll status or refresh the listing as creation progresses.
 */
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

/**
 * @apiContract workspaceWorktreesPost
 * @apiUsage Prepare, create, configure or delete a registered workspace.
 * @apiInputs Send action, action-specific input and optional hostId; prepare requires projectPath and nonblank prompt.
 * @apiInvariants Prepare requires a registered Git project and default base ref; deletion uses the host’s confirmation preconditions.
 * @apiEffects Prepare and create start creation; settings can change configuration; delete removes a registered worktree and invalidates session lists.
 * @apiRecovery After an uncertain result inspect job status and worktree state before retrying; deletion is not assumed rolled back.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (
      isRecord(body) &&
      (body.action === "create" ||
        body.action === "prepare" ||
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
      if (body.action === "prepare") {
        const { projectPath, prompt } = body.input;
        if (
          typeof projectPath !== "string" ||
          !projectPath ||
          typeof prompt !== "string" ||
          !prompt.trim()
        ) {
          return Response.json(
            { error: "Invalid request", code: "invalid_request" },
            { status: 400 },
          );
        }
        const hierarchy = await resolved.host.workspaceOps.hierarchy({
          action: "list",
        });
        if (!hierarchy.ok) return opErrorResponse(hierarchy);
        const project = hierarchy.value.projects.find(
          (item) => item.path === projectPath,
        );
        if (!project) {
          return Response.json(
            { error: "Project not found", code: "project_not_found" },
            { status: 404 },
          );
        }
        if (project.kind !== "git") {
          return Response.json(
            {
              error: "Workspace creation requires a Git project",
              code: "workspace_requires_git",
            },
            { status: 400 },
          );
        }
        const branches =
          await resolved.host.workspaceOps.workspaceBranches(projectPath);
        if (!branches.ok) return opErrorResponse(branches);
        if (!branches.value.defaultRef) {
          return Response.json(
            {
              error: "No default base ref is available",
              code: "invalid_request",
            },
            { status: 400 },
          );
        }
        let names: { name: string; branch: string };
        try {
          names = await workspacePromptNames(prompt, request.signal);
        } catch {
          return Response.json(
            {
              error: "Could not generate a workspace name",
              code: "workspace_naming_failed",
            },
            { status: 502 },
          );
        }
        const created = await resolved.host.workspaceOps.createWorkspace({
          projectPath,
          ...names,
          mode: "new",
          baseRef: branches.value.defaultRef,
        });
        return created.ok
          ? Response.json(created.value)
          : opErrorResponse(created);
      }
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
