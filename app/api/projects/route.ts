import {
  apiErrorResponse,
  opErrorResponse,
  resolveHostOrError,
} from "@/lib/api-utils";
import { isValidOmpProfile } from "@/lib/omp-profile";
import { allowFileRoot } from "@/lib/file-access";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { listProjectsAllHosts } from "@/lib/hosts/session-index";
import {
  isReservedLaunchArg,
  ProjectPathError,
  type ProjectPresentationUpdate,
} from "@/lib/project-registry";
import { isRecord } from "@/lib/type-guards";
import type { ProjectLaunchConfig } from "@/lib/types";
const MAX_EXTRA_ARGS = 32;
const MAX_EXTRA_ARG_LENGTH = 256;

/** Validate the workspace-level omp launch config; reject overrides of web-managed session-boundary args. */
function parseLaunchConfig(value: unknown): ProjectLaunchConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectPathError(
      "invalid_launch_config",
      "Launch config must be an object",
    );
  const raw = value as Record<string, unknown>;
  const profile =
    raw.profile === undefined
      ? undefined
      : typeof raw.profile === "string" && raw.profile.trim()
        ? raw.profile.trim()
        : undefined;
  if (raw.profile !== undefined && !profile)
    throw new ProjectPathError(
      "invalid_profile",
      "Profile must be a non-empty string",
    );
  if (profile !== undefined && !isValidOmpProfile(profile))
    throw new ProjectPathError(
      "invalid_profile",
      "Profile names must match ^[a-z0-9][a-z0-9._-]{0,63}$, cannot end with '.', and cannot use OMP-reserved device names (CON, PRN, AUX, NUL, COM0-9, LPT0-9, including names with extensions)",
    );
  const advisor = raw.advisor === undefined ? undefined : raw.advisor;
  if (advisor !== undefined && typeof advisor !== "boolean")
    throw new ProjectPathError("invalid_advisor", "Advisor must be a boolean");
  if (
    raw.extraArgs !== undefined &&
    (!Array.isArray(raw.extraArgs) || raw.extraArgs.length > MAX_EXTRA_ARGS)
  )
    throw new ProjectPathError(
      "invalid_extra_args",
      "Extra args must contain at most 32 arguments",
    );
  const extraArgs =
    raw.extraArgs === undefined
      ? undefined
      : (raw.extraArgs as unknown[]).map((arg) => {
          if (
            typeof arg !== "string" ||
            !arg ||
            arg.length > MAX_EXTRA_ARG_LENGTH ||
            isReservedLaunchArg(arg)
          )
            throw new ProjectPathError(
              "invalid_extra_args",
              "Extra args contain an invalid or reserved argument",
            );
          return arg;
        });
  if (
    !profile &&
    advisor === undefined &&
    (!extraArgs || extraArgs.length === 0)
  )
    return undefined;
  return { profile, advisor, extraArgs };
}

function parsePresentation(
  entry: Record<string, unknown>,
): ProjectPresentationUpdate {
  const alias =
    entry.alias === null
      ? null
      : typeof entry.alias === "string"
        ? entry.alias
        : undefined;
  const sortOrder =
    entry.sortOrder === null
      ? null
      : typeof entry.sortOrder === "number" && Number.isFinite(entry.sortOrder)
        ? entry.sortOrder
        : undefined;
  const pinOrder =
    entry.pinOrder === null
      ? null
      : typeof entry.pinOrder === "number" && Number.isFinite(entry.pinOrder)
        ? entry.pinOrder
        : undefined;
  if (entry.alias !== undefined && alias === undefined)
    throw new ProjectPathError("invalid_alias", "Alias must be a string");
  if (entry.sortOrder !== undefined && sortOrder === undefined)
    throw new ProjectPathError(
      "invalid_sort_order",
      "Sort order must be a number",
    );
  if (entry.pinOrder !== undefined && pinOrder === undefined)
    throw new ProjectPathError(
      "invalid_pin_order",
      "Pin order must be a number",
    );
  return {
    alias,
    sortOrder,
    pinOrder,
    launchConfig:
      entry.launchConfig === null
        ? null
        : parseLaunchConfig(entry.launchConfig),
  };
}

export async function GET() {
  try {
    return Response.json({ projects: await listProjectsAllHosts() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const body: unknown = await req.json();
    if (
      !isRecord(body) ||
      typeof body.cwd !== "string" ||
      body.poolId !== undefined
    )
      throw new ProjectPathError(
        "invalid_target",
        "A host project path is required",
      );
    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const result = await target.host.workspaceOps.hierarchy({
      action: "registerProject",
      path: body.cwd,
    });
    if (!result.ok) return opErrorResponse(result);
    const project = result.value.projects.find(
      (p) => p.id === result.value.selectedProjectId,
    );
    if (!project) throw new Error("Project registration failed");
    const launchConfig = parseLaunchConfig(body.launchConfig);
    if (launchConfig) {
      const updated = await target.host.workspaceOps.hierarchy({
        action: "updateProject",
        projectId: project.id,
        launchConfig,
      });
      if (!updated.ok) return opErrorResponse(updated);
      project.launchConfig = launchConfig;
    }
    if (target.host.id === LOCAL_HOST_ID) allowFileRoot(project.path);
    return Response.json({ project: { ...project, hostId: target.host.id } });
  } catch (error) {
    if (error instanceof ProjectPathError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: 400 },
      );
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const body: unknown = await req.json();
    if (!isRecord(body) || body.poolId !== undefined)
      throw new ProjectPathError("invalid_target", "Invalid project target");
    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const listing = await target.host.workspaceOps.hierarchy({
      action: "list",
    });
    if (!listing.ok) return opErrorResponse(listing);
    const updates = Array.isArray(body.updates) ? body.updates : [body];
    if (!updates.length || updates.length > 500)
      throw new ProjectPathError("invalid_updates", "Invalid updates");
    for (const item of updates) {
      if (!isRecord(item) || typeof item.cwd !== "string")
        throw new ProjectPathError(
          "invalid_target",
          "Project path is required",
        );
      const project = listing.value.projects.find((p) => p.path === item.cwd);
      if (!project)
        throw new ProjectPathError(
          "project_not_found",
          "Project is not registered",
        );
      const result = await target.host.workspaceOps.hierarchy({
        action: "updateProject",
        projectId: project.id,
        ...parsePresentation(item),
      });
      if (!result.ok) return opErrorResponse(result);
    }
    return Response.json({ projects: await listProjectsAllHosts() });
  } catch (error) {
    if (error instanceof ProjectPathError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: 400 },
      );
    return apiErrorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const body: unknown = await req.json();
    if (
      !isRecord(body) ||
      typeof body.cwd !== "string" ||
      body.poolId !== undefined
    )
      throw new ProjectPathError("invalid_target", "Project path is required");
    const target = resolveHostOrError(body.hostId);
    if ("response" in target) return target.response;
    const listing = await target.host.workspaceOps.hierarchy({
      action: "list",
    });
    if (!listing.ok) return opErrorResponse(listing);
    const project = listing.value.projects.find((p) => p.path === body.cwd);
    if (!project)
      throw new ProjectPathError(
        "project_not_found",
        "Project is not registered",
      );
    const result = await target.host.workspaceOps.hierarchy({
      action: "unregisterProject",
      projectId: project.id,
    });
    return result.ok
      ? Response.json({ success: true })
      : opErrorResponse(result);
  } catch (error) {
    if (error instanceof ProjectPathError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: 400 },
      );
    return apiErrorResponse(error);
  }
}
