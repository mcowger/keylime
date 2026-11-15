import type { Static } from "@sinclair/typebox";
import type {
  SessionTitleSourceSchema,
  SessionHeaderSchema,
  SessionEntryBaseSchema,
  TextContentSchema,
  ImageContentSchema,
  ThinkingContentSchema,
  ToolCallContentSchema,
  AssistantContentBlockSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  CustomMessageSchema,
  BashExecutionMessageSchema,
  DeveloperMessageSchema,
  PythonExecutionMessageSchema,
  FileMentionMessageSchema,
  AgentMessageSchema,
  UiDialogOptionsSchema,
  UiSelectItemSchema,
  UiApprovalPromptSchema,
  UiApprovalAnswerSchema,
  UiAskDialogResultSchema,
  UiFormDialogResultSchema,
  UiDialogValueSchema,
  UiDialogRequestSchema,
  UiPresentationFrameSchema,
  UiCustomFrameSchema,
  ExtensionStatusItemSchema,
  ExtensionWidgetItemSchema,
  SessionMessageEntrySchema,
  ThinkingLevelChangeEntrySchema,
  ModelChangeEntrySchema,
  ServiceTierChangeEntrySchema,
  CompactionEntrySchema,
  BranchSummaryEntrySchema,
  CustomEntrySchema,
  CustomMessageEntrySchema,
  LabelEntrySchema,
  SessionInfoEntrySchema,
  TitleChangeEntrySchema,
  TtsrInjectionEntrySchema,
  SessionInitEntrySchema,
  ModeChangeEntrySchema,
  SessionEntrySchema,
  FileEntrySchema,
  BranchPreviewSchema,
  SessionTreeNodeSchema,
  SessionInfoSchema,
  ArchivedSessionInfoSchema,
  ProjectLaunchConfigSchema,
  ManagedProjectSchema,
  SessionContextSchema,
  CrossSessionHostToolCallSchema,
  CrossSessionHostToolEventSchema,
  ExitedRpcSessionSchema,
  OutboxModeSchema,
  OutboxEntrySchema,
  OutboxUpdateFrameSchema,
} from "./api-contracts/domain";
// Types mirrored from oh-my-pi coding-agent session-entries (v3 format).

// omp-web cannot import the Bun-only @oh-my-pi packages, so the on-disk
// shapes are re-declared here. Legacy pi v1/v2 fields are kept optional.

export type SessionTitleSource = Static<typeof SessionTitleSourceSchema>;

/** File header and session identity; title is folded from the mutable title slot on load. */
export type SessionHeader = Static<typeof SessionHeaderSchema>;

/** Append-history identity and parent link; a null parent marks a root. */
export type SessionEntryBase = Static<typeof SessionEntryBaseSchema>;

export type TextContent = Static<typeof TextContentSchema>;

/**
 * Image block. omp persists the flat {data, mimeType} shape (data may be a
 * `blob:sha256:` reference until resolved); legacy pi entries used the nested
 * Anthropic-style `source` shape. The UI handles both. Tool-result images
 * reach the browser as `url` (`/api/media/<sha256>`, `?thumb=1` for a small
 * preview) instead of inline base64.
 */
export type ImageContent = Static<typeof ImageContentSchema>;

export type ThinkingContent = Static<typeof ThinkingContentSchema>;

export type ToolCallContent = Static<typeof ToolCallContentSchema>;

export type AssistantContentBlock = Static<typeof AssistantContentBlockSchema>;

/** User input; a branchSummary is a display projection, not a branchable prompt. */
export type UserMessage = Static<typeof UserMessageSchema>;

/** Provider/model response with ordered blocks and optional reported token usage. */
export type AssistantMessage = Static<typeof AssistantMessageSchema>;

/** Result correlated to a tool call; partial results are live snapshots. */
export type ToolResultMessage = Static<typeof ToolResultMessageSchema>;

export type CustomMessage = Static<typeof CustomMessageSchema>;

export type BashExecutionMessage = Static<typeof BashExecutionMessageSchema>;

/** System-slot instruction message (steering envelopes, file-mention text). */
export type DeveloperMessage = Static<typeof DeveloperMessageSchema>;

/** User-initiated Python execution via the $ command (omp-only). */
export type PythonExecutionMessage = Static<
  typeof PythonExecutionMessageSchema
>;

/** Auto-read @filepath mentions packed into a single message (omp-only). */
export type FileMentionMessage = Static<typeof FileMentionMessageSchema>;

export type AgentMessage = Static<typeof AgentMessageSchema>;

/** omp's `ExtensionUIDialogOptions` as the runner sends them (no signal or callbacks). */
export type UiDialogOptions = Static<typeof UiDialogOptionsSchema>;

// JSON turns an omitted middle argument into null.

export type UiSelectItem = Static<typeof UiSelectItemSchema>;

/** omp's `ExtensionApprovalPrompt`: a title line then details. */
export type UiApprovalPrompt = Static<typeof UiApprovalPromptSchema>;

export type UiApprovalAnswer = Static<typeof UiApprovalAnswerSchema>;

/** omp's `ExtensionAskDialogSubmitResult`. */
export type UiAskDialogResult = Static<typeof UiAskDialogResultSchema>;

/** omp's `ExtensionFormDialogResult`. */
export type UiFormDialogResult = Static<typeof UiFormDialogResultSchema>;

/** What an omp dialog method returns; a cancel sends no value. */
export type UiDialogValue = Static<typeof UiDialogValueSchema>;

/**
 * A dialog the runner opened: `method` is omp's `ExtensionUIContext` method, `args` its positional
 * arguments. omp-web's own confirms carry string ids. `expiresAt` (epoch ms) is set when it times out.
 */
export type UiDialogRequest = Static<typeof UiDialogRequestSchema>;

/** A presentation call from the runner. */
export type UiPresentationFrame = Static<typeof UiPresentationFrameSchema>;

export type UiCustomFrame = Static<typeof UiCustomFrameSchema>;

export type ExtensionStatusItem = Static<typeof ExtensionStatusItemSchema>;

export type ExtensionWidgetItem = Static<typeof ExtensionWidgetItemSchema>;

export type SessionMessageEntry = Static<typeof SessionMessageEntrySchema>;

export type ThinkingLevelChangeEntry = Static<
  typeof ThinkingLevelChangeEntrySchema
>;

export type ModelChangeEntry = Static<typeof ModelChangeEntrySchema>;

export type ServiceTierChangeEntry = Static<
  typeof ServiceTierChangeEntrySchema
>;

export type CompactionEntry = Static<typeof CompactionEntrySchema>;

export type BranchSummaryEntry = Static<typeof BranchSummaryEntrySchema>;

export type CustomEntry = Static<typeof CustomEntrySchema>;

export type CustomMessageEntry = Static<typeof CustomMessageEntrySchema>;

export type LabelEntry = Static<typeof LabelEntrySchema>;

/** Legacy pi rename entry; omp replaced it with the title slot + title_change. */
export type SessionInfoEntry = Static<typeof SessionInfoEntrySchema>;

/** Append-only audit entry recording a session title change (omp). */
export type TitleChangeEntry = Static<typeof TitleChangeEntrySchema>;

/** Tracks which time-traveling rules have been injected this session (omp). */
export type TtsrInjectionEntry = Static<typeof TtsrInjectionEntrySchema>;

/** Initial context capture for subagent sessions (omp). */
export type SessionInitEntry = Static<typeof SessionInitEntrySchema>;

/** Agent mode transitions, e.g. plan mode (omp). */
export type ModeChangeEntry = Static<typeof ModeChangeEntrySchema>;

/** One append-history record; parentId links it into the session tree. */
export type SessionEntry = Static<typeof SessionEntrySchema>;

export type FileEntry = Static<typeof FileEntrySchema>;

/** Optional role and text shown for a projected branch. */
export type BranchPreview = Static<typeof BranchPreviewSchema>;

/** Tree node indexed by entry ID; projected edges can contain compressed entry IDs. */
export type SessionTreeNode = Static<typeof SessionTreeNodeSchema>;

/** Session listing snapshot; paths belong to the owning host, not necessarily this machine. */
export type SessionInfo = Static<typeof SessionInfoSchema>;

/** Metadata for a gzip-compressed session in OMP's archive tree. */
export type ArchivedSessionInfo = Static<typeof ArchivedSessionInfoSchema>;

/** Workspace-level omp launch configuration; only affects omp children spawned for that workspace. */
export type ProjectLaunchConfig = Static<typeof ProjectLaunchConfigSchema>;

/** A project in the sidebar: an explicitly added directory (registered in the
 *  on-disk registry) or one discovered from existing sessions. Paths are the
 *  canonical projectRoot — worktrees resolve to their main repository. */
export type ManagedProject = Static<typeof ManagedProjectSchema>;

/** Reconstructed selected-branch messages, entry IDs and native intent evidence. */
export type SessionContext = Static<typeof SessionContextSchema>;

/** A host tool call for a session no tab is watching, sent to every open tab. */
export type CrossSessionHostToolCall = Static<
  typeof CrossSessionHostToolCallSchema
>;

export type CrossSessionHostToolEvent = Static<
  typeof CrossSessionHostToolEventSchema
>;

/** An omp child that exited unexpectedly; retained until that session starts again. */
export type ExitedRpcSession = Static<typeof ExitedRpcSessionSchema>;

/** How a held message goes to omp (docs/specs/2026-11-04-message-outbox-design.md O3). */
export type OutboxMode = Static<typeof OutboxModeSchema>;

/** Server-owned intent: acceptance into the outbox is not native admission; uncertain handoffs are not automatically resent. */
export type OutboxEntry = Static<typeof OutboxEntrySchema>;

/** The session channel's outbox snapshot: every entry not yet delivered, in submission order. */
export type OutboxUpdateFrame = Static<typeof OutboxUpdateFrameSchema>;
