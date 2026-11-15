import type { Static } from "@sinclair/typebox";
import type * as M from "./api-contracts/workspace-models";

/** Canonically registered workspace and session membership, not merely a discovered worktree. */
export type HierarchyWorkspace = Static<typeof M.HierarchyWorkspaceSchema>;
/** Registered host project and its workspaces, with optional display and ordering metadata. */
export type HierarchyProject = Static<typeof M.HierarchyProjectSchema>;
/** Registered hierarchy plus optional discovery candidates that require explicit import. */
export type HierarchySnapshot = Static<typeof M.HierarchySnapshotSchema>;
/** Action-specific hierarchy query or mutation; nullable metadata clears existing values. */
export type HierarchyRequest = Static<typeof M.HierarchyRequestSchema>;
