import { Type } from "@sinclair/typebox";
import type { HttpOperation } from "./operations";
import {
  jsonBody,
  jsonResponse,
  pathParameter,
  queryParameter,
  webErrors,
  webSecurity,
  ApiErrorSchema,
} from "./http-helpers";
import { ManagedProjectSchema, ProjectLaunchConfigSchema } from "./domain";
import {
  WorkspaceDirectoryListingSchema,
  WorkspaceIndexSchema,
  GitStatusResponseSchema,
  GitFileDiffResponseSchema,
  WorkspaceDirectoryBrowseSchema,
  HierarchyRequestSchema,
  HierarchySnapshotSchema,
  HierarchyProjectSchema,
  WorkspaceWorktreesSchema,
  WorkspaceBranchesSchema,
  WorkspaceCreationSettingsSchema,
  WorkspaceCreationJobSchema,
  WorkspaceCreateRequestSchema,
  WorkspacePrepareRequestSchema,
  WorkspaceSettingsRequestSchema,
  WorkspaceDeleteRequestSchema,
  WorkspaceDeleteResultSchema,
  WorkspaceTerminalSchema,
  TerminalSnapshotSchema,
  ShipPreviewSchema,
  ShipRequestSchema,
  ShipJobSchema,
  ShipStopMonitorRequestSchema,
  ShipStopMonitorResultSchema,
  UploadTargetInspectionSchema,
  CloneFrameSchema,
  CloneProgressSchema,
} from "./workspace-models";
import { SystemsHttpPostSchema, SystemsResultSchema } from "./systems";

const s = Type.String();
const opt = Type.Optional;
const hostId = queryParameter(
  "hostId",
  s,
  false,
  "Owning host; a sessionId binds the request to its authoritative workspace host.",
);
const host = queryParameter("host", s);
const session = queryParameter(
  "sessionId",
  s,
  false,
  "Session ownership selects and confines the workspace; a mismatching host is rejected.",
);
const cwd = queryParameter("cwd", s);
const id = pathParameter("id");
const binary = Type.String({ format: "binary" });
const binaryResponse = (description: string) => ({
  description,
  content: { "application/octet-stream": { schema: binary } },
});
const error = (description: string) =>
  jsonResponse(ApiErrorSchema, description);
const conflict = error(
  "Conflict: the workspace host does not match its session, the upload target exists, or another operation owns the resource.",
);
const responses = (schema: Parameters<typeof jsonResponse>[0]) => ({
  ...webErrors,
  200: jsonResponse(schema),
  409: conflict,
});
const obj = Type.Object;
const nullableString = Type.Union([s, Type.Null()]);
const success = obj({ success: Type.Literal(true) });
const projectUpdate = obj({
  cwd: s,
  alias: opt(nullableString),
  sortOrder: opt(Type.Union([Type.Number(), Type.Null()])),
  pinOrder: opt(Type.Union([Type.Number(), Type.Null()])),
  launchConfig: opt(Type.Union([ProjectLaunchConfigSchema, Type.Null()])),
});
const projects = obj({ projects: Type.Array(ManagedProjectSchema) });
const uploadError = obj({ name: s, error: s, code: opt(s) });
/** Per-file publication outcomes; mixed success does not roll back earlier files. */
export const WorkspaceFilesPublishResultSchema = obj(
  {
    uploaded: Type.Array(s, {
      description: "Names successfully published in the destination directory.",
    }),
    skipped: Type.Array(s, {
      description: "Names skipped by the selected conflict strategy.",
    }),
    errors: Type.Array(uploadError, {
      description:
        "Per-file failures, including failures alongside successful publications.",
    }),
    error: opt(
      Type.String({
        description: "First failure message when every item failed.",
      }),
    ),
    code: opt(
      Type.String({
        description: "First failure code when every item failed, if available.",
      }),
    ),
  },
  {
    description:
      "Publication results for staged uploads; successful items are not rolled back on partial failure.",
  },
);
const uploadResults = WorkspaceFilesPublishResultSchema;
/** Identifies an owner-bound upload generation and its expected byte length. */
export const WorkspaceUploadStartBodySchema = obj(
  {
    id: Type.String({
      description:
        "Client-chosen staged upload identifier; a conflicting owner or metadata cannot resume it.",
    }),
    host: Type.String({
      description: "Identifier of the host storing the staged bytes.",
    }),
    name: Type.String({ description: "Original upload file name." }),
    size: Type.Integer({
      minimum: 0,
      description: "Expected total file size in bytes.",
    }),
    type: Type.String({ description: "Declared media type of the upload." }),
  },
  {
    description:
      "Open or resume an owner-bound upload; id and host identify its staged data.",
  },
);
/** Byte progress and optional authority for claiming this completed generation. */
export const WorkspaceUploadChunkResultSchema = obj(
  {
    received: Type.Integer({
      description:
        "Total staged bytes accepted by the host, and the next required offset.",
    }),
    done: Type.Boolean({
      description: "Whether the declared upload size has been received.",
    }),
    proof: opt(
      Type.String({
        description:
          "Completion proof for claiming this upload generation in a later outbox command; it does not authorize upload writes or cancellation.",
      }),
    ),
  },
  {
    description: "Host-confirmed staged upload progress after a binary chunk.",
  },
);
const uploadStartResult = obj({
  received: Type.Integer(),
  proof: opt(
    Type.String({
      description: "Completion proof when the upload was already complete.",
    }),
  ),
});
const fileRead = obj({ content: s, language: s, size: Type.Number() });
const fileMeta = obj({
  size: Type.Number(),
  language: s,
  mime: s,
  previewKind: Type.Union([
    Type.Literal("pdf"),
    Type.Literal("docx"),
    Type.Null(),
  ]),
});
const terminalResult = obj({
  terminals: opt(Type.Array(WorkspaceTerminalSchema)),
  terminal: opt(WorkspaceTerminalSchema),
  snapshot: opt(s),
  cursor: opt(Type.Number()),
});
const filePath = pathParameter("path", s);
const ops = (
  route: string,
  method: HttpOperation["method"],
  operationId: string,
  summary: string,
  rest: Partial<HttpOperation>,
): HttpOperation => ({
  route,
  path: route
    .replace("[...path]", "{path}")
    .replace("[id]", "{id}")
    .replace("[hash]", "{hash}"),
  method,
  operationId,
  summary,
  security: webSecurity,
  responses: webErrors,
  ...rest,
});

export const workspaceHttpOperations: readonly HttpOperation[] = [
  ops(
    "/api/files/[...path]",
    "get",
    "workspaceFilesGet",
    "List, read, preview or download workspace files",
    {
      description:
        "Session ownership controls the host and accessible roots. List is the default; read returns JSON for text and streamed bytes for media. Preview renders DOCX as sandboxed HTML. Downloads support HTTP Range and stream the file.",
      parameters: [
        filePath,
        hostId,
        session,
        queryParameter("root", s),
        queryParameter(
          "type",
          Type.Union([
            Type.Literal("list"),
            Type.Literal("read"),
            Type.Literal("download"),
            Type.Literal("meta"),
            Type.Literal("preview"),
          ]),
        ),
        { name: "Range", in: "header", required: false, schema: s },
      ],
      responses: {
        ...responses(
          Type.Union([WorkspaceDirectoryListingSchema, fileRead, fileMeta]),
        ),
        200: {
          description:
            "JSON listing, text or metadata; HTML DOCX preview; or media/download bytes.",
          content: {
            "application/json": {
              schema: Type.Union([
                WorkspaceDirectoryListingSchema,
                fileRead,
                fileMeta,
              ]),
            },
            "text/html": { schema: s },
            "application/octet-stream": { schema: binary },
            "image/*": { schema: binary },
            "audio/*": { schema: binary },
            "application/pdf": { schema: binary },
          },
        },
        206: binaryResponse("Partial content selected by Range."),
        413: error("Image or DOCX exceeds the preview limit."),
        416: { description: "Requested byte range is unsatisfiable." },
      },
    },
  ),
  ops(
    "/api/files/[...path]",
    "post",
    "workspaceFilesPost",
    "Inspect or publish staged uploads",
    {
      description:
        "upload-check inspects names; upload consumes staged upload IDs owned by the authenticated requester on the selected host. Mixed successes return 207.",
      parameters: [
        filePath,
        hostId,
        session,
        queryParameter(
          "type",
          Type.Union([Type.Literal("upload"), Type.Literal("upload-check")]),
        ),
        queryParameter(
          "conflict",
          Type.Union([
            Type.Literal("error"),
            Type.Literal("overwrite"),
            Type.Literal("skip"),
          ]),
        ),
      ],
      requestBody: jsonBody(
        Type.Union([
          obj({ hostId: opt(s), fileNames: Type.Array(s) }),
          obj({
            hostId: opt(s),
            uploads: Type.Array(obj({ id: s, name: s }), {
              minItems: 1,
              maxItems: 1000,
            }),
          }),
        ]),
      ),
      responses: {
        ...responses(Type.Union([UploadTargetInspectionSchema, uploadResults])),
        207: jsonResponse(
          uploadResults,
          "Some files failed while others were uploaded or skipped.",
        ),
        413: error("Request or upload exceeds the size limit."),
        409: jsonResponse(
          Type.Union([ApiErrorSchema, uploadResults]),
          "Host mismatch, upload ownership, offset or file conflict.",
        ),
      },
    },
  ),
  ops(
    "/api/file-index",
    "get",
    "workspaceFileIndex",
    "Search workspace file index",
    {
      parameters: [
        hostId,
        session,
        cwd,
        queryParameter("q", s),
        queryParameter("limit", Type.Integer()),
        queryParameter("kind", s),
        queryParameter("refresh", s),
      ],
      responses: responses(WorkspaceIndexSchema),
    },
  ),
  ops(
    "/api/git/status",
    "get",
    "workspaceGitStatus",
    "Get workspace Git status",
    {
      parameters: [hostId, session, cwd],
      responses: responses(GitStatusResponseSchema),
    },
  ),
  ops("/api/git/diff", "get", "workspaceGitDiff", "Get a workspace file diff", {
    parameters: [hostId, session, cwd, queryParameter("path", s)],
    responses: responses(GitFileDiffResponseSchema),
  }),
  ops(
    "/api/github-repo",
    "get",
    "workspaceGithubRepo",
    "Resolve GitHub repository",
    {
      parameters: [hostId, cwd],
      responses: responses(obj({ repo: nullableString })),
    },
  ),
  ops(
    "/api/cwd/browse",
    "get",
    "workspaceBrowseCwd",
    "Browse host directories",
    {
      parameters: [hostId, queryParameter("path", s)],
      responses: responses(WorkspaceDirectoryBrowseSchema),
    },
  ),
  ops(
    "/api/cwd/validate",
    "post",
    "workspaceValidateCwd",
    "Validate a workspace path",
    {
      requestBody: jsonBody(obj({ cwd: s, hostId: opt(s) })),
      responses: responses(
        obj({
          success: Type.Literal(true),
          cwd: s,
          projectRoot: s,
          projectKey: s,
        }),
      ),
    },
  ),
  ops(
    "/api/default-cwd",
    "post",
    "workspaceDefaultCwd",
    "Create a default working directory",
    { parameters: [hostId], responses: responses(obj({ cwd: s })) },
  ),
  ops("/api/home", "get", "workspaceHome", "Get host home directory", {
    parameters: [hostId],
    responses: responses(obj({ home: s })),
  }),
  ops(
    "/api/hierarchy",
    "get",
    "workspaceHierarchyGet",
    "List project hierarchy",
    { parameters: [host], responses: responses(HierarchySnapshotSchema) },
  ),
  ops(
    "/api/hierarchy",
    "post",
    "workspaceHierarchyPost",
    "Change project hierarchy",
    {
      parameters: [],
      requestBody: jsonBody(
        obj({ host: opt(s), input: HierarchyRequestSchema }),
      ),
      responses: responses(HierarchySnapshotSchema),
    },
  ),
  ops(
    "/api/systems",
    "get",
    "workspaceSystemsGet",
    "List Systems and Efforts",
    {
      parameters: [host],
      responses: {
        ...webErrors,
        200: jsonResponse(SystemsResultSchema),
        409: error("The host daemon is drained for maintenance."),
        501: error("The host daemon does not support Systems."),
        504: error("The host did not answer in time."),
      },
    },
  ),
  ops(
    "/api/systems",
    "post",
    "workspaceSystemsPost",
    "Manage Systems and Efforts",
    {
      requestBody: jsonBody(SystemsHttpPostSchema, "At most 384 KiB of JSON."),
      responses: {
        ...responses(SystemsResultSchema),
        409: error(
          "The host rejected the action due to current state or a stale confirmation.",
        ),
        413: error("The request body exceeds 384 KiB."),
        501: error("The host daemon does not support Systems."),
        504: error("The host did not answer in time; the action may have run."),
      },
    },
  ),
  ops(
    "/api/projects",
    "get",
    "workspaceProjectsGet",
    "List projects across hosts",
    { responses: responses(projects) },
  ),
  ops(
    "/api/projects",
    "post",
    "workspaceProjectsPost",
    "Register a host project",
    {
      requestBody: jsonBody(
        obj({
          cwd: s,
          hostId: opt(s),
          launchConfig: opt(
            Type.Union([ProjectLaunchConfigSchema, Type.Null()]),
          ),
        }),
      ),
      responses: responses(
        obj({
          project: Type.Intersect([HierarchyProjectSchema, obj({ hostId: s })]),
        }),
      ),
    },
  ),
  ops(
    "/api/projects",
    "patch",
    "workspaceProjectsPatch",
    "Update project presentation",
    {
      requestBody: jsonBody(
        Type.Union([
          Type.Intersect([projectUpdate, obj({ hostId: opt(s) })]),
          obj({
            hostId: opt(s),
            updates: Type.Array(projectUpdate, { minItems: 1, maxItems: 500 }),
          }),
        ]),
      ),
      responses: responses(projects),
    },
  ),
  ops(
    "/api/projects",
    "delete",
    "workspaceProjectsDelete",
    "Unregister a project",
    {
      requestBody: jsonBody(obj({ cwd: s, hostId: opt(s) })),
      responses: responses(success),
    },
  ),
  ops("/api/projects/clone", "post", "workspaceClonePost", "Clone a project", {
    description:
      "Streams newline-delimited JSON frames until done, cancelled or error. A reset output frame clears previous progress; disconnect cancels the clone. clone_uncertain means inspect the destination before retrying.",
    requestBody: jsonBody(obj({ id: s, parent: s, url: s, hostId: opt(s) })),
    responses: {
      ...webErrors,
      409: conflict,
      413: error("Clone request exceeds 64 KiB."),
      200: {
        description: "NDJSON clone progress frames, one JSON object per line.",
        content: {
          "application/x-ndjson": {
            schema: Type.String({
              description:
                "Each line is a CloneFrame; output frames may also have reset: true.",
            }),
            "x-item-schema": Type.Union([
              CloneFrameSchema,
              obj({
                type: Type.Literal("output"),
                text: s,
                reset: Type.Literal(true),
              }),
            ]),
          },
        },
      },
    },
  }),
  ops(
    "/api/projects/clone",
    "delete",
    "workspaceCloneDelete",
    "Cancel a clone",
    {
      requestBody: jsonBody(obj({ id: s, hostId: opt(s) })),
      responses: {
        ...responses(
          Type.Intersect([
            obj({ ok: Type.Literal(true) }),
            CloneProgressSchema,
          ]),
        ),
        413: error("Clone request exceeds 64 KiB."),
      },
    },
  ),
  ops(
    "/api/worktrees",
    "get",
    "workspaceWorktreesGet",
    "List worktrees or inspect creation",
    {
      parameters: [
        hostId,
        cwd,
        queryParameter(
          "action",
          Type.Union([
            Type.Literal("branches"),
            Type.Literal("settings"),
            Type.Literal("status"),
          ]),
        ),
        queryParameter("projectPath", s),
        queryParameter("id", s),
      ],
      responses: responses(
        Type.Union([
          WorkspaceWorktreesSchema,
          WorkspaceBranchesSchema,
          WorkspaceCreationSettingsSchema,
          WorkspaceCreationJobSchema,
        ]),
      ),
    },
  ),
  ops(
    "/api/worktrees",
    "post",
    "workspaceWorktreesPost",
    "Create or remove a workspace",
    {
      requestBody: jsonBody(
        Type.Union([
          obj({
            hostId: opt(s),
            action: Type.Literal("create"),
            input: WorkspaceCreateRequestSchema,
          }),
          obj({
            hostId: opt(s),
            action: Type.Literal("prepare"),
            input: WorkspacePrepareRequestSchema,
          }),
          obj({
            hostId: opt(s),
            action: Type.Literal("settings"),
            input: WorkspaceSettingsRequestSchema,
          }),
          obj({
            hostId: opt(s),
            action: Type.Literal("delete"),
            input: WorkspaceDeleteRequestSchema,
          }),
        ]),
      ),
      responses: {
        ...responses(
          Type.Union([
            WorkspaceCreationJobSchema,
            WorkspaceCreationSettingsSchema,
            WorkspaceDeleteResultSchema,
          ]),
        ),
        499: error("Request cancelled before workspace creation starts."),
      },
    },
  ),
  ops(
    "/api/terminals",
    "get",
    "workspaceTerminalsGet",
    "List workspace terminals",
    { parameters: [hostId, cwd], responses: responses(terminalResult) },
  ),
  ops("/api/terminals", "post", "workspaceTerminalsPost", "Create a terminal", {
    requestBody: jsonBody(
      obj({
        hostId: s,
        cwd: opt(s),
        cols: opt(Type.Number()),
        rows: opt(Type.Number()),
      }),
    ),
    responses: responses(terminalResult),
  }),
  ops(
    "/api/terminals/[id]",
    "get",
    "workspaceTerminalGet",
    "Get terminal snapshot",
    { parameters: [id, hostId], responses: responses(TerminalSnapshotSchema) },
  ),
  ops(
    "/api/terminals/[id]",
    "post",
    "workspaceTerminalPost",
    "Send terminal input, resize or focus",
    {
      parameters: [id],
      requestBody: jsonBody(
        obj({
          hostId: s,
          action: Type.Union([
            Type.Literal("input"),
            Type.Literal("resize"),
            Type.Literal("focus"),
          ]),
          data: opt(s),
          cols: opt(Type.Number()),
          rows: opt(Type.Number()),
          viewer: opt(s),
          focused: opt(Type.Boolean()),
        }),
      ),
      responses: responses(terminalResult),
    },
  ),
  ops(
    "/api/terminals/[id]",
    "delete",
    "workspaceTerminalDelete",
    "Close a terminal",
    { parameters: [id, hostId], responses: responses(terminalResult) },
  ),
  ops(
    "/api/uploads",
    "post",
    "workspaceUploadStart",
    "Start or resume an upload",
    {
      requestBody: jsonBody(WorkspaceUploadStartBodySchema),
      responses: {
        ...responses(uploadStartResult),
        413: error("Upload request exceeds its limit."),
        409: conflict,
      },
    },
  ),
  ops("/api/uploads/[id]", "put", "workspaceUploadChunk", "Send upload bytes", {
    description:
      "Chunks are owner-bound and acknowledged after the host persists them. A 409 upload_offset response includes the authoritative received offset.",
    parameters: [
      id,
      queryParameter("offset", Type.Integer({ minimum: 0 }), true),
    ],
    requestBody: {
      required: true,
      content: { "application/octet-stream": { schema: binary } },
    },
    responses: {
      ...responses(WorkspaceUploadChunkResultSchema),
      409: jsonResponse(
        obj({ error: s, code: s, received: opt(Type.Integer()) }),
        "Offset mismatch or ownership conflict.",
      ),
      413: error("Chunk exceeds 1 MiB."),
    },
  }),
  ops(
    "/api/uploads/[id]",
    "delete",
    "workspaceUploadDelete",
    "Abort an upload",
    {
      parameters: [id, host],
      responses: {
        ...webErrors,
        204: {
          description:
            "Upload aborted; staged data is removed now or on the host's next connection.",
        },
      },
    },
  ),
  ops("/api/ship", "get", "workspaceShipGet", "Preview shipping a workspace", {
    parameters: [
      host,
      queryParameter("projectPath", s),
      queryParameter("path", s),
    ],
    responses: responses(ShipPreviewSchema),
  }),
  ops("/api/ship", "post", "workspaceShipPost", "Start shipping a workspace", {
    description:
      "PR modes may opt into feedback links with monitorSessionId for a chat in the same workspace. The host must support shipMonitorStatus. The server issues the grant and checks that the same watch is still active before accepting feedback. Job acceptance does not mean monitoring has started, and monitoring does not gate merges.",
    requestBody: jsonBody(obj({ host: opt(s), input: ShipRequestSchema })),
    responses: {
      ...responses(ShipJobSchema),
      501: error("The host daemon does not support PR monitoring."),
    },
  }),
  ops("/api/ship/[id]", "get", "workspaceShipStatus", "Get ship job status", {
    parameters: [id, host],
    responses: responses(ShipJobSchema),
  }),
  ops(
    "/api/ship/finish",
    "post",
    "workspaceShipFinish",
    "Finish shipping a workspace",
    {
      requestBody: jsonBody(obj({ host: opt(s), projectPath: s, path: s })),
      responses: responses(ShipJobSchema),
    },
  ),
  ops(
    "/api/ship/monitor/stop",
    "post",
    "workspaceShipMonitorStop",
    "Stop PR feedback monitoring",
    {
      description:
        "Revokes the scoped server grant before attempting to stop the daemon watch. An offline or rejected host stop does not restore the grant.",
      requestBody: jsonBody(
        obj({ host: opt(s), ...ShipStopMonitorRequestSchema.properties }),
      ),
      responses: responses(ShipStopMonitorResultSchema),
    },
  ),
  ops(
    "/api/media/[hash]",
    "get",
    "workspaceMediaGet",
    "Get a content-addressed image",
    {
      description:
        "thumb is presence-based and requests a WebP thumbnail; if thumbnail generation fails the original image is returned. Hash is SHA-256.",
      parameters: [
        pathParameter("hash", Type.String({ pattern: "^[a-f0-9]{64}$" })),
        queryParameter("thumb", s),
      ],
      responses: {
        200: {
          description:
            "Image bytes; private immutable cache except fallback thumbnails.",
          content: {
            "image/*": { schema: binary },
            "image/webp": { schema: binary },
          },
        },
        404: {
          description: "Not found",
          content: { "text/plain": { schema: s } },
        },
        415: {
          description: "Not an image",
          content: { "text/plain": { schema: s } },
        },
      },
    },
  ),
];
