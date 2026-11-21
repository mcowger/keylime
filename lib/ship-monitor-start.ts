import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  HierarchySnapshotSchema,
  ShipPrMonitorSchema,
  ShipStartMonitorRequestSchema,
} from "./api-contracts/workspace-models";
import type { Host } from "./hosts/host";
import { getShipHostCredential } from "./hosts/hub";
import { HostOpError } from "./hosts/link-protocol";
import {
  insertShipMonitorGrant,
  revokeShipMonitorGrant,
} from "./message-outbox";
import type { ShipPr, ShipStartMonitorRequest } from "./workspace-ship-types";

/** Start under a durable grant scoped to this server's authenticated host link. */
export async function startShipMonitorForHost(
  host: Host,
  input: ShipStartMonitorRequest,
) {
  if (
    !host.supportsWorkspaceOp("startShipMonitor") ||
    !host.supportsWorkspaceOp("shipMonitorStatus")
  )
    return {
      ok: false as const,
      error: "This host doesn't support starting PR monitoring",
      code: "unsupported_operation",
      status: 501,
    };

  const credential = getShipHostCredential(host.id);
  if (!credential)
    throw new HostOpError(503, "host_offline", "No authenticated host link");
  const { projectPath, path, prUrl, sessionId } = input;
  const monitorId = randomUUID();
  const grant = {
    monitorId,
    hostId: host.id,
    credential,
    projectPath,
    path,
    sessionId,
  };
  insertShipMonitorGrant(grant, prUrl);

  let result;
  try {
    result = await host.workspaceOps.startShipMonitor({ ...input, monitorId });
  } catch (error) {
    // A disconnected link may have delivered the request; only revoke for
    // known pre-execution refusals.
    if (
      error instanceof HostOpError &&
      (error.code === "workspace_unsupported" ||
        error.code === "host_request_too_large" ||
        error.code === "server_stopping" ||
        error.code === "unknown_op" ||
        error.code === "host_stopping" ||
        error.code === "host_drained" ||
        error.code === "link_not_authenticated")
    )
      revokeShipMonitorGrant(grant);
    throw error;
  }
  if (!result.ok) {
    if (result.status >= 400 && result.status < 500)
      revokeShipMonitorGrant(grant);
    return result;
  }
  if (
    !Value.Check(ShipPrMonitorSchema, result.value) ||
    result.value.id !== monitorId
  )
    throw new HostOpError(502, "host_bad_result", "Invalid PR monitor result");
  return result;
}

/** Resolve the calling chat's unique registered workspace on its source host. */
async function workspaceForSession(
  host: Host,
  sessionId: string,
  validateHierarchy = false,
) {
  if (!sessionId) throw new Error("The calling chat is unavailable.");
  if (!host.supportsWorkspaceOp("hierarchy"))
    throw new Error("Update or restart the host to monitor pull requests.");
  const hierarchy = await host.workspaceOps.hierarchy({ action: "list" });
  if (!hierarchy.ok) throw new Error(hierarchy.error);
  if (
    validateHierarchy &&
    !Value.Check(HierarchySnapshotSchema, hierarchy.value)
  )
    throw new Error("The host returned an invalid workspace hierarchy.");
  const matches = hierarchy.value.projects.flatMap((project) =>
    project.workspaces
      .filter((workspace) => workspace.sessionIds.includes(sessionId))
      .map((workspace) => ({ project, workspace })),
  );
  if (matches.length !== 1)
    throw new Error(
      "The calling chat does not belong to a unique registered workspace.",
    );
  return matches[0];
}

/** Read the recorded PR, including terminal state and public monitoring status. */
export async function getWorkspacePrForSession(
  host: Host,
  sessionId: string,
): Promise<{ pr: ShipPr | null }> {
  const { workspace } = await workspaceForSession(host, sessionId, true);
  if (workspace.unavailable)
    throw new Error("The calling chat's workspace is unavailable.");
  return { pr: workspace.ship?.pr ?? null };
}

/** Resolve only the calling chat's registered linked worktree and its recorded PR. */
export async function monitorWorkspacePrForSession(
  host: Host,
  sessionId: string,
) {
  const { project, workspace } = await workspaceForSession(host, sessionId);
  if (project.kind !== "git" || workspace.isDefault || workspace.unavailable)
    throw new Error(
      "The calling chat must belong to an available linked Git worktree.",
    );
  const pr = workspace.ship?.pr;
  if (!pr || pr.state !== "open")
    throw new Error(
      "No open pull request is recorded for this workspace. Use register_workspace_pr first.",
    );
  if (pr.monitor)
    return {
      status: "already_monitoring" as const,
      message:
        "This PR is already monitored; the existing watch may deliver to another chat.",
    };
  const input = {
    projectPath: project.path,
    path: workspace.path,
    prUrl: pr.url,
    sessionId,
  };
  if (
    !Value.Check(ShipStartMonitorRequestSchema, input) ||
    input.prUrl.trim() !== input.prUrl ||
    !Number.isSafeInteger(
      Number(input.prUrl.slice(input.prUrl.lastIndexOf("/") + 1)),
    )
  )
    throw new Error(
      "The recorded PR cannot be monitored because its identity is invalid.",
    );
  const result = await startShipMonitorForHost(host, input);
  if (!result.ok) throw new Error(result.error);
  return {
    status: "started" as const,
    message:
      "PR feedback monitoring started. New feedback links will be sent to this chat; monitoring does not block merging.",
  };
}
