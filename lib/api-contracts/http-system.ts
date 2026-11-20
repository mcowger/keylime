import { Type, type TSchema } from "@sinclair/typebox";
import type { HttpOperation } from "./operations";
import {
  jsonBody,
  jsonResponse,
  pathParameter,
  queryParameter,
  webErrors,
  webSecurity,
} from "./http-helpers";
import { EventStreamChannelSchema } from "./browser-link";
import {
  StageHostArtifactArgsSchema,
  StageHostArtifactResultSchema,
  ActivateHostArtifactArgsSchema,
  HostArtifactActivationArgsSchema,
  HostArtifactActivationResultSchema,
  HostReleaseListSchema,
  DeployHostReleaseArgsSchema,
  HostReleaseDeployFrameSchema,
} from "./host-control-models";
import {
  NotificationHistoryEntrySchema,
  NotificationPrefsSchema,
} from "./notification-models";
import { ProjectRegistryEntrySchema } from "./host-session-operations";

const S = Type.String(),
  N = Type.Number(),
  B = Type.Boolean(),
  Nil = Type.Null();
const ns = Type.Union([S, Nil]);
const literals = (...values: string[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const obj = Type.Object;
const ok = obj({ ok: Type.Literal(true) });
const error = obj({ error: S, code: Type.Optional(S) });
const fail = (description: string) => jsonResponse(error, description);
const errors = {
  ...webErrors,
  409: fail("Conflict with current state or host capabilities."),
  413: fail("Request exceeds the endpoint's size limit."),
  415: fail("Content-Type must be application/json."),
  429: fail("Too many active transcription jobs."),
  501: fail("Speech transcription is not configured."),
  502: fail("Upstream push or host request failed."),
};
const noContent = { description: "No content." };
const poolProject = Type.Intersect([
  Type.Omit(ProjectRegistryEntrySchema, ["path"]),
  obj({
    id: S,
    name: S,
    origin: S,
    defaultRef: Type.Optional(S),
    clonePaths: Type.Record(S, S),
  }),
]);
const pool = obj({
  id: S,
  label: S,
  enabled: B,
  members: Type.Array(
    obj({ hostId: S, projectsRoot: S, provisioned: B, draining: B }),
  ),
  projects: Type.Array(poolProject),
});
const pools = Type.Array(pool);
const hostBase = {
  id: S,
  label: S,
  status: literals("online", "offline", "needs-upgrade", "omp-missing"),
  ompVersion: ns,
  keylimeVersion: Type.Optional(ns),
  platform: ns,
  lastSeenAt: ns,
  hostVersion: Type.Union([N, Nil]),
  serverVersion: N,
  workspaceOps: Type.Array(S),
  canStageArtifact: Type.Optional(
    Type.Boolean({
      description:
        "The daemon advertised artifact staging. Omitted if unsupported; availability also requires a live link.",
    }),
  ),
  canActivateArtifact: Type.Optional(Type.Boolean({ description: "The linked standalone daemon advertised artifact activation." })),
  arch: Type.Optional(Type.String({ description: "CPU architecture for selecting a compatible host release." })),
};
const host = Type.Union([
  obj({
    ...hostBase,
    id: Type.Literal("local"),
    lastSeenAt: Nil,
    serverPlatform: S,
    daemonManaged: B,
  }),
  obj({
    ...hostBase,
  }),
]);
const poolResult = obj({ pools });
const history = NotificationHistoryEntrySchema;
const prefs = NotificationPrefsSchema;
const subscription = obj({ endpoint: S, keys: obj({ p256dh: S, auth: S }) });
const sttJob = obj({
  id: S,
  status: literals("pending", "done", "error", "gone"),
  error: Type.Optional(S),
});
const sttClaim = Type.Intersect([
  sttJob,
  obj({
    text: Type.Optional(S),
    after: Type.Optional(literals("send", "steer", "followup")),
  }),
]);
const totalFields = {
  totalCost: N,
  totalTokens: N,
  inputTokens: N,
  outputTokens: N,
  reasoningTokens: N,
  cacheReadTokens: N,
  cacheWriteTokens: N,
  cacheSavings: N,
  activeDays: N,
  tokensPerActiveDay: N,
  cachePercentage: N,
  costQuality: obj({ providerReported: N, modelPriced: N, unpriced: N }),
};
const usage = obj({
  timeRange: literals("today", "7d", "30d", "90d", "month", "all"),
  granularity: literals("daily", "monthly", "projects"),
  summary: obj(totalFields),
  providers: Type.Array(
    obj({ provider: S, name: S, cost: N, tokens: N, share: N, color: S }),
  ),
  timeSeries: Type.Array(
    obj({
      date: S,
      label: S,
      timestamp: N,
      totalCost: N,
      totalTokens: N,
      byProvider: Type.Record(S, obj({ cost: N, tokens: N })),
    }),
  ),
  modelBreakdown: Type.Array(
    obj({
      model: S,
      provider: S,
      cost: N,
      tokens: N,
      inputTokens: N,
      outputTokens: N,
      cacheReadTokens: N,
      cacheWriteTokens: N,
      reasoningTokens: N,
      share: N,
      recordsCount: N,
    }),
  ),
  dayBreakdown: Type.Array(
    obj({
      date: S,
      label: S,
      cost: N,
      tokens: N,
      inputTokens: N,
      outputTokens: N,
      cacheReadTokens: N,
      share: N,
    }),
  ),
  projectBreakdown: Type.Array(
    obj({
      project: S,
      projectName: S,
      cost: N,
      tokens: N,
      share: N,
      sessionsCount: N,
    }),
  ),
  scanInfo: obj({
    transcriptsScanned: N,
    transcriptsOutsideWindow: N,
    usageRecordsCount: N,
    durationSeconds: N,
    scannedAt: N,
  }),
});
const id = pathParameter("id"),
  jobId = pathParameter("jobId");
/** Subscription control sent to POST /api/events for an existing SSE connection. */
const eventRequest = Type.Union(
  [
    obj(
      {
        connectionId: Type.String({
          description: "Connection ID from the stream's hello frame.",
        }),
        subscribe: obj(
          {
            id: Type.String({
              pattern: "^s[0-9]{1,15}$",
              description:
                "Subscription ID, also used as the SSE event name for channel payloads.",
            }),
            channel: {
              ...EventStreamChannelSchema,
              description: "Channel and parameters to subscribe to.",
            },
          },
          { description: "Subscription to attach to the connection." },
        ),
      },
      { description: "Attach a channel subscription." },
    ),
    obj(
      {
        connectionId: Type.String({
          description: "Connection ID from the stream's hello frame.",
        }),
        unsubscribe: Type.String({
          description: "ID of the subscription to detach.",
        }),
      },
      { description: "Detach a channel subscription." },
    ),
  ],
  {
    description:
      "Attach or detach a subscription on a multiplexed SSE connection.",
  },
);
/** HTTP subscription control request; the connection must already have opened. */
export const EventStreamRequestSchema = eventRequest;
/** Control payloads delivered on the mux event over SSE or the browser WebSocket link. */
export const MuxControlFrameSchema = Type.Union(
  [
    obj(
      {
        type: Type.Literal("hello"),
        connectionId: Type.String({
          description:
            "Identifier used to attach subscriptions to this connection.",
        }),
        serverId: Type.String({
          description:
            "Server instance identifier used to distinguish server restarts.",
        }),
        transport: Type.Union([Type.Literal("sse"), Type.Literal("ws")], {
          description: "Configured browser transport.",
        }),
      },
      {
        description:
          "Initial connection identity and browser transport setting.",
      },
    ),
    obj(
      {
        type: Type.Literal("open"),
        sub: Type.String({
          description: "ID of the subscription that opened.",
        }),
      },
      { description: "A subscription is ready to deliver events." },
    ),
    obj(
      {
        type: Type.Literal("end"),
        sub: Type.String({ description: "ID of the subscription that ended." }),
      },
      { description: "A subscription ended on the server." },
    ),
    obj(
      {
        type: Type.Literal("refused"),
        sub: Type.String({ description: "ID of the refused subscription." }),
        status: Type.Number({
          description: "HTTP-style status for the refusal.",
        }),
        error: Type.String({ description: "Human-readable refusal reason." }),
        code: Type.String({ description: "Machine-readable refusal code." }),
      },
      { description: "A browser-link subscription request was refused." },
    ),
    obj(
      {
        type: Type.Literal("transport"),
        transport: Type.Union([Type.Literal("sse"), Type.Literal("ws")], {
          description: "Updated configured browser transport.",
        }),
      },
      { description: "The configured browser transport changed." },
    ),
  ],
  { description: "Multiplexed connection and subscription control frame." },
);
const operations: HttpOperation[] = [];
function add(
  route: string,
  method: HttpOperation["method"],
  operationId: string,
  summary: string,
  success: TSchema | null,
  options: {
    parameters?: readonly Record<string, unknown>[];
    body?: TSchema;
    status?: number;
    description?: string;
    responses?: Record<string, unknown>;
    requestBody?: Record<string, unknown>;
  } = {},
) {
  operations.push({
    path: route.replace(/\[([^\]]+)\]/g, "{$1}"),
    route,
    method,
    operationId,
    summary,
    description: options.description,
    parameters: options.parameters,
    requestBody:
      options.requestBody ??
      (options.body ? jsonBody(options.body) : undefined),
    responses: {
      ...errors,
      [options.status ?? 200]: success ? jsonResponse(success) : noContent,
      ...options.responses,
    },
    security: webSecurity,
  });
}
add(
  "/api/hosts",
  "get",
  "getHosts",
  "List hosts and pools",
  obj({
    hosts: Type.Array(host),
    pools,
  }),
);
add("/api/hosts/[id]/terminal-sessions", "get", "getHostsIdTerminalSessions", "List live session terminals", obj({ sessionIds: Type.Array(S) }), { parameters: [id] });
add(
  "/api/hosts/[id]/artifacts",
  "post",
  "stageHostArtifact",
  "Stage an artifact on the selected daemon",
  StageHostArtifactResultSchema,
  {
    parameters: [id],
    body: StageHostArtifactArgsSchema,
    responses: {
      501: fail("The selected daemon does not support artifact staging."),
      503: fail(
        "The link is unavailable; staging may have completed if the link dropped during the request.",
      ),
      504: fail("The daemon did not confirm staging in time."),
    },
  },
);
add(
  "/api/hosts/[id]/artifacts",
  "patch",
  "activateHostArtifact",
  "Install a staged binary and restart the standalone daemon",
  HostArtifactActivationResultSchema,
  {
    parameters: [id],
    body: ActivateHostArtifactArgsSchema,
    status: 202,
    responses: {
      501: fail("The selected daemon does not support artifact activation."),
      503: fail("The link is unavailable; if the request was sent, reconcile by operation ID."),
      504: fail("Activation was not confirmed; reconcile by operation ID."),
    },
  },
);
add(
  "/api/hosts/[id]/artifacts",
  "get",
  "getHostArtifactActivation",
  "Read a standalone daemon activation outcome",
  HostArtifactActivationResultSchema,
  {
    parameters: [id, queryParameter("operationId", HostArtifactActivationArgsSchema.properties.operationId, true)],
    responses: {
      501: fail("The selected daemon does not support artifact activation status."),
      503: fail("The link is unavailable. Retry the read, not the install."),
      504: fail("The daemon did not confirm the status in time."),
    },
  },
);
add(
  "/api/hosts/[id]/releases", "get", "listHostReleases",
  "List compatible standalone host releases", HostReleaseListSchema,
  { parameters: [id], responses: { 501: fail("This host does not support paired releases."), 503: fail("The host is offline.") } },
);
add(
  "/api/hosts/[id]/releases", "post", "deployHostRelease",
  "Deploy a matched daemon and runner to a linked host", null,
  {
    parameters: [id], body: DeployHostReleaseArgsSchema,
    responses: {
      200: {
        description: "NDJSON deployment updates, one JSON object per line. Failures after streaming begins are error frames, not HTTP status changes.",
        content: {
          "application/x-ndjson": {
            schema: Type.String({ description: "Each line is one HostReleaseDeployFrame." }),
            "x-item-schema": HostReleaseDeployFrameSchema,
          },
        },
      },
    },
  },
);
add("/api/terminal/attach", "get", "getTerminalAttach", "Attach to a session terminal", null, {
  parameters: [queryParameter("hostId", S, true), queryParameter("sessionId", S, true)],
  status: 101,
  responses: { 426: fail("WebSocket upgrade required.") },
});
add("/api/hosts", "put", "putHosts", "Replace pools", poolResult, {
  body: poolResult,
});
add(
  "/api/hosts",
  "post",
  "postHosts",
  "Register a host",
  obj({ host: Type.Optional(host), token: S, command: S }),
  { body: obj({ label: Type.String({ minLength: 1, maxLength: 100 }) }) },
);
add(
  "/api/hosts",
  "patch",
  "patchHosts",
  "Rename host or pool",
  Type.Union([obj({ host: Type.Optional(host) }), poolResult]),
  {
    body: Type.Union([
      obj({ id: S, label: S }),
      obj({ poolId: S, label: S }),
    ]),
  },
);
add("/api/hosts", "delete", "deleteHosts", "Revoke host", ok, {
  parameters: [queryParameter("id", S, true)],
});
add(
  "/api/omp-update",
  "post",
  "postOmpUpdate",
  "Restart running omp sessions",
  obj({ success: Type.Literal(true), sessionsRestarted: N }),
  { body: obj({ action: Type.Literal("restart") }) },
);
add(
  "/api/omp-version",
  "get",
  "getOmpVersion",
  "Get installed omp version",
  obj({ version: ns }),
);
add("/api/manifest", "get", "getManifest", "Get install manifest", null, {
  parameters: [queryParameter("theme", S)],
  responses: {
    200: {
      description: "Web application manifest.",
      content: {
        "application/manifest+json": {
          schema: obj({
            description: S,
            start_url: S,
            scope: S,
            display: S,
            background_color: S,
            theme_color: S,
            name: S,
            short_name: S,
            icons: Type.Array(obj({ src: S, sizes: S, type: S })),
          }),
        },
      },
    },
  },
});
add(
  "/api/notifications/devices",
  "get",
  "getNotificationsDevices",
  "Get push subscription status",
  obj({ publicKey: S, subscribed: B }),
  { parameters: [queryParameter("deviceId", S)] },
);
add(
  "/api/notifications/devices",
  "put",
  "putNotificationsDevices",
  "Save notification preferences and subscription",
  obj({ subscribed: B }),
  {
    body: obj({
      deviceId: S,
      prefs: Type.Optional(Type.Partial(prefs)),
      subscription: Type.Optional(subscription),
    }),
  },
);
add(
  "/api/notifications/history",
  "get",
  "getNotificationsHistory",
  "List notification history",
  obj({ entries: Type.Array(history) }),
);
add(
  "/api/notifications/history",
  "patch",
  "patchNotificationsHistory",
  "Mark notification entries read",
  ok,
  {
    body: obj({
      ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        maxItems: 100,
      }),
    }),
  },
);
add(
  "/api/notifications/history",
  "delete",
  "deleteNotificationsHistory",
  "Delete one or all notification entries",
  ok,
  {
    parameters: [
      queryParameter("id", S),
      queryParameter("all", Type.Literal("1")),
    ],
  },
);
add(
  "/api/notifications/presence",
  "post",
  "postNotificationsPresence",
  "Report tab presence",
  null,
  {
    status: 204,
    body: obj({
      clientId: S,
      deviceId: S,
      visible: B,
      sessionId: Type.Optional(ns),
      seq: Type.Integer(),
    }),
  },
);
add(
  "/api/notifications/test",
  "post",
  "postNotificationsTest",
  "Send a test push",
  null,
  { status: 204, body: obj({ deviceId: S }) },
);
add(
  "/api/stt",
  "get",
  "getStt",
  "List transcription jobs",
  obj({ jobs: Type.Array(sttJob) }),
  {
    parameters: [
      queryParameter("scope", Type.String({ maxLength: 1024 }), true),
    ],
  },
);
add("/api/stt", "post", "postStt", "Start transcription", obj({ jobId: S }), {
  status: 202,
  requestBody: {
    required: true,
    content: {
      "multipart/form-data": {
        schema: obj({
          file: Type.String({
            format: "binary",
            description: "Audio file, up to 25 MiB.",
          }),
          scope: Type.Optional(S),
          owner: Type.Optional(S),
          after: Type.Optional(literals("send", "steer", "followup")),
        }),
      },
    },
  },
});
add("/api/stt/[jobId]", "get", "getSttJobid", "Poll transcription", sttJob, {
  parameters: [jobId],
  description: "The transcript is only returned by a claim.",
});
add("/api/stt/[jobId]", "post", "postSttJobid", "Retry transcription", sttJob, {
  parameters: [jobId, queryParameter("owner", S)],
});
add(
  "/api/stt/[jobId]",
  "delete",
  "deleteSttJobid",
  "Claim or discard transcription",
  sttClaim,
  {
    parameters: [jobId, queryParameter("claim", S), queryParameter("owner", S)],
    description:
      "Without claim, discard. The first claim token may recover the transcript; only its owner receives after.",
  },
);
add(
  "/api/stt/[jobId]/audio",
  "get",
  "getSttJobidAudio",
  "Get retained audio",
  null,
  {
    parameters: [jobId],
    responses: {
      200: {
        description: "Original audio bytes.",
        content: {
          "audio/*": { schema: Type.String({ format: "binary" }) },
          "application/octet-stream": {
            schema: Type.String({ format: "binary" }),
          },
        },
      },
    },
  },
);
add(
  "/api/transport-metrics",
  "get",
  "getTransportMetrics",
  "Probe server clock",
  obj({ now: N }),
);
add(
  "/api/transport-metrics",
  "post",
  "postTransportMetrics",
  "Append transport samples",
  obj({ written: N }),
  {
    body: obj({
      samples: Type.Array(
        obj(
          { metric: S },
          {
            additionalProperties: Type.Unknown({
              description: "Extensible client metric fields.",
            }),
          },
        ),
        { maxItems: 1000 },
      ),
    }),
  },
);
add("/api/usage", "get", "getUsage", "Get usage report", usage, {
  parameters: ["range", "granularity", "project", "from", "to", "refresh"].map(
    (x) => queryParameter(x, S),
  ),
});
add(
  "/api/web-auth/session",
  "post",
  "postWebAuthSession",
  "Create web password session",
  ok,
  {
    body: obj({ password: S }),
    description: "On success sets an HttpOnly session cookie.",
  },
);
add("/api/events", "get", "getEvents", "Open multiplexed SSE stream", null, {
  responses: {
    200: {
      description:
        "SSE frames: mux control frames use MuxControlFrame; subscription event names carry channel-specific payloads. Each SSE id is the server emission time.",
      content: { "text/event-stream": { schema: Type.String() } },
    },
  },
});
add(
  "/api/events",
  "post",
  "postEvents",
  "Subscribe or unsubscribe SSE channel",
  ok,
  { body: eventRequest },
);
add(
  "/api/events/link",
  "get",
  "getEventsLink",
  "Upgrade browser link to WebSocket",
  null,
  {
    responses: {
      101: {
        description: "WebSocket upgrade accepted; browser link frames follow.",
      },
      426: fail("WebSocket upgrade required."),
    },
  },
);
export const systemHttpOperations: readonly HttpOperation[] = operations;
