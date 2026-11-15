import type { Static } from "@sinclair/typebox";
import type * as M from "./api-contracts/workspace-models";

/** Select an existing local/remote branch or create a branch from baseRef. */
export type WorkspaceBranchMode = Static<typeof M.WorkspaceBranchModeSchema>;
/** Commands run in order across creation phases; the job completes after postNonBlocking commands finish. */
export type WorkspacePipeline = Static<typeof M.WorkspacePipelineSchema>;
export type WorkspacePaseoPreview = Static<
  typeof M.WorkspacePaseoPreviewSchema
>;
/** Effective defaults, nullable project override and optional Paseo configuration preview. */
export type WorkspaceCreationSettings = Static<
  typeof M.WorkspaceCreationSettingsSchema
>;
/** Partial settings update: omitted fields remain unchanged; null override clears it. */
export type WorkspaceSettingsRequest = Static<
  typeof M.WorkspaceSettingsRequestSchema
>;
/** Host project and branch selection for asynchronous worktree creation. */
export type WorkspaceCreateRequest = Static<
  typeof M.WorkspaceCreateRequestSchema
>;
/** Persisted creation progress; stage and status are separate, and restart can interrupt a job. */
export type WorkspaceCreationJob = Static<typeof M.WorkspaceCreationJobSchema>;
/** Snapshot of local and remote Git refs and the suggested default base ref. */
export type WorkspaceBranches = Static<typeof M.WorkspaceBranchesSchema>;
/** Explicit choices for handling processes, dirty work and branch retention before worktree deletion. */
export type WorkspaceDeleteRequest = Static<
  typeof M.WorkspaceDeleteRequestSchema
>;
/** Deletion outcome or a condition requiring a decision; not every result means deletion occurred. */
export type WorkspaceDeleteResult = Static<
  typeof M.WorkspaceDeleteResultSchema
>;
