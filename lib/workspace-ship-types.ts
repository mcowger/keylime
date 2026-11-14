// Ship: commit, land or open a PR, and clean up a workspace (docs/specs/2026-11-14-ship-workflow-design.md).
// Pure and browser-safe; the daemon loads it too (relative imports only).

/** One commit of a plan. `message` is formatted by the runner and may be edited before `commit_apply`, which
 * uses it verbatim. `changes`/`dependencies` are omp's split-commit hunk selections and order, returned unchanged. */
export interface CommitPlanCommit {
  message: string;
  files: string[];
  changes?: unknown[];
  dependencies?: number[];
}

/** Changelog edits omp's commit agent proposed, applied by `commit_apply` as proposed. */
export interface CommitPlanChangelog {
  path: string;
  entries: Record<string, string[]>;
  deletions?: Record<string, string[]>;
}

/** Runner `commit_plan { context?, changelog? }` → `{ plan: CommitPlan | null }` (null: nothing to commit).
 * Runner `commit_apply { plan }` → `CommitApplyResult`.
 * Runner `generate_pr_description { base, context? }` → `PrDescription`. */
export interface CommitPlan {
  kind: "single" | "split";
  commits: CommitPlanCommit[];
  changelog: CommitPlanChangelog[];
  warnings: string[];
  usedFallback: boolean;
}

export interface CommitApplyResult {
  commits: Array<{ sha: string; subject: string }>;
  changelogFiles: string[];
}

export interface PrDescription {
  title: string;
  body: string;
}

export type ShipMode = "local" | "pr" | "pr-auto";
export type ShipMergeMethod = "squash" | "merge" | "rebase";

export interface ShipPr {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  checks: "pending" | "passing" | "failing" | "none";
  autoMerge: boolean;
  /** Archive the workspace's sessions, remove the workspace and pull the base once the PR merges. */
  cleanup: boolean;
  /** ISO time of the last `gh pr view`. */
  checkedAt: string;
}

/** Host op `shipPreview`: the workspace's state relative to its project's default workspace (local main). */
export interface ShipPreview {
  branch: string | null;
  /** The default workspace's current branch. */
  base: string;
  /** The default workspace's path. */
  baseCheckout: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  baseDirty: boolean;
  github: { repo: string | null; gh: "ok" | "missing" | "unauthenticated" };
  pr: ShipPr | null;
}

/** Host op `startShip`. Commits already exist (`commit_apply`); a dirty workspace fails the job. */
export interface ShipRequest {
  projectPath: string;
  path: string;
  mode: ShipMode;
  rebase: boolean;
  /** Required for `pr` and `pr-auto`. */
  pr?: PrDescription;
  /** Default `squash`. */
  mergeMethod?: ShipMergeMethod;
  cleanup: boolean;
}

export type ShipStepName =
  | "rebase"
  | "fastForward"
  | "push"
  | "createPr"
  | "autoMerge"
  | "pullBase"
  | "archiveSessions"
  | "removeWorkspace";

export interface ShipStep {
  name: ShipStepName;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  detail?: string;
}

/** Host ops `startShip`, `shipStatus(id)`, `shipFinish({ projectPath, path })`. `conflict`: the rebase stopped on
 * conflicts and was aborted; the workspace is back where it was. */
export interface ShipJob {
  id: string;
  kind: "ship" | "finish";
  projectPath: string;
  path: string;
  mode?: ShipMode;
  status: "running" | "complete" | "failed" | "conflict" | "interrupted";
  steps: ShipStep[];
  logs: string;
  error?: string;
  conflictFiles?: string[];
  pr?: ShipPr;
  landedSha?: string;
}

/** On `HierarchyWorkspace.ship`: what the sidebar pill shows. */
export interface WorkspaceShipState {
  pr?: ShipPr;
  job?: { id: string; kind: ShipJob["kind"]; status: ShipJob["status"] };
}
