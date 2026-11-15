import type { Static } from "@sinclair/typebox";
import type * as M from "./api-contracts/workspace-models";

export type GitFileStatusKind = Static<typeof M.GitFileStatusKindSchema>;
export type GitCollapseReason = Static<typeof M.GitCollapseReasonSchema>;
/** Normalized file category plus separate Git index and working-tree status codes. */
export type GitFileStatus = Static<typeof M.GitFileStatusSchema>;
/** Point-in-time Git status with a nullable host repository root. */
export type GitStatusResponse = Static<typeof M.GitStatusResponseSchema>;
/** File diff observation; unsupported files do not necessarily have a patch. */
export type GitFileDiffResponse = Static<typeof M.GitFileDiffResponseSchema>;
