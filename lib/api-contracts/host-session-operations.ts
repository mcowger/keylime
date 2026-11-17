import {
  Type,
  type Static,
  type TLiteral,
  type TObject,
  type TSchema,
  type TUnion,
  type TUnsafe,
} from "@sinclair/typebox";
import {
  AgentMessageSchema,
  ArchivedSessionInfoSchema,
  ManagedProjectSchema,
  ProjectLaunchConfigSchema,
  SessionContextSchema,
  SessionInfoSchema,
  SessionTreeNodeSchema,
  SessionTitleSourceSchema,
} from "./domain";
import { SubagentHistoryEntrySchema } from "./runner-tools";
import type { OperationContract } from "./operations";

const nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const str = () => Type.String();
const empty = () => Type.Object({}, { additionalProperties: false });
const args = (properties: Record<string, TSchema>) =>
  Type.Object(properties, { additionalProperties: false });
const failure = Type.Object(
  { ok: Type.Literal(false), status: Type.Number(), code: str(), error: str() },
  {
    description:
      "Operation failure; status and code identify the expected error.",
  },
);
export const opResultSchema = <T extends TSchema>(value: T) =>
  Type.Union([Type.Object({ ok: Type.Literal(true), value }), failure]);
/** A logical operation outcome inside the link response; outer transport success does not imply ok. */
export type OperationResult<T> = Static<
  TUnion<[TObject<{ ok: TLiteral<true>; value: TUnsafe<T> }>, typeof failure]>
>;
export const SessionReadOptionsSchema = Type.Object(
  {
    deferThinking: Type.Boolean({
      description: "Defer loading assistant thinking blocks.",
    }),
    deferMedia: Type.Boolean({ description: "Defer loading embedded media." }),
    tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum number of newest display entries to return." })),
    before: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Exclusive oldest entry ID of the previously received page." })),
    historyRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Opaque revision returned by the first tail page; required with before." })),
  },
  { description: "Controls deferred content in a file-only session snapshot." },
);
// Bootstrapped from SessionHistoryCursor using TypeBox Codegen TypeScriptToTypeBox.
const cursor = Type.Object({
  firstEntryId: nullable(str()),
  lastEntryId: nullable(str()),
});
export const ContextReadOptionsSchema = Type.Object(
  {
    deferThinking: SessionReadOptionsSchema.properties.deferThinking,
    deferMedia: SessionReadOptionsSchema.properties.deferMedia,
    includePreCompaction: Type.Boolean({
      description: "Include entries omitted from the active agent context.",
    }),
    boundary: Type.Boolean({
      description: "Return only active context entry IDs.",
    }),
    sync: nullable(
      Type.Object({ cursor: nullable(cursor), limit: Type.Number() }),
    ),
  },
  {
    description:
      "Select active context, boundary IDs, or a cursor-based history page.",
  },
);
// Tree entries are navigation projections: their bodies are deliberately absent.
const SessionNavigationTreeSchema = Type.Unsafe<Static<typeof SessionTreeNodeSchema>>(
  Type.Recursive((This) => Type.Object({
    entry: Type.Object({ id: str(), type: str(), parentId: Type.Optional(nullable(str())), timestamp: Type.Optional(str()) }, { additionalProperties: true }),
    children: Type.Array(This),
    label: Type.Optional(str()),
    compressedEntryIds: Type.Optional(Type.Array(str())),
    branchPreview: Type.Optional(Type.Object({ role: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("assistant")])), text: str() })),
  })),
);
export const SessionReadValueSchema = Type.Object(
  {
    filePath: str(),
    info: Type.Omit(SessionInfoSchema, [
      "lastMessageAt",
      "projectRoot",
      "projectKey",
      "worktreeBranch",
    ]),
    leafId: nullable(str()),
    tree: Type.Array(Type.Union([SessionTreeNodeSchema, SessionNavigationTreeSchema])),
    context: SessionContextSchema,
    historyHasMore: Type.Optional(Type.Boolean({ description: "Whether older display entries precede this tail page." })),
    historyRevision: Type.Optional(Type.String({ description: "Opaque file generation; supply with before to prevent mixed histories." })),
  },
  {
    description:
      "File-only session metadata, navigation tree and current display context snapshot.",
  },
);
export const SessionHistoryContinuationSchema = Type.Object(
  {
    context: SessionContextSchema,
    historyHasMore: Type.Boolean({ description: "Whether older display entries precede this page." }),
    historyRevision: Type.String({ description: "Opaque file generation used to fence continuation pages." }),
  },
  { description: "An older history page without session metadata or the navigation tree." },
);
export const SessionReadResultSchema = Type.Union(
  [SessionReadValueSchema, SessionHistoryContinuationSchema],
  { description: "A session snapshot or an older history-only continuation page." },
);
export const ProjectUpdateSchema = Type.Object(
  {
    cwd: str(),
    alias: Type.Optional(nullable(str())),
    sortOrder: Type.Optional(nullable(Type.Number())),
    pinOrder: Type.Optional(nullable(Type.Number())),
    launchConfig: Type.Optional(nullable(ProjectLaunchConfigSchema)),
  },
  {
    description:
      "Project presentation changes; omitted fields are unchanged and null clears a field.",
  },
);
export const ProjectRegistryEntrySchema = Type.Object(
  {
    path: Type.String({
      description:
        "Canonical project root; worktrees resolve to their main repository.",
    }),
    addedAt: Type.String({
      description: "ISO timestamp of the latest explicit add.",
    }),
    hidden: Type.Boolean({
      description:
        "Hidden entries suppress sidebar rediscovery until added again.",
    }),
    alias: Type.Optional(str()),
    sortOrder: Type.Optional(Type.Number()),
    pinOrder: Type.Optional(Type.Number()),
    launchConfig: Type.Optional(ProjectLaunchConfigSchema),
  },
  {
    description: "Persisted project registry entry, including hidden entries.",
  },
);
const contextPage = Type.Object({
  mode: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
  baseEntryId: nullable(str()),
  context: SessionContextSchema,
  cursor,
  hasMore: Type.Boolean(),
});
export const ContextReadValueSchema = Type.Union(
  [
    Type.Object({ entryIds: Type.Array(str()) }),
    Type.Object({
      history: contextPage,
      leafId: nullable(str()),
      tipId: nullable(str()),
    }),
    Type.Object({ context: SessionContextSchema }),
  ],
  {
    description:
      "Selected context response: active IDs, paged history, or complete context.",
  },
);
export const ThinkingReadValueSchema = Type.Object(
  { thinking: str() },
  { description: "Text of the requested assistant thinking block." },
);
export const SessionStateValueSchema = Type.Object(
  {
    running: Type.Boolean({
      description: "Always false for a file-only session.",
    }),
  },
  {
    description:
      "File-only session state, which does not represent a running process.",
  },
);
const transcript = Type.Union(
  [
    Type.Object({
      sessionFile: str(),
      fromByte: Type.Number(),
      nextByte: Type.Number(),
      reset: Type.Boolean(),
      messages: Type.Array(AgentMessageSchema),
      error: Type.Optional(str()),
      totalBytes: Type.Optional(Type.Number()),
    }),
    Type.Object({
      sessionFile: str(),
      completion: nullable(str()),
      truncated: Type.Boolean(),
    }),
  ],
  {
    description:
      "Byte-offset transcript page or completion artifact; reset requires restarting the page cursor.",
  },
);
const id = () => ({ id: str() });
const path = () => ({ path: str() });
export const SubagentHistoryValueSchema = Type.Object(
  {
    subagents: Type.Array(SubagentHistoryEntrySchema),
  },
  {
    description: "Subagent history extracted from the session's task results.",
  },
);
export const SubagentTranscriptValueSchema = transcript;
const operation = (
  name: string,
  description: string,
  a: TSchema,
  result: TSchema,
): OperationContract => ({ name, description, args: a, result });
const wrapped = (
  name: string,
  description: string,
  a: TSchema,
  value: TSchema,
) => operation(name, description, a, opResultSchema(value));

/** Logical host operations before link framing. A failed operation is not queued for later replay; transport success and logical success are distinct. */
export const hostSessionOperations: readonly OperationContract[] = [
  operation(
    "listSessions",
    "Usage: List the host's sessions.\nInputs: No arguments.\nInvariants: Inventory can be cached and is a snapshot.\nEffects: Reads inventory without starting a runner.\nRecovery: Refresh after invalidation or reconnect when a current list is needed.",
    empty(),
    Type.Array(SessionInfoSchema),
  ),
  operation(
    "listSessionIdsForRestore",
    "Usage: Check active session IDs before restore.\nInputs: No arguments.\nInvariants: This strict inventory is uncached; failure cannot establish absence.\nEffects: Reads active IDs without starting a runner.\nRecovery: Resolve the failure and repeat the inventory before admitting restore.",
    empty(),
    Type.Array(str()),
  ),
  wrapped(
    "readSession",
    "Usage: Read session metadata, navigation tree and display context.\nInputs: Supply session ID, deferred-content options, and optionally tail; before requires the previous historyRevision.\nInvariants: Tail pages are chronological and exclusive on the active branch; continuation pages omit metadata and tree. Changed file generations or invalid branch cursors fail with session_history_changed. Without tail the full history is returned. This is not a live runner.\nEffects: Reads session data without starting a process.\nRecovery: Discard partial pages and synchronize after session_history_changed; inspect the logical operation result as well as the outer response.",
    args({ ...id(), options: SessionReadOptionsSchema }),
    SessionReadResultSchema,
  ),
  wrapped(
    "readContext",
    "Usage: Read active context, entry boundary or paged history.\nInputs: Supply ID, optional leaf and context options including sync cursor and limit.\nInvariants: The active branch and pre-compaction selection determine the snapshot; malformed, missing or oversized files fail.\nEffects: Reads session data without starting a process.\nRecovery: Refresh the cursor or correct the file before retrying; check the logical result separately from link success.",
    args({
      ...id(),
      leafId: Type.Optional(str()),
      options: ContextReadOptionsSchema,
    }),
    ContextReadValueSchema,
  ),
  wrapped(
    "readThinking",
    "Usage: Read an assistant thinking block.\nInputs: Supply session ID, entry ID and block index.\nInvariants: Session, assistant entry and block must exist.\nEffects: Reads the session file without starting a runner.\nRecovery: Refresh session context if the entry or block is absent.",
    args({ ...id(), entryId: str(), block: Type.Number() }),
    ThinkingReadValueSchema,
  ),
  wrapped(
    "readSessionState",
    "Usage: Read file-only session state.\nInputs: Supply session ID.\nInvariants: The file-only result reports running false; it is not a live process query.\nEffects: Reads session state without starting a runner.\nRecovery: Resolve session_not_found before retrying.",
    args(id()),
    SessionStateValueSchema,
  ),
  wrapped(
    "readSubagentHistory",
    "Usage: Read subagent history from task results.\nInputs: Supply session ID.\nInvariants: The session must exist; this is a snapshot.\nEffects: Reads history without starting a runner.\nRecovery: Refresh after task results change or resolve session_not_found.",
    args(id()),
    SubagentHistoryValueSchema,
  ),
  wrapped(
    "readSubagentTranscript",
    "Usage: Read a subagent transcript page or completion artifact.\nInputs: Supply session ID, subagent ID, mode and byte cursor.\nInvariants: Page offsets are bytes; reset signals a changed transcript. The session and transcript must exist.\nEffects: Reads artifacts without starting a runner.\nRecovery: Honor reset and restart paging; correct missing or invalid identifiers.",
    args({
      ...id(),
      subagentId: str(),
      mode: Type.Union([Type.Literal("page"), Type.Literal("completion")]),
      cursor: Type.Number(),
    }),
    SubagentTranscriptValueSchema,
  ),
  wrapped(
    "renameSessionFile",
    "Usage: Rename a session file.\nInputs: Supply session ID, title and optional title source.\nInvariants: The target session must exist.\nEffects: Mutates the session title on disk.\nRecovery: Read the title after an uncertain response before repeating the mutation.",
    args({
      ...id(),
      title: str(),
      source: Type.Optional(SessionTitleSourceSchema),
    }),
    Type.Null(),
  ),
  wrapped(
    "deleteSession",
    "Usage: Delete the selected session while preserving its child sessions.\nInputs: Supply the selected ID and the caller's liveSessionIds snapshot; the daemon also fences live processes.\nInvariants: Direct children keep their files. Eligible parentSession references are rewritten to the deleted session's parent, preserving path-versus-ID form; live or oversized child files are not rewritten and skipped rewrites are reported.\nEffects: Deletes the selected session and atomically rewrites eligible direct-child headers; it does not delete descendants.\nRecovery: Reconcile the selected session, preserved children and skippedChildren after an uncertain response before repeating the deletion; a successful deletion does not prove every child reference was rewritten.",
    args({ ...id(), liveSessionIds: Type.Array(str()) }),
    Type.Object({
      skippedChildren: Type.Optional(
        Type.Array(Type.Object({ id: str(), reason: str() })),
      ),
    }),
  ),
  wrapped(
    "archiveSession",
    "Usage: Archive a session and its artifacts.\nInputs: Supply session ID.\nInvariants: The session must exist.\nEffects: Moves the session and artifacts into the archive.\nRecovery: Inspect active and archived inventories after an uncertain response before repeating.",
    args(id()),
    Type.Object({ archivedPath: str() }),
  ),
  operation(
    "listArchives",
    "Usage: List archived sessions.\nInputs: No arguments.\nInvariants: Results are ordered newest first and represent a snapshot.\nEffects: Reads archives without starting a runner.\nRecovery: Refresh after archive or restore changes.",
    empty(),
    Type.Array(ArchivedSessionInfoSchema),
  ),
  wrapped(
    "restoreReserve",
    "Usage: Reserve a restore claim.\nInputs: Supply a nonempty claim.\nInvariants: The returned instance identifies the daemon holding the reservation; claims are not expiring leases. At most 256 reservations are retained; the oldest is evicted.\nEffects: Reserves admission in this daemon instance.\nRecovery: Retain instance identity and fence the claim after uncertainty; a different instance cannot prove the old instance stopped.",
    args({ claim: str() }),
    Type.Object({ instance: str() }),
  ),
  wrapped(
    "restoreArchive",
    "Usage: Restore an archive under a reserved claim.\nInputs: Supply archive key and claim.\nInvariants: The claim must be reserved and unfenced in this daemon instance.\nEffects: Restores archived session data.\nRecovery: Fence and reconcile the answering instance after uncertainty; unresolved prior-instance authority requires manual recovery rather than assuming expiry.",
    args({ key: str(), claim: str() }),
    Type.Object({ sessionId: str() }),
  ),
  wrapped(
    "restoreFence",
    "Usage: Fence a restore claim.\nInputs: Supply a nonempty claim.\nInvariants: Running refers only to the answering daemon instance; its identity is returned.\nEffects: Revokes admission for that claim in that instance.\nRecovery: Compare instance identity; a replacement daemon cannot establish whether work in the previous instance stopped.",
    args({ claim: str() }),
    Type.Object({ instance: str(), running: Type.Boolean() }),
  ),
  wrapped(
    "exportSession",
    "Usage: Export a session as HTML.\nInputs: Supply session ID.\nInvariants: The session and omp executable must be available.\nEffects: Runs omp export using a temporary file, then returns HTML and a suggested filename; it does not start a session runner.\nRecovery: Restore the missing session or executable before retrying.",
    args(id()),
    Type.Object({ html: str(), fileName: str() }),
  ),
  wrapped(
    "readMedia",
    "Usage: Read cached media.\nInputs: Supply a lowercase SHA-256 hash.\nInvariants: The in-process value is Uint8Array; link transport uses a binary payload, not a JSON object.\nEffects: Reads cached bytes without starting a runner.\nRecovery: Resolve invalid hash or missing media before retrying.",
    args({ hash: Type.String({ pattern: "^[0-9a-f]{64}$" }) }),
    Type.String({
      contentEncoding: "binary",
      description:
        "Raw media bytes in the binary transport payload (Uint8Array in process).",
    }),
  ),
  operation(
    "listProjects",
    "Usage: List the host project registry.\nInputs: No arguments.\nInvariants: Raw entries include hidden projects and are a snapshot.\nEffects: Reads registry data without starting a runner.\nRecovery: Refresh after registry changes.",
    empty(),
    Type.Array(ProjectRegistryEntrySchema),
  ),
  wrapped(
    "addProject",
    "Usage: Register a project.\nInputs: Supply path and optional launch configuration.\nInvariants: Invalid paths produce project-specific errors; worktrees resolve to their main repository.\nEffects: Updates the daemon project registry.\nRecovery: Inspect the registry after an uncertain result before repeating.",
    args({ ...path(), launchConfig: Type.Optional(ProjectLaunchConfigSchema) }),
    ManagedProjectSchema,
  ),
  wrapped(
    "updateProject",
    "Usage: Apply project presentation updates.\nInputs: Supply updates with cwd and optional nullable fields.\nInvariants: Duplicate targets merge per field, with later defined values winning; hidden entries are untouched. Invalid new paths in a bulk update can be skipped, while an entirely invalid batch fails. newRoots identifies newly registered roots.\nEffects: Mutates registry entries in one save.\nRecovery: Read the registry after uncertain delivery before repeating.",
    args({ updates: Type.Array(ProjectUpdateSchema) }),
    Type.Object({
      projects: Type.Array(ProjectRegistryEntrySchema),
      newRoots: Type.Array(str()),
    }),
  ),
  wrapped(
    "hideProject",
    "Usage: Hide a project.\nInputs: Supply its path.\nInvariants: Hidden registry entries suppress sidebar rediscovery until added again.\nEffects: Updates registry visibility.\nRecovery: Inspect registry state after an uncertain response.",
    args(path()),
    Type.Null(),
  ),
  wrapped(
    "validateCwd",
    "Usage: Validate a working directory and resolve its project.\nInputs: Supply a daemon-local path.\nInvariants: Missing paths and non-directories fail.\nEffects: Reads filesystem and project information without starting a runner.\nRecovery: Correct the path or filesystem state before retrying.",
    args(path()),
    Type.Object({
      cwd: str(),
      projectRoot: str(),
      projectKey: Type.Optional(str()),
    }),
  ),
];
