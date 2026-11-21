import { Type, type Static, type TSchema } from "@sinclair/typebox";
import {
  AgentMessageSchema,
  ArchivedSessionInfoSchema,
  ExitedRpcSessionSchema,
  OutboxEntrySchema,
  SessionInfoSchema,
} from "./domain";
import {
  SessionReadValueSchema,
  SessionHistoryContinuationSchema,
  SubagentHistoryValueSchema,
  SubagentTranscriptValueSchema,
  ThinkingReadValueSchema,
} from "./host-session-operations";
import {
  AgentCommandResultSchema,
  AgentCommandSchema,
  NewAgentCommandSchema,
  agentOperations,
} from "./runner-messages";
import { BrowserListSchema } from "./host-control-operations";
import {
  BrowserControlArgsSchema,
  BrowserControlResultSchema,
} from "./runner-lifecycle";
import {
  BrowserVideoRequestSchema,
  BrowserVideoStartResultSchema,
  BrowserVideoNextResultSchema,
  BrowserVideoStopResultSchema,
} from "./runner-lifecycle";
import {
  ApiErrorSchema,
  jsonBody,
  jsonResponse,
  pathParameter,
  queryParameter,
  webErrors,
  webSecurity,
} from "./http-helpers";
import type { HttpOperation } from "./operations";

const str = () => Type.String();
const nullable = (schema: TSchema) => Type.Union([schema, Type.Null()]);
const sessionLocalFile = Type.Object({ path: str(), sessionId: str() });
export type SessionLocalFile = Static<typeof sessionLocalFile>;
const id = pathParameter("id");
const q = (name: string, description?: string, required = false) =>
  queryParameter(name, str(), required, description);
const targetHost = q("hostId", "Owning host; omission selects local only.");
const commands = AgentCommandSchema;
const commandResults = Type.Union([AgentCommandResultSchema, Type.Null()]);
const stateResult =
  agentOperations.find((operation) => operation.name === "get_state")?.result ??
  commandResults;
const agentState = Type.Object({
  running: Type.Boolean(),
  state: Type.Optional(stateResult),
  recovered: Type.Optional(Type.Boolean()),
});
export type AgentStateResponse = Static<typeof agentState>;
const runningSession = Type.Object({
  id: str(),
  cwd: str(),
  hostId: str(),
  awaitingInput: Type.Optional(Type.Literal(true)),
});
const transcriptSearchBatch = Type.Object({
  scores: Type.Array(
    Type.Object({ hostId: str(), sessionId: str(), score: Type.Number() }),
  ),
});
export type TranscriptSearchBatch = Static<typeof transcriptSearchBatch>;
const errorWithRecovery = Type.Object({
  ...ApiErrorSchema.properties,
  host: Type.Optional(
    Type.String({
      description: "Host whose availability prevented the operation.",
    }),
  ),
  sessionId: Type.Optional(
    Type.String({
      description:
        "Created session identifier, when creation succeeded before a later failure.",
    }),
  ),
});
const err = (description: string) =>
  jsonResponse(errorWithRecovery, description);
const extras = {
  409: err(
    "Conflict: the session is busy, has active children, or a restore is unconfirmed.",
  ),
  413: err("Request, session file, or output exceeds its size limit."),
  502: err(
    "The host did not confirm the operation; a restore may still be running.",
  ),
  504: err("The host operation timed out; delivery may be unknown."),
};
const responses = (schema: TSchema) => ({
  ...webErrors,
  ...extras,
  200: jsonResponse(schema),
});
const binary = (media: string, description: string) => ({
  description,
  content: { [media]: { schema: Type.String() } },
});
const cursor = Type.Object({
  firstEntryId: nullable(
    Type.String({
      description:
        "First entry in the selected display history; used to detect a changed history.",
    }),
  ),
  lastEntryId: nullable(
    Type.String({
      description:
        "Last delivered entry in this session and selected view; continue with the returned cursor.",
    }),
  ),
});
const live = Type.Object({
  cursor: Type.Object({ streamId: str(), sequence: Type.Number() }),
  isStreaming: Type.Boolean(),
  isPromptRunning: Type.Boolean(),
  isCompacting: Type.Boolean(),
  streamingMessage: nullable(Type.Partial(AgentMessageSchema)),
  streamingMessageId: Type.Optional(nullable(str())),
  toolEvents: Type.Array(
    Type.Object(
      {
        type: Type.Union([
          Type.Literal("tool_execution_start"),
          Type.Literal("tool_execution_update"),
        ]),
        toolCallId: str(),
      },
      { additionalProperties: true },
    ),
  ),
  responseObserved: Type.Optional(Type.Boolean()),
});
const history = Type.Object({
  mode: Type.Union([Type.Literal("append"), Type.Literal("replace")], {
    description:
      "Append to the acknowledged history, or replace it when its branch or compaction boundary changed.",
  }),
  baseEntryId: nullable(
    Type.String({
      description: "Entry immediately preceding this page, if any.",
    }),
  ),
  context: SessionReadValueSchema.properties.context,
  cursor,
  hasMore: Type.Boolean({
    description:
      "More selected history remains; request another page using cursor.",
  }),
  sessionId: Type.String({
    description: "Session to which this cursor and history belong.",
  }),
  leafId: nullable(
    Type.String({
      description:
        "Selected history leaf, or null if the selected history is empty.",
    }),
  ),
  live: nullable(live),
});
const match = Type.Object({
  entryId: str(),
  ordinal: Type.Number(),
  quality: Type.Number(),
  timestamp: nullable(Type.Number()),
  before: str(),
  match: str(),
  after: str(),
});
const outbox = {
  outbox: Type.Array(OutboxEntrySchema, {
    description:
      "Held messages in the web outbox; acceptance does not itself establish delivery to omp.",
  }),
  outboxScope: Type.String({
    description:
      "Credential-bound namespace identifying the web outbox for reconciliation; it changes when the web auth secret changes.",
  }),
  outboxSettledIds: Type.Array(Type.String(), {
    description: "Client message IDs settled by the web outbox.",
  }),
  nativeSettledIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Client message IDs reported settled by native processing, when available.",
    }),
  ),
};
const sessionState = Type.Object({
  ...outbox,
  running: Type.Optional(Type.Boolean()),
  state: Type.Optional(stateResult),
  recovered: Type.Optional(Type.Boolean()),
  exited: Type.Optional(ExitedRpcSessionSchema),
  error: Type.Optional(str()),
  code: Type.Optional(str()),
  hostOffline: Type.Optional(Type.Boolean()),
});
const op = (
  route: string,
  method: HttpOperation["method"],
  operationId: string,
  summary: string,
  options: Partial<HttpOperation> & Pick<HttpOperation, "responses">,
): HttpOperation => ({
  path: route.replace(/\[([^\]]+)\]/g, "{$1}"),
  route,
  method,
  operationId,
  summary,
  security: webSecurity,
  ...options,
  ...((route === sid ||
    route.startsWith(`${sid}/`) ||
    route === aid ||
    route.startsWith(`${aid}/`)) &&
  !options.parameters?.some(({ name }) => name === "hostId")
    ? { parameters: [...(options.parameters ?? []), targetHost] }
    : {}),
});
const sid = "/api/sessions/[id]";
const aid = "/api/agent/[id]";

/** HTTP operations are bound to their handlers by @apiContract. */
export const sessionHttpOperations: readonly HttpOperation[] = [
  op(
    `${sid}/browser`,
    "get",
    "listSessionBrowserTabs",
    "List live session browser tabs",
    {
      description:
        "Discovers tabs owned by the already-live session without starting a runner or browser.",
      parameters: [id],
      responses: {
        ...responses(BrowserListSchema),
        429: err(
          "A discovery request is already in progress for this session.",
        ),
      },
    },
  ),
  op(
    `${sid}/browser/frame`,
    "get",
    "captureSessionBrowserFrame",
    "Capture a browser tab frame",
    {
      description:
        "Captures one JPEG from a tab owned by the live session. X-Browser-Viewport-Width and X-Browser-Viewport-Height report CSS viewport dimensions. This read-only request does not change browser lifecycle.",
      parameters: [id, q("tabId", "A tab ID returned by discovery.", true)],
      responses: {
        ...webErrors,
        ...extras,
        429: err("A frame capture is already in progress for this session."),
        200: binary("image/jpeg", "A single uncached JPEG frame."),
      },
    },
  ),
  op(
    `${sid}/browser/video`,
    "post",
    "sessionBrowserVideo",
    "Stream session browser video",
    {
      description:
        "Starts, pulls bounded encoded packets from, or stops an ephemeral session-owned browser stream. Responses are never cached.",
      parameters: [id],
      requestBody: jsonBody(BrowserVideoRequestSchema),
      responses: responses(
        Type.Union([
          BrowserVideoStartResultSchema,
          BrowserVideoNextResultSchema,
          BrowserVideoStopResultSchema,
        ]),
      ),
    },
  ),
  op(
    `${sid}/browser/control`,
    "post",
    "controlSessionBrowserTab",
    "Control a session browser tab",
    {
      description:
        "Applies 1–64 navigation or input actions in array order to a session-owned tab; request bodies are capped at 1 MiB. The whole batch is validated before dispatch. A failed request may have applied a prefix; never automatically retry it or the remaining actions.",
      parameters: [id],
      requestBody: jsonBody(BrowserControlArgsSchema),
      responses: responses(BrowserControlResultSchema),
    },
  ),
  op("/api/sessions", "get", "listSessions", "List sessions across hosts", {
    description:
      "runningSessions is host-qualified; runningSessionIds contains only IDs from the selected host, or local for combined discovery.",
    parameters: [
      q("id", "Filter to a session on hostId, or local if hostId is omitted."),
      q(
        "hostId",
        "Filter inventories by host. Omit for combined discovery when no ID is supplied.",
      ),
      { name: "If-None-Match", in: "header", required: false, schema: str() },
    ],
    responses: {
      ...responses(
        Type.Object({
          sessions: Type.Array(SessionInfoSchema),
          runningSessionIds: Type.Array(str()),
          runningSessions: Type.Array(runningSession),
        }),
      ),
      304: { description: "Unfiltered session list has not changed." },
    },
  }),
  op(
    "/api/sessions/search",
    "get",
    "searchSessions",
    "Search local session transcripts",
    {
      description:
        "Pull-driven NDJSON. Each batch contains scores for registered sessions on the web host only, identified by hostId and sessionId. Cancellation stops the scan. Metadata search is separate.",
      parameters: [q("q", "Search text, maximum 500 characters.")],
      responses: {
        ...webErrors,
        200: {
          description: "Stream of newline-delimited JSON batches.",
          content: {
            "application/x-ndjson": {
              schema: transcriptSearchBatch,
            },
          },
        },
      },
    },
  ),
  op(
    "/api/sessions/import",
    "post",
    "importSession",
    "Import a native session JSONL file",
    {
      description:
        "The header cwd must be authorized; the imported session receives a new ID. Decoded content is limited to 10 MiB.",
      requestBody: jsonBody(Type.Object({ fileName: str(), content: str() })),
      responses: responses(
        Type.Object({ success: Type.Literal(true), sessionFile: str() }),
      ),
    },
  ),
  op(
    "/api/sessions/archive",
    "get",
    "listSessionArchives",
    "List archived sessions",
    {
      parameters: [
        q(
          "hostId",
          "List archives only on this host; omit for combined discovery.",
        ),
      ],
      responses: responses(
        Type.Object({
          archives: Type.Array(ArchivedSessionInfoSchema),
          unavailableHosts: Type.Array(
            Type.Object({ id: str(), label: str() }),
          ),
        }),
      ),
    },
  ),
  op(
    "/api/sessions/archive",
    "post",
    "restoreSessionArchive",
    "Restore an archived session",
    {
      description:
        "Checks the selected host's fresh inventory for an active session with the same ID. An unconfirmed restore may still be running and remains blocked until its owning daemon confirms it stopped; restorePending archives are discovery evidence, not restore targets.",
      requestBody: jsonBody(
        Type.Object({ key: str(), hostId: Type.Optional(str()) }),
      ),
      responses: {
        ...responses(Type.Object({ ok: Type.Literal(true), sessionId: str() })),
        409: err(
          "Session already active on this host, archive_restore_busy, or archive_restore_unconfirmed.",
        ),
        503: err(
          "The target host is offline or its active inventory is unavailable.",
        ),
      },
    },
  ),
  op(sid, "get", "getSession", "Read session details", {
    parameters: [
      id,
      q("includeState", "Include live agent state if available."),
      q("deferThinking"),
      q("deferMedia"),
      q(
        "tail",
        "Return at most this many newest active-branch display entries (1–200).",
      ),
      q(
        "before",
        "Exclusive oldest entry ID from a preceding tail response; requires tail and historyRevision.",
      ),
      q(
        "historyRevision",
        "Opaque revision from the first page; required with before.",
      ),
    ],
    responses: {
      ...responses(
        Type.Union([
          Type.Object({
            ...SessionReadValueSchema.properties,
            sessionId: str(),
            hostId: str(),
            agent: Type.Optional(agentState),
          }),
          Type.Object({
            ...SessionHistoryContinuationSchema.properties,
            sessionId: str(),
            hostId: str(),
            agent: Type.Optional(agentState),
          }),
        ]),
      ),
      400: err("Invalid tail, before or historyRevision parameters."),
      409: err(
        "session_history_changed: discard partial pages and synchronize again.",
      ),
    },
  }),
  op(sid, "patch", "renameSession", "Rename a session", {
    parameters: [id],
    requestBody: jsonBody(Type.Object({ name: str() })),
    responses: responses(Type.Object({ ok: Type.Literal(true) })),
  }),
  op(sid, "delete", "deleteSession", "Delete a session", {
    parameters: [id],
    responses: responses(
      Type.Object({
        ok: Type.Literal(true),
        skippedChildren: Type.Optional(
          Type.Array(Type.Object({ id: str(), reason: str() })),
        ),
      }),
    ),
  }),
  op(`${sid}/state`, "get", "getSessionState", "Read live state and outbox", {
    description:
      "All responses, including offline errors, carry the outbox snapshot and settlement IDs.",
    parameters: [id],
    responses: {
      ...responses(sessionState),
      503: jsonResponse(sessionState, "Host offline, with outbox snapshot."),
    },
  }),
  op(`${sid}/archive`, "post", "archiveSession", "Archive a session", {
    description:
      "Stops the live child and archives the session and artifacts; children must be archived first.",
    parameters: [id],
    responses: responses(
      Type.Object({
        ok: Type.Literal(true),
        archived: Type.Literal(true),
        archivedPath: str(),
      }),
    ),
  }),
  op(
    `${sid}/auto-name`,
    "post",
    "autoNameSession",
    "Generate or derive a session title",
    {
      parameters: [id],
      responses: responses(
        Type.Object({
          title: str(),
          generated: Type.Boolean(),
          usage: Type.Null(),
        }),
      ),
    },
  ),
  op(
    `${sid}/context`,
    "get",
    "getSessionContext",
    "Read session context or synchronized history",
    {
      description:
        "boundary=1 returns active entry IDs and cannot be combined with sync, leafId, includePreCompaction, cursor or limit. sync=1 returns a history page and optional live snapshot. Deferred flags are enabled by presence.",
      parameters: [
        id,
        q("leafId"),
        q("deferThinking"),
        q("deferMedia"),
        q("includePreCompaction"),
        q("boundary"),
        q("sync"),
        q("cursor", "JSON-encoded history cursor."),
        q("limit", "Maximum page size, up to 200."),
      ],
      responses: responses(
        Type.Union([
          Type.Object({ entryIds: Type.Array(str()) }),
          Type.Object({ context: SessionReadValueSchema.properties.context }),
          history,
        ]),
      ),
    },
  ),
  op(
    `${sid}/entries/[entryId]/thinking`,
    "get",
    "getSessionThinking",
    "Read a deferred thinking block",
    {
      parameters: [
        id,
        pathParameter("entryId"),
        queryParameter("blockIndex", Type.Integer({ minimum: 0 }), true),
      ],
      responses: responses(ThinkingReadValueSchema),
    },
  ),
  op(`${sid}/export`, "get", "exportSession", "Export session as HTML", {
    description:
      "inline=1 is honored only for the local host; remote HTML is always downloaded.",
    parameters: [id, q("inline")],
    responses: {
      ...webErrors,
      ...extras,
      200: binary("text/html", "Self-contained HTML export."),
    },
  }),
  op(
    `${sid}/local-file`,
    "get",
    "resolveSessionLocalFile",
    "Resolve a session local URI",
    {
      parameters: [
        id,
        q("uri", "local:// URI, confined by the owning host.", true),
      ],
      responses: responses(sessionLocalFile),
    },
  ),
  op(
    `${sid}/matches`,
    "get",
    "getSessionMatches",
    "Find ranked matches in a session",
    {
      description:
        "Returns the best prefix, not an offset page; results may be reranked as the session changes.",
      parameters: [
        id,
        q("q", "Query, maximum 500 characters."),
        q("limit", "Positive result limit up to 1000."),
      ],
      responses: responses(
        Type.Object({ matches: Type.Array(match), total: Type.Number() }),
      ),
    },
  ),
  op(
    `${sid}/subagents`,
    "get",
    "listSessionSubagents",
    "List recovered subagent history",
    { parameters: [id], responses: responses(SubagentHistoryValueSchema) },
  ),
  op(
    `${sid}/subagents/[subagentId]`,
    "get",
    "getSessionSubagent",
    "Read a subagent transcript or completion",
    {
      parameters: [
        id,
        pathParameter("subagentId"),
        q("fromByte", "Transcript byte cursor; defaults to zero."),
        q(
          "mode",
          "completion reads the final artifact instead of a transcript page.",
        ),
      ],
      responses: responses(SubagentTranscriptValueSchema),
    },
  ),
  op(
    "/api/agent/new",
    "post",
    "createAgentSession",
    "Create and initialize an agent session",
    {
      description:
        "A registered host and cwd select the target. Workspace preparation and uploads are separate operations. ensure_session initializes without submitting a prompt. A host-offline failure after creation includes sessionId and delivery metadata.",
      requestBody: jsonBody(
        Type.Intersect([
          NewAgentCommandSchema,
          Type.Object({
            cwd: str(),
            hostId: Type.Optional(str()),
            workspaceId: Type.Optional(str()),
            projectId: Type.Optional(str()),
            provider: Type.Optional(str()),
            modelId: Type.Optional(str()),
            chatRole: Type.Optional(str()),
            toolNames: Type.Optional(Type.Array(str())),
            thinkingLevel: Type.Optional(str()),
            advisor: Type.Optional(Type.Boolean()),
            name: Type.Optional(str()),
          }),
        ]),
      ),
      responses: {
        ...responses(
          Type.Object({
            success: Type.Literal(true),
            sessionId: str(),
            data: commandResults,
          }),
        ),
        400: err(
          "Invalid creation intent, command, workspace target, images, JSON, or RPC command.",
        ),
        503: err(
          "Host offline; sessionId and delivery may indicate an already-created session.",
        ),
      },
    },
  ),
  op(aid, "post", "sendAgentCommand", "Send an agent command", {
    description:
      "Commands are forwarded to the agent, except web-owned outbox and status commands. Timing headers report request receipt and response time.",
    parameters: [
      id,
      q("advisor", "1 enables advisor when spawning or replacing the process."),
    ],
    requestBody: jsonBody(commands),
    responses: responses(
      Type.Object({ success: Type.Literal(true), data: commandResults }),
    ),
  }),
  op(aid, "get", "getAgentState", "Read agent state", {
    parameters: [id],
    responses: responses(agentState),
  }),
  op(
    `${aid}/bash-output`,
    "get",
    "getAgentBashOutput",
    "Read or download bash output",
    {
      parameters: [
        id,
        q("path", "Output path.", true),
        targetHost,
        q("download", "1 streams the complete output as an attachment."),
      ],
      responses: {
        ...responses(
          Type.Object({
            success: Type.Literal(true),
            data: Type.Object({ output: str() }),
          }),
        ),
        200: {
          description: "JSON output or streamed text attachment.",
          content: {
            "application/json": {
              schema: Type.Object({
                success: Type.Literal(true),
                data: Type.Object({ output: str() }),
              }),
            },
            "text/plain": { schema: str() },
          },
        },
        413: jsonResponse(
          Type.Object({
            error: str(),
            data: Type.Object({ size: Type.Number(), maxBytes: Type.Number() }),
          }),
          "Output too large to display; download instead.",
        ),
      },
    },
  ),
];
