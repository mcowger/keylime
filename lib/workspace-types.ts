import type { Static } from "@sinclair/typebox";
import type * as M from "./api-contracts/workspace-models";
import type { SystemsRequest, SystemsResult } from "./api-contracts/systems";
import type {
  PlanningBoard,
  PlanningOperation,
} from "./api-contracts/planning";
import type { WorkspaceFileEvent as SchemaWorkspaceFileEvent } from "./api-contracts/host-schemas";
import type {
  UploadConflictStrategy,
  UploadTargetInspection,
} from "./file-upload";
import type { OpResult } from "./hosts/session-ops";
import type { GitFileDiffResponse, GitStatusResponse } from "./git-types";
import type { CloneProgress } from "./git-clone";

import type {
  HierarchyRequest,
  HierarchySnapshot,
} from "./project-hierarchy-types";
import type {
  WorkspaceBranches,
  WorkspaceCreateRequest,
  WorkspaceCreationJob,
  WorkspaceCreationSettings,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResult,
  WorkspaceSettingsRequest,
} from "./workspace-creation-types";
import type {
  ShipJob,
  ShipPrMonitor,
  ShipPreview,
  ShipMonitorStatusResult,
  ShipStartInput,
  ShipStartMonitorInput,
  ShipStopMonitorRequest,
} from "./workspace-ship-types";

/** Host identity and session context used to locate workspace files. */
export type WorkspaceFileSource = Static<typeof M.WorkspaceFileSourceSchema>;
/** Authoritative session ownership derived from the wrapper or creation journal, not browser cwd. */
export type WorkspaceOwner = Static<typeof M.WorkspaceOwnerSchema>;
/** Host-resolved path segments and optional session owner for file access checks. */
export type WorkspaceFileRequest = Static<typeof M.WorkspaceFileRequestSchema>;
/** Point-in-time host file metadata; size is bytes and mtimeMs is Unix milliseconds. */
export type WorkspaceFileInfo = Static<typeof M.WorkspaceFileInfoSchema>;
export type WorkspaceDirectoryListing = Static<
  typeof M.WorkspaceDirectoryListingSchema
>;
/** Handle for chunked host file reads; close it when finished. */
export type WorkspaceRead = Static<typeof M.WorkspaceReadSchema>;
/** Indexed paths or matches; truncation means the result is incomplete. */
export type WorkspaceIndex = Static<typeof M.WorkspaceIndexSchema>;
/** Bash output text or an oversized result carrying actual and maximum byte counts. */
export type WorkspaceBashOutput = Static<typeof M.WorkspaceBashOutputSchema>;
/** Destination of a published upload, including whether conflict policy skipped it. */
export type WorkspaceUploadResult = Static<
  typeof M.WorkspaceUploadResultSchema
>;
export type WorkspaceFileEvent = SchemaWorkspaceFileEvent;
/** Discovered Git worktrees, not necessarily canonical workspace registrations. */
export type WorkspaceWorktrees = Static<typeof M.WorkspaceWorktreesSchema>;
export type GitOrigin = Static<typeof M.GitOriginSchema>;
export type GitAction = Static<typeof M.GitActionSchema>;
export type GitActionResponse = Static<typeof M.GitActionResponseSchema>;
/** Host filesystem directory-picker snapshot, distinct from project registration. */
export type WorkspaceDirectoryBrowse = Static<
  typeof M.WorkspaceDirectoryBrowseSchema
>;

import type { WorkspaceTerminal } from "./terminal-types";

export interface WorkspaceOps {
  terminals(
    action: string,
    input: Record<string, unknown>,
  ): Promise<
    OpResult<{
      terminals?: WorkspaceTerminal[];
      terminal?: WorkspaceTerminal;
      snapshot?: string;
      cursor?: number;
    }>
  >;
  /** List or control named Paseo scripts on the workspace's owning daemon. */
  workspaceScripts(
    input: M.WorkspaceScriptsRequest,
  ): Promise<OpResult<M.WorkspaceScriptsResult>>;
  /** Read or mutate Systems and Efforts owned by this daemon. */
  systems(input: SystemsRequest): Promise<OpResult<SystemsResult>>;
  /** Read or mutate the board owned by the selected daemon. */
  planning(operation: PlanningOperation): Promise<PlanningBoard>;
  hierarchy(input: HierarchyRequest): Promise<OpResult<HierarchySnapshot>>;
  shipPreview(input: {
    projectPath: string;
    path: string;
  }): Promise<OpResult<ShipPreview>>;
  startShip(input: ShipStartInput): Promise<OpResult<ShipJob>>;
  shipStatus(id: string): Promise<OpResult<ShipJob>>;
  shipFinish(input: {
    projectPath: string;
    path: string;
  }): Promise<OpResult<ShipJob>>;
  startShipMonitor(
    input: ShipStartMonitorInput,
  ): Promise<OpResult<ShipPrMonitor>>;
  stopShipMonitor(
    input: ShipStopMonitorRequest,
  ): Promise<OpResult<{ stopped: boolean }>>;
  shipMonitorStatus(
    input: ShipStopMonitorRequest,
  ): Promise<OpResult<ShipMonitorStatusResult>>;
  createWorkspace(
    input: WorkspaceCreateRequest,
  ): Promise<OpResult<WorkspaceCreationJob>>;
  workspaceCreationStatus(id: string): Promise<OpResult<WorkspaceCreationJob>>;
  workspaceCreationSettings(
    input: WorkspaceSettingsRequest,
  ): Promise<OpResult<WorkspaceCreationSettings>>;
  workspaceBranches(projectPath: string): Promise<OpResult<WorkspaceBranches>>;
  removeRegisteredWorktree(
    input: WorkspaceDeleteRequest,
  ): Promise<OpResult<WorkspaceDeleteResult>>;
  home(): Promise<OpResult<{ home: string }>>;
  listFiles(
    input: WorkspaceFileRequest,
    showHidden: boolean,
  ): Promise<OpResult<WorkspaceDirectoryListing>>;
  listFilesInRoot(
    input: WorkspaceFileRequest,
    root: string | null,
  ): Promise<OpResult<WorkspaceDirectoryListing>>;
  fileInfo(input: WorkspaceFileRequest): Promise<OpResult<WorkspaceFileInfo>>;
  readTextFile(
    input: WorkspaceFileRequest,
  ): Promise<OpResult<{ content: string; language: string; size: number }>>;
  openFile(input: WorkspaceFileRequest): Promise<OpResult<WorkspaceRead>>;
  readFileChunk(
    id: string,
    offset: number,
    length: number,
  ): Promise<OpResult<Uint8Array>>;
  closeFile(id: string): Promise<OpResult<null>>;
  fileIndex(
    cwd: string,
    query: string,
    limit: number,
    kind: "all" | "file",
    refresh: boolean,
    owner?: WorkspaceOwner,
  ): Promise<OpResult<WorkspaceIndex>>;
  readBashOutput(
    sessionId: string,
    path: string,
  ): Promise<OpResult<WorkspaceBashOutput>>;
  openBashOutput(
    sessionId: string,
    path: string,
  ): Promise<OpResult<WorkspaceRead>>;
  inspectUploads(
    directory: string,
    names: string[],
    owner?: WorkspaceOwner,
  ): Promise<OpResult<UploadTargetInspection>>;
  publishUpload(
    id: string,
    directory: string,
    name: string,
    conflict: UploadConflictStrategy,
    owner?: WorkspaceOwner,
  ): Promise<OpResult<WorkspaceUploadResult>>;
  watchFile(
    id: string,
    epoch: string,
    input: WorkspaceFileRequest,
  ): Promise<OpResult<WorkspaceFileInfo>>;
  unwatchFile(id: string, epoch: string): Promise<OpResult<null>>;
  gitStatus(
    cwd: string,
    owner?: WorkspaceOwner,
  ): Promise<OpResult<GitStatusResponse>>;
  gitAction(
    cwd: string,
    action: GitAction,
    owner?: WorkspaceOwner,
  ): Promise<OpResult<GitActionResponse>>;
  gitDiff(
    cwd: string,
    path: string,
    owner?: WorkspaceOwner,
  ): Promise<OpResult<GitFileDiffResponse>>;
  githubRepo(cwd: string): Promise<OpResult<{ repo: string | null }>>;
  listWorktrees(cwd: string): Promise<OpResult<WorkspaceWorktrees>>;
  browseDirectories(
    path: string | null,
  ): Promise<OpResult<WorkspaceDirectoryBrowse>>;
  defaultCwd(): Promise<OpResult<{ cwd: string }>>;
  startClone(
    id: string,
    parent: string,
    url: string,
  ): Promise<OpResult<{ id: string }>>;
  readClone(id: string, cursor: number): Promise<OpResult<CloneProgress>>;
  cancelClone(id: string): Promise<OpResult<CloneProgress>>;
  /** The absolute path of a file in a session's `local://` directory on this host (stat'ed, never read). `sessionFile`
   * is main's hint of the live session file; the host verifies it. */
  resolveLocalFile(
    id: string,
    uri: string,
    sessionFile: string | null,
  ): Promise<OpResult<{ path: string }>>;
  /** One answer per requested path, in order; at most 500 paths. */
  gitOrigins(paths: string[]): Promise<OpResult<{ origins: GitOrigin[] }>>;
}

export const WORKSPACE_OP_PARAMS: {
  readonly [K in keyof WorkspaceOps]: readonly string[];
} = {
  terminals: ["action", "input"],
  hierarchy: ["input"],
  createWorkspace: ["input"],
  workspaceCreationStatus: ["id"],
  workspaceCreationSettings: ["input"],
  workspaceBranches: ["projectPath"],
  removeRegisteredWorktree: ["input"],
  home: [],
  listFiles: ["input", "showHidden"],
  fileInfo: ["input"],
  readTextFile: ["input"],
  openFile: ["input"],
  readFileChunk: ["id", "offset", "length"],
  closeFile: ["id"],
  fileIndex: ["cwd", "query", "limit", "kind", "refresh", "owner"],
  readBashOutput: ["sessionId", "path"],
  openBashOutput: ["sessionId", "path"],
  inspectUploads: ["directory", "names", "owner"],
  publishUpload: ["id", "directory", "name", "conflict", "owner"],
  watchFile: ["id", "epoch", "input"],
  unwatchFile: ["id", "epoch"],
  gitStatus: ["cwd", "owner"],
  gitDiff: ["cwd", "path", "owner"],
  githubRepo: ["cwd"],
  listWorktrees: ["cwd"],
  browseDirectories: ["path"],
  defaultCwd: [],
  startClone: ["id", "parent", "url"],
  readClone: ["id", "cursor"],
  cancelClone: ["id"],
  // Older peers cap the advertised prefix before filtering unknown capabilities.
  listFilesInRoot: ["input", "root"],
  resolveLocalFile: ["id", "uri", "sessionFile"],
  gitOrigins: ["paths"],
  shipPreview: ["input"],
  startShip: ["input"],
  shipStatus: ["id"],
  shipFinish: ["input"],
  startShipMonitor: ["input"],
  stopShipMonitor: ["input"],
  shipMonitorStatus: ["input"],
  systems: ["input"],
  planning: ["operation"],
  gitAction: ["cwd", "action", "owner"],
  workspaceScripts: ["input"],
};

export function isWorkspaceOp(value: string): value is keyof WorkspaceOps {
  return Object.hasOwn(WORKSPACE_OP_PARAMS, value);
}
