import type { Static } from "@sinclair/typebox";
import type * as M from "./api-contracts/workspace-models";

export type CommitPlanCommit = Static<typeof M.CommitPlanCommitSchema>;
export type CommitPlanChangelog = Static<typeof M.CommitPlanChangelogSchema>;
/** Proposed commit sequence and changelog edits; warnings and fallback indicate planning limitations. */
export type CommitPlan = Static<typeof M.CommitPlanSchema>;
export type CommitApplyResult = Static<typeof M.CommitApplyResultSchema>;
export type PrDescription = Static<typeof M.PrDescriptionSchema>;
export type ShipMode = Static<typeof M.ShipModeSchema>;
export type ShipMergeMethod = Static<typeof M.ShipMergeMethodSchema>;
export type ShipPr = Static<typeof M.ShipPrSchema>;
/** Preflight snapshot, not a reservation: checkout, GitHub and PR state may change before shipping. */
export type ShipPreview = Static<typeof M.ShipPreviewSchema>;
/** Shipping choices may rebase, push, create a PR and clean up the workspace. */
export type ShipRequest = Static<typeof M.ShipRequestSchema>;
export type ShipStartInput = Static<typeof M.ShipStartInputSchema>;
export type ShipMonitorStatusResult = Static<
  typeof M.ShipMonitorStatusResultSchema
>;
export type ShipStopMonitorRequest = Static<
  typeof M.ShipStopMonitorRequestSchema
>;
export type ShipStepName = Static<typeof M.ShipStepNameSchema>;
export type ShipStep = Static<typeof M.ShipStepSchema>;
/** Persisted step-by-step job; a failure or interruption can leave earlier Git or cleanup effects in place. */
export type ShipJob = Static<typeof M.ShipJobSchema>;
/** Hierarchy summary of the recorded PR and most recent ship job, when present. */
export type WorkspaceShipState = Static<typeof M.WorkspaceShipStateSchema>;
