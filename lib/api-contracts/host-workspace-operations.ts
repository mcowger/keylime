import { Type, type TSchema } from "@sinclair/typebox";
import type { OperationContract } from "./operations";
import * as M from "./workspace-models";
import { SystemsRequestSchema, SystemsResultSchema } from "./systems";
import { PlanningBoardSchema, PlanningOperationSchema } from "./planning";

const str = Type.String(),
  num = Type.Number(),
  bool = Type.Boolean();
const nullableString = Type.Union([str, Type.Null()]);
const owner = Type.Optional(M.WorkspaceOwnerSchema);
const failure = Type.Object({
  ok: Type.Literal(false),
  status: num,
  code: str,
  error: str,
});
const result = (value: TSchema) =>
  Type.Union([Type.Object({ ok: Type.Literal(true), value }), failure]);
const op = (
  name: string,
  description: string,
  args: TSchema,
  value: TSchema,
): OperationContract => ({ name, description, args, result: result(value) });
const obj = Type.Object;
const id = obj({ id: str });
const file = obj({ input: M.WorkspaceFileRequestSchema });
const projectPathAndPath = obj({ projectPath: str, path: str });
const terminalArgs = Type.Union([
  obj({ action: Type.Literal("list"), input: obj({ cwd: str }) }),
  obj({
    action: Type.Literal("create"),
    input: obj({ cwd: str, cols: num, rows: num }),
  }),
  obj({ action: Type.Literal("snapshot"), input: id }),
  obj({ action: Type.Literal("input"), input: obj({ id: str, data: str }) }),
  obj({
    action: Type.Literal("resize"),
    input: obj({ id: str, cols: num, rows: num }),
  }),
  obj({
    action: Type.Literal("focus"),
    input: obj({ id: str, viewer: str, focused: bool }),
  }),
  obj({ action: Type.Literal("close"), input: id }),
]);
const terminalResult = Type.Union([
  obj({ terminals: Type.Array(M.WorkspaceTerminalSchema) }),
  obj({ terminal: M.WorkspaceTerminalSchema }),
  M.TerminalSnapshotSchema,
  obj({}),
]);
const hierarchyArgs = Type.Union([
  obj({ action: Type.Literal("list") }),
  obj({
    action: Type.Literal("registerProject"),
    path: Type.Optional(str),
    cwd: Type.Optional(str),
  }),
  ...["unregisterProject", "discoverWorkspaces"].map((action) =>
    obj({ action: Type.Literal(action), projectId: str }),
  ),
  obj({ action: Type.Literal("listProjectIcons"), projectId: str }),
  obj({
    action: Type.Literal("setProjectIcon"),
    projectId: str,
    icon: nullableString,
  }),
  obj({
    action: Type.Literal("updateProject"),
    projectId: str,
    alias: Type.Optional(nullableString),
    sortOrder: Type.Optional(Type.Union([num, Type.Null()])),
    pinOrder: Type.Optional(Type.Union([num, Type.Null()])),
    launchConfig: M.HierarchyRequestSchema.properties.launchConfig,
  }),
  obj({
    action: Type.Literal("importWorkspaces"),
    projectId: str,
    paths: Type.Array(str),
  }),
  obj({ action: Type.Literal("discoverSessions"), workspaceId: str }),
  obj({
    action: Type.Literal("importSessions"),
    workspaceId: str,
    sessionIds: Type.Array(str),
  }),
  ...["unregisterSession", "registerSession"].map((action) =>
    obj({ action: Type.Literal(action), workspaceId: str, sessionId: str }),
  ),
  obj({ action: Type.Literal("moveSession"), from: str, to: str }),
]);

export const hostWorkspaceOperations: readonly OperationContract[] = [
  op(
    "terminals",
    `Usage: Manage host-daemon terminals for a workspace.
Inputs: The action selects cwd, terminal id, dimensions, input text, or viewer focus state.
Invariants: IDs and snapshots belong to the daemon; cursors order output, not filesystem bytes. A service terminal can retain output after its process exits.
Effects: Create starts an interactive shell using the host account's shell, falling back to the daemon's SHELL or /bin/sh when unavailable; it keeps the daemon's HOME when set. Input, resize, focus and close change terminal state; list and snapshot observe it.
Recovery: Re-list or snapshot after disconnection; a restarted daemon does not preserve terminal processes.`,
    terminalArgs,
    terminalResult,
  ),
  op(
    "hierarchy",
    `Usage: Inspect or change the registered project/workspace/session hierarchy.
Inputs: Action-specific IDs, host paths, imports or project metadata select the operation; nullable metadata clears it.
Invariants: Discovery yields candidates; importing or registering changes canonical membership and is distinct from filesystem discovery. listProjectIcons scans at most five directory levels below the project root and examines at most 2,000 entries, returning at most 24 icons of at most 256 KiB each. It skips hidden names, symlinks, node_modules, vendor, dist and release, and applies Git ignore rules when available. Results are best-effort, not an exhaustive inventory.
Effects: Mutations persist hierarchy changes; list and discovery return snapshots.
Recovery: Re-read the hierarchy before repeating an uncertain mutation.`,
    obj({ input: hierarchyArgs }),
    M.HierarchySnapshotSchema,
  ),
  op(
    "shipPreview",
    `Usage: Preview shipping a registered workspace against its base checkout.
Inputs: projectPath and path are host filesystem paths.
Invariants: Dirty state, branch divergence, issues and PR data are point-in-time observations; GitHub authentication status is briefly cached.
Effects: Inspects Git and GitHub without starting a ship job.
Recovery: Refresh the preview after state changes; it does not reserve the checkout.`,
    obj({ input: projectPathAndPath }),
    M.ShipPreviewSchema,
  ),
  op(
    "startShip",
    `Usage: Start the asynchronous ship sequence for a registered workspace.
Inputs: Host project/workspace paths, mode, rebase, PR and cleanup choices control the sequence. For monitoring in PR modes, pass both monitorSessionId for a chat in the same workspace and the server-issued monitorGrantId.
Invariants: Checkout and branch preconditions are checked during execution; steps can fail after earlier steps succeeded. The authenticated daemon link selects the notification server. Job acceptance does not mean monitoring has started.
Effects: Depending on mode, rebases, fast-forwards, pushes, creates or configures a PR, and may archive sessions and remove the workspace. Opted-in monitoring sends feedback links to chat without gating merges.
Recovery: Inspect job status and Git/PR state after uncertainty; do not blindly replay destructive steps.`,
    obj({ input: M.ShipStartInputSchema }),
    M.ShipJobSchema,
  ),
  op(
    "shipStatus",
    `Usage: Read a ship job by id.
Inputs: id identifies the host job.
Invariants: Status and ordered steps report persisted progress, not an atomic transaction.
Effects: Reads job state; recovery marks jobs interrupted after restart.
Recovery: Inspect steps and repository/PR state before deciding how to proceed.`,
    id,
    M.ShipJobSchema,
  ),
  op(
    "shipFinish",
    `Usage: Start finishing a shipped workspace.
Inputs: projectPath and path identify registered host checkouts.
Invariants: Cleanup requires a merged PR bound to the current registered workspace ID. Path reuse and records without an ID are refused; earlier steps may already have completed on failure.
Effects: May update the base checkout, archive sessions and remove the workspace.
Recovery: Read job and checkout state before retrying an uncertain finish.`,
    obj({ input: projectPathAndPath }),
    M.ShipJobSchema,
  ),
  op(
    "startShipMonitor",
    `Usage: Watch an already recorded open PR without running Ship.
Inputs: projectPath and path identify the workspace. Pass the expected canonical prUrl, a chat sessionId in this workspace, and a server-issued monitorId.
Invariants: The authenticated link selects the notification server. The host checks that the recorded PR belongs to the current workspace ID and checks the chat; it never replaces an existing watch.
Effects: Starts feedback monitoring without changing the PR or merge settings.
Recovery: Refresh the workspace hierarchy before retrying an uncertain start.`,
    obj({ input: M.ShipStartMonitorInputSchema }),
    M.ShipPrMonitorSchema,
  ),
  op(
    "stopShipMonitor",
    `Usage: Stop PR feedback monitoring for a workspace.
Inputs: projectPath, path and monitorId identify a workspace and monitor generation.
Invariants: Only the initiating server link can stop a monitor. A stale generation cannot stop its replacement.
Effects: Stops feedback monitoring without changing the pull request or merge settings.
Recovery: Refresh workspace state before retrying an uncertain request.`,
    obj({ input: M.ShipStopMonitorRequestSchema }),
    M.ShipStopMonitorResultSchema,
  ),
  op(
    "shipMonitorStatus",
    `Usage: Read the current PR feedback watch before admitting a digest.
Inputs: projectPath, path and monitorId identify the exact workspace and monitor generation.
Invariants: Returns a watch only to its initiating server when the recorded PR is open and the chat is still active in the workspace. The PR URL is canonical.
Effects: Reads local state without changing or caching the watch.
Recovery: A missing watch cannot authorize a digest. Recheck on the next offer.`,
    obj({ input: M.ShipStopMonitorRequestSchema }),
    M.ShipMonitorStatusResultSchema,
  ),
  op(
    "createWorkspace",
    `Usage: Start an asynchronous workspace creation job.
Inputs: projectPath, branch, mode, baseRef and name select the host checkout and branch. New branches can use refs/pull/<number>/head for GitHub pull requests.
Invariants: The job captures its pipeline and progresses through stages; failure can leave partial work.
Effects: Runs configured commands and creates a worktree and registration.
Recovery: Poll the job and inspect the checkout before retrying after an uncertain response.`,
    obj({ input: M.WorkspaceCreateRequestSchema }),
    M.WorkspaceCreationJobSchema,
  ),
  op(
    "workspaceCreationStatus",
    `Usage: Read an asynchronous creation job.
Inputs: id identifies the host job.
Invariants: Stage, status and logs describe recorded progress; interrupted is distinct from failure.
Effects: Observes job state, including recovery of interrupted work.
Recovery: Inspect the job and workspace before restarting creation.`,
    id,
    M.WorkspaceCreationJobSchema,
  ),
  op(
    "workspaceCreationSettings",
    `Usage: Read or update workspace creation settings.
Inputs: Optional projectPath selects project settings; omitted fields remain unchanged and null override clears it.
Invariants: Defaults, override and source determine the effective creation pipeline.
Effects: Supplied settings are persisted; a read returns the current settings.
Recovery: Re-read settings after an uncertain update before making another change.`,
    obj({ input: M.WorkspaceSettingsRequestSchema }),
    M.WorkspaceCreationSettingsSchema,
  ),
  op(
    "workspaceBranches",
    `Usage: List branch choices for workspace creation.
Inputs: projectPath is a registered host project path.
Invariants: The local default is preferred; origin's default is a second choice only when it has commits missing locally. Other choices exclude checked-out branches. GitHub pull requests include drafts.
Effects: Refreshes remote-tracking refs and queries GitHub if configured, without creating a branch or checkout.
Recovery: Reopen the picker to refresh refs; a remote that couldn't be refreshed uses cached refs.`,
    obj({ projectPath: str }),
    M.WorkspaceBranchesSchema,
  ),
  op(
    "removeRegisteredWorktree",
    `Usage: Remove a registered worktree.
Inputs: Host project and worktree paths plus stopProcesses, discardChanges, keepBranch and cancel control admission.
Invariants: Unregistered projects are rejected; processes, dirty changes and branch decisions can require confirmation.
Effects: Accepted removal can stop processes, discard changes, remove the worktree and delete its branch.
Recovery: Inspect returned status and current hierarchy/Git state before retrying an uncertain removal.`,
    obj({ input: M.WorkspaceDeleteRequestSchema }),
    M.WorkspaceDeleteResultSchema,
  ),
  op(
    "home",
    `Usage: Get the host home directory.
Inputs: No arguments.
Invariants: The returned path belongs to the host machine, not the browser.
Effects: Reads process environment state.
Recovery: Re-query after reconnecting to a host.`,
    obj({}),
    obj({ home: str }),
  ),
  op(
    "listFiles",
    `Usage: List a workspace directory.
Inputs: File request identifies the host path and optional session owner; showHidden controls hidden entries.
Invariants: The target must be a directory and access restrictions apply.
Effects: Reads a point-in-time filesystem listing.
Recovery: Refresh the listing after filesystem changes or reconnect.`,
    obj({ input: M.WorkspaceFileRequestSchema, showHidden: bool }),
    M.WorkspaceDirectoryListingSchema,
  ),
  op(
    "fileInfo",
    `Usage: Inspect a workspace filesystem entry.
Inputs: File request supplies path segments and optional session ownership.
Invariants: Paths resolve on the host and access restrictions apply.
Effects: Reads file metadata, not file contents.
Recovery: Re-query after a change; metadata is a snapshot.`,
    file,
    M.WorkspaceFileInfoSchema,
  ),
  op(
    "listFilesInRoot",
    `Usage: List a directory confined to a root.
Inputs: File request selects a host path; root may be null.
Invariants: Paths outside an enforced root are rejected with outside_root.
Effects: Reads a filesystem listing.
Recovery: Correct the target or refresh after changes.`,
    obj({ input: M.WorkspaceFileRequestSchema, root: nullableString }),
    M.WorkspaceDirectoryListingSchema,
  ),
  op(
    "readTextFile",
    `Usage: Read a workspace text file.
Inputs: File request identifies a host file and optional owner.
Invariants: Access and file restrictions apply; returned size is in bytes.
Effects: Reads file content and metadata.
Recovery: Re-read after a change; the result is not a subscription.`,
    file,
    obj({ content: str, language: str, size: num }),
  ),
  op(
    "openFile",
    `Usage: Open a workspace file for chunked reading.
Inputs: File request identifies the host file and optional owner.
Invariants: The target must be a file; changes can invalidate the reader.
Effects: Allocates a host reader handle and returns its metadata.
Recovery: On file_changed, close and reopen instead of combining chunks from different versions.`,
    file,
    M.WorkspaceReadSchema,
  ),
  op(
    "readFileChunk",
    `Usage: Read a chunk from an open file reader.
Inputs: id is the reader handle; offset and length are byte counts.
Invariants: Successful bytes travel in a binary host-link media frame, not a JSON Uint8Array.
Effects: Reads the open file without mutating it.
Recovery: If the file changed or the handle was lost, reopen and restart the read.`,
    obj({ id: str, offset: num, length: num }),
    Type.String({
      contentEncoding: "binary",
      description: "Raw bytes carried separately in the host-link media frame.",
    }),
  ),
  op(
    "closeFile",
    `Usage: Close a chunked file reader.
Inputs: id identifies the host reader.
Invariants: The handle is no longer usable after close.
Effects: Releases reader resources.
Recovery: If uncertain, discard the handle and open a new reader when needed.`,
    id,
    Type.Null(),
  ),
  op(
    "fileIndex",
    `Usage: Search or list indexed workspace paths.
Inputs: cwd is a host directory; query, limit, kind, refresh and optional owner constrain the request.
Invariants: Results can be truncated and reflect the index rather than a guaranteed live filesystem snapshot.
Effects: May refresh the index; otherwise reads indexed state.
Recovery: Refresh and repeat the query when stale results matter.`,
    obj({
      cwd: str,
      query: str,
      limit: num,
      kind: Type.Union([Type.Literal("all"), Type.Literal("file")]),
      refresh: bool,
      owner,
    }),
    M.WorkspaceIndexSchema,
  ),
  op(
    "readBashOutput",
    `Usage: Read a session bash output file.
Inputs: sessionId and path identify the session output on the host.
Invariants: Oversized output returns a size and byte limit instead of the contents.
Effects: Reads existing output without changing it.
Recovery: Use chunked output reading when the result is too large.`,
    obj({ sessionId: str, path: str }),
    M.WorkspaceBashOutputSchema,
  ),
  op(
    "openBashOutput",
    `Usage: Open session bash output for chunked reading.
Inputs: sessionId and path identify the host output file.
Invariants: The returned reader refers to the opened file version.
Effects: Creates a reader handle; close it when finished.
Recovery: Reopen if the handle is lost or the file changes.`,
    obj({ sessionId: str, path: str }),
    M.WorkspaceReadSchema,
  ),
  op(
    "inspectUploads",
    `Usage: Inspect upload destination conflicts.
Inputs: directory is a host path; names are destination basenames and owner supplies session context.
Invariants: Protected targets are rejected; nonReplaceable includes directories and symbolic links among conflicts.
Effects: Reads destination metadata without publishing files.
Recovery: Reinspect immediately before a decision; filesystem state can change.`,
    obj({ directory: str, names: Type.Array(str), owner }),
    M.UploadTargetInspectionSchema,
  ),
  op(
    "publishUpload",
    `Usage: Publish a staged upload into a host directory.
Inputs: id identifies the staged upload; name, conflict strategy and optional owner select the destination.
Invariants: Protected targets are rejected and overwrite cannot replace directories or symbolic links.
Effects: Publishes, overwrites, or skips the target according to conflict strategy.
Recovery: upload_publish_uncertain means the outcome is indeterminate; inspect the target rather than blindly replaying.`,
    obj({
      id: str,
      directory: str,
      name: str,
      conflict: M.UploadConflictStrategySchema,
      owner,
    }),
    M.WorkspaceUploadResultSchema,
  ),
  op(
    "unwatchFile",
    `Usage: Stop a file watch.
Inputs: id and epoch identify the watch instance.
Invariants: Epoch distinguishes a watch from later reuse of the same id.
Effects: Releases that watch and its event stream.
Recovery: After reconnect, establish a fresh watch and snapshot.`,
    obj({ id: str, epoch: str }),
    Type.Null(),
  ),
  op(
    "watchFile",
    `Usage: Watch a workspace file and obtain initial metadata.
Inputs: id, epoch and file request identify the watch instance and host file.
Invariants: The target must be a file; epoch distinguishes successive watches, and startup can return watch_closed.
Effects: Registers a watch that emits file events until closed or disconnected.
Recovery: Reopen with a fresh epoch and refresh metadata after disconnection.`,
    obj({ id: str, epoch: str, input: M.WorkspaceFileRequestSchema }),
    M.WorkspaceFileInfoSchema,
  ),
  op(
    "gitStatus",
    `Usage: Inspect Git status for a host checkout.
Inputs: cwd and optional owner identify the workspace context.
Invariants: File status and index/worktree codes are a point-in-time Git observation.
Effects: Reads repository state without modifying it.
Recovery: Refresh after filesystem or Git changes.`,
    obj({ cwd: str, owner }),
    M.GitStatusResponseSchema,
  ),
  op(
    "gitDiff",
    `Usage: Inspect a file's Git diff.
Inputs: cwd, path and optional owner identify a host checkout and file.
Invariants: A diff may be unsupported; patch is present only when available.
Effects: Reads Git and filesystem state.
Recovery: Refresh after changes rather than applying an old patch as current state.`,
    obj({ cwd: str, path: str, owner }),
    M.GitFileDiffResponseSchema,
  ),
  op(
    "githubRepo",
    `Usage: Resolve a checkout's GitHub repository.
Inputs: cwd is a host checkout path.
Invariants: repo can be null when no GitHub repository is resolved.
Effects: Inspects repository configuration.
Recovery: Re-query after remote configuration changes.`,
    obj({ cwd: str }),
    obj({ repo: nullableString }),
  ),
  op(
    "listWorktrees",
    `Usage: List worktrees for a checkout.
Inputs: cwd is a host path.
Invariants: Results distinguish the main checkout and current worktree; branch may be null.
Effects: Reads Git worktree state.
Recovery: Refresh after worktrees or branches change.`,
    obj({ cwd: str }),
    M.WorkspaceWorktreesSchema,
  ),
  op(
    "browseDirectories",
    `Usage: Browse host directories.
Inputs: path selects a host directory or null selects the initial location.
Invariants: Results describe host filesystem directories, not registered projects.
Effects: Reads directory entries.
Recovery: Refresh after filesystem changes or choose an accessible path.`,
    obj({ path: nullableString }),
    M.WorkspaceDirectoryBrowseSchema,
  ),
  op(
    "defaultCwd",
    `Usage: Get the host default working directory.
Inputs: No arguments.
Invariants: The path is on the host machine.
Effects: Reads host configuration or environment.
Recovery: Re-query after reconnecting to a different host.`,
    obj({}),
    obj({ cwd: str }),
  ),
  op(
    "startClone",
    `Usage: Start cloning a repository into a host directory.
Inputs: id identifies the clone; parent is a host path and url is the Git remote.
Invariants: The target directory derives from the supported remote URL; progress is asynchronous.
Effects: Starts Git and creates files in the target directory; jobs survive web/link restart but not daemon shutdown or prolonged inactivity.
Recovery: Read clone progress and inspect the target after uncertainty; do not blindly start another clone.`,
    obj({ id: str, parent: str, url: str }),
    id,
  ),
  op(
    "readClone",
    `Usage: Read incremental clone progress.
Inputs: id identifies the clone and cursor is a UTF-8 output byte position.
Invariants: reset signals that retained history no longer covers the requested cursor; terminal marks completion. Jobs expire after inactivity.
Effects: Reads retained progress frames and refreshes the job's idle timer.
Recovery: On reset replace the previous progress view; use the returned cursor for the next read.`,
    obj({ id: str, cursor: num }),
    M.CloneProgressSchema,
  ),
  op(
    "cancelClone",
    `Usage: Cancel an active clone.
Inputs: id identifies the host clone job.
Invariants: Returned progress reports its resulting state; cancellation can race completion.
Effects: Requests termination of the clone process and cleanup of its target.
Recovery: Read progress and inspect the target before starting again.`,
    id,
    M.CloneProgressSchema,
  ),
  op(
    "resolveLocalFile",
    `Usage: Resolve a local:// session file without reading it.
Inputs: id identifies the session, uri is the local URI and sessionFile is nullable context.
Invariants: Resolution and access restrictions are evaluated on the host.
Effects: Returns a host path without reading file contents.
Recovery: Resolve again if the session or file context changes.`,
    obj({ id: str, uri: str, sessionFile: nullableString }),
    obj({ path: str }),
  ),
  op(
    "gitOrigins",
    `Usage: Resolve Git origins for host paths.
Inputs: paths contains at most 500 host paths.
Invariants: Results preserve input order; origin can be null and mainCheckout distinguishes the main checkout.
Effects: Inspects Git configuration without changing it.
Recovery: Re-query after remote or worktree changes.`,
    obj({ paths: Type.Array(str, { maxItems: 500 }) }),
    obj({ origins: Type.Array(M.GitOriginSchema) }),
  ),
  op(
    "systems",
    `Usage: Manage Systems and Efforts on one host daemon.
Inputs: Select an action with its host paths, IDs, settings, or preview confirmation. Service controls identify a saved service and never take a command or environment override.
Invariants: Creation captures resolved commits and the System definition. Planned admission requires the daemon's current launch version and plan. Paths and branches remain stable on rename. A running service is not a readiness check.
Effects: Actions can change definitions, admit durable setup, control daemon-owned service PTYs, or clean up Efforts. Cleanup does not remove branches, push commits, or close PRs.
Recovery: List host state after uncertain delivery. Retry incomplete setup explicitly and refresh a cleanup preview before resuming removal. A daemon restart does not restart services.`,
    obj({ input: SystemsRequestSchema }),
    SystemsResultSchema,
  ),
  {
    name: "planning",
    description: `Usage: Read or edit the Notes & Tasks board on its owning daemon.
Inputs: Identify a registered Repo or System by kind and ID, then select an action. Browser preview reads board references; Improve reads only live attachments on the selected task. Launch reads use the claimed launch ID and version, never arbitrary image IDs. Begin and launch updates are internal.
Invariants: Edits check the saved revision. Begin pins the generated name, saved prompt and task images, never Notes. Launch updates compare the full previous record. Only an unadmitted Effort that needs review can replace its setup plan.
Effects: Persists board changes outside the checkout. Preparing an older launch for delivery keeps only pinned images still proven to belong to its task. Does not write to Git or run workspace setup or chat delivery.
Recovery: Read the board after a conflict or uncertain result. Never assume an unconfirmed launch transition was claimed.`,
    args: obj({ operation: PlanningOperationSchema }),
    result: PlanningBoardSchema,
  },
];
