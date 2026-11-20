import { Type, type Static } from "@sinclair/typebox";
import { CREATION_ID_RE } from "../hosts/creation-identity";

// Bootstrapped from the protocol's TypeScript declarations with TypeScriptToTypeBox.
// These schemas are the canonical type and documentation source; runtime decoders are unchanged.
const SafeCount = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
export const SHIP_DIGEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SHIP_DIGEST_FEEDBACK_LIMIT = 20;
export const SHIP_DIGEST_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const ShipDigestId = Type.String({ pattern: SHIP_DIGEST_ID_RE.source });
const ShipDigestSeq = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const ShipFeedbackItem = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("conversation"),
      Type.Literal("inline"),
      Type.Literal("review"),
    ]),
    id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export const ShipPrDigestSchema = Type.Object(
  {
    id: ShipDigestId,
    monitorId: Type.String({
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      description: "Server-issued Ship monitor generation.",
    }),
    sessionId: Type.String({
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    }),
    prUrl: Type.String({
      pattern:
        "^https://github\\.com/[a-z0-9][a-z0-9-]{0,38}/(?!\\.\\.?/)[a-z0-9._-]{1,100}/pull/[1-9][0-9]{0,15}$",
      description:
        "Canonical GitHub.com PR being monitored. Must match the server grant.",
    }),
    createdAt: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Host observation time in Unix milliseconds.",
    }),
    feedback: Type.Array(ShipFeedbackItem, {
      minItems: 1,
      maxItems: SHIP_DIGEST_FEEDBACK_LIMIT,
    }),
    omitted: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Additional events not included in this bounded batch.",
    }),
  },
  {
    additionalProperties: false,
    description:
      "A persisted batch of GitHub feedback IDs for a server-issued Ship watch. The server renders the follow-up; this payload carries no message text.",
  },
);
export type ShipPrDigest = Static<typeof ShipPrDigestSchema>;
export const ShipPrDigestFrame = Type.Object(
  {
    type: Type.Literal("ship_pr_digest"),
    seq: ShipDigestSeq,
    ...ShipPrDigestSchema.properties,
  },
  {
    additionalProperties: false,
    title: "HostLinkShipPrDigest",
    description:
      "A persisted PR feedback digest offered only to the initiating server. Retries use the same ID until application receipt.",
  },
);
const ShipPrDigestReceipt = Type.Object(
  {
    type: Type.Literal("ship_pr_digest_receipt"),
    seq: ShipDigestSeq,
    id: ShipDigestId,
  },
  {
    title: "HostLinkShipPrDigestReceipt",
    description:
      "The authenticated server durably accepted this ID in its outbox. This is not a transport acknowledgement or agent delivery confirmation.",
  },
);
export const HostUriSchemeSchema = Type.Object(
  { scheme: Type.String(), writable: Type.Boolean() },
  {
    title: "HostUriScheme",
    description: "A host-advertised URI scheme and whether it can be written.",
  },
);
export type HostUriScheme = Static<typeof HostUriSchemeSchema>;
export const TerminalEventSchema = Type.Union(
  [
    Type.Object({
      type: Type.Literal("resize"),
      cols: SafeCount,
      rows: SafeCount,
      cursor: SafeCount,
    }),
    Type.Object({ type: Type.Literal("disconnected") }),
    Type.Object({
      type: Type.Literal("output"),
      data: Type.String(),
      cursor: SafeCount,
    }),
    Type.Object({ type: Type.Literal("closed") }),
  ],
  {
    title: "TerminalEvent",
    description:
      "Terminal stream event: output and resize carry a cursor for ordering; disconnected describes transport loss, whereas closed reports terminal closure.",
  },
);
export type TerminalEvent = Static<typeof TerminalEventSchema>;
export const WorkspaceFileEventSchema = Type.Union(
  [
    Type.Object({
      type: Type.Literal("change"),
      mtime: Type.String(),
      size: SafeCount,
    }),
    Type.Object({ type: Type.Literal("error"), message: Type.String() }),
  ],
  {
    title: "WorkspaceFileEvent",
    description:
      "File watch notification; change reports ISO modification time and size in bytes, while error reports watch failure. A replacement watch has its own epoch.",
  },
);
export type WorkspaceFileEvent = Static<typeof WorkspaceFileEventSchema>;
export const HelloChannelSchema = Type.Object(
  {
    ch: Type.String(),
    sessionId: Type.Union([Type.String(), Type.Null()], {
      description: "Child session identity, or null before it has been named.",
    }),
    cwd: Type.String({
      description: "Child spawn working directory on the host.",
    }),
    pending: Type.Union([Type.Array(Type.String()), Type.Null()], {
      description:
        "Raw outstanding blocking request lines, or null when their byte limit was exceeded.",
    }),
    creationId: Type.Optional(Type.String({ pattern: CREATION_ID_RE.source })),
  },
  {
    title: "HelloChannel",
    description:
      "Child channel metadata: sessionId is null before the child names a session; cwd is its spawn directory; pending contains raw open blocking request stdout lines, or null when over the pending byte limit.",
  },
);
export type HelloChannel = Static<typeof HelloChannelSchema>;
export const LinkStatSampleSchema = Type.Object(
  {
    session: Type.Union([Type.String(), Type.Null()]),
    bytes: Type.Number(),
    bytesAhead: Type.Number(),
    ackMs: Type.Number(),
    at: Type.Number(),
  },
  {
    title: "LinkStatSample",
    description:
      "Uplink message measured at enqueue wall-clock time, with its bytes including blob, bytes unacked ahead, and monotonic time until acknowledgement.",
  },
);
export type LinkStatSample = Static<typeof LinkStatSampleSchema>;
const error = Type.Object({
  status: Type.Number(),
  code: Type.String(),
  message: Type.String(),
});
export const PartSchema = Type.Object(
  {
    type: Type.Literal("part"),
    seq: SafeCount,
    at: SafeCount,
    end: Type.Boolean(),
    data: Type.String(),
  },
  {
    title: "HostLinkPart",
    description:
      "A sequenced slice of a long JSON line; at is its UTF-16 offset and end marks the last slice.",
    examples: [{ type: "part", seq: 1, at: 0, end: true, data: "{}" }],
  },
);
/** A piece's offset counts UTF-16 code units, not encoded bytes; join all pieces before parsing the JSON line. */
export type Part = Static<typeof PartSchema>;
const ping = Type.Object(
  { type: Type.Literal("ping") },
  { title: "HostLinkPing", description: "Unsequenced liveness ping." },
);
const pong = Type.Object(
  { type: Type.Literal("pong") },
  { title: "HostLinkPong", description: "Unsequenced liveness response." },
);
const ack = Type.Object(
  { type: Type.Literal("ack"), ack: SafeCount },
  {
    title: "HostLinkAck",
    description:
      "Unsequenced acknowledgement of the highest peer sequence applied.",
  },
);
export const DownMessageSchema = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal("welcome"),
        v: Type.Number(),
        hostId: Type.String(),
      },
      {
        title: "HostLinkWelcome",
        description: "Server acceptance and negotiated protocol version.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("stdin"),
        seq: SafeCount,
        ch: Type.String(),
        line: Type.String(),
      },
      {
        title: "HostLinkStdin",
        description:
          "Serialized runner input frame; complete decoded shapes are linked from the host and runner channel documents.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("kill"),
        seq: SafeCount,
        ch: Type.String(),
        force: Type.Boolean(),
      },
      {
        title: "HostLinkKill",
        description: "Stop a child channel, optionally forcibly.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("interest"),
        seq: SafeCount,
        ch: Type.String(),
        on: Type.Boolean(),
        preparing: Type.Boolean(),
      },
      {
        title: "HostLinkInterest",
        description: "Set this link's interest in a channel.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("host_tools"),
        seq: SafeCount,
        ch: Type.String(),
        tools: Type.Array(
          Type.Unknown({ description: "Opaque host tool definition." }),
        ),
        schemes: Type.Array(HostUriSchemeSchema),
      },
      {
        title: "HostLinkHostTools",
        description: "Advertise host tools and URI schemes to a channel.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("req"),
        seq: SafeCount,
        id: Type.String(),
        op: Type.String(),
        args: Type.Unknown({
          description:
            "Operation-specific arguments are described by each generated request/reply exchange. Unknown future operations remain decodable and receive unknown_op.",
        }),
      },
      {
        title: "HostLinkRequest",
        description:
          "Invoke a host operation. An unknown op receives a 501 unknown_op response.",
        examples: [
          {
            type: "req",
            seq: 1,
            id: "request-1",
            op: "listSessions",
            args: {},
          },
        ],
      },
    ),
    Type.Object(
      {
        type: Type.Literal("pty_attach"),
        id: Type.String(),
        sessionId: Type.String(),
        payload: Type.String(),
      },
      {
        title: "HostLinkPtyAttach",
        description:
          "Connection-scoped terminal frame, sent once and never replayed.",
      },
    ),
    ShipPrDigestReceipt,
    ping,
    pong,
    ack,
    PartSchema,
  ],
  {
    title: "HostLinkDownMessage",
    description:
      "Server-to-daemon text messages. Sequenced application frames are acknowledged cumulatively and replayed on link resume; controls are unsequenced. Operation-specific requests are described by their exchange contracts.",
  },
);
export type DownMessage = Static<typeof DownMessageSchema>;
export const UpMessageSchema = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal("hello"),
        v: Type.Number(),
        ompVersion: Type.Union([Type.String(), Type.Null()]),
        keylimeVersion: Type.Optional(Type.String()),
        workspaceOps: Type.Optional(Type.Array(Type.String())),
        canReportUsage: Type.Optional(
          Type.Boolean({ description: "This daemon accepts usageReport." }),
        ),
        canStageArtifact: Type.Optional(
          Type.Boolean({
            description:
              "This daemon accepts stageHostArtifact. Omitted when unsupported.",
          }),
        ),
        canActivateArtifact: Type.Optional(
          Type.Boolean({
            description:
              "This standalone daemon accepts staged binary activation.",
          }),
        ),
        canReportBinaryDigests: Type.Optional(
          Type.Boolean({
            description: "This daemon accepts hostInstalledBinaryDigests.",
          }),
        ),
        platform: Type.String(),
        arch: Type.Optional(
          Type.String({
            description:
              "CPU architecture reported by a daemon supporting paired release deployment.",
          }),
        ),
        home: Type.String(),
        autoApproveExtension: Type.Boolean(),
        ack: SafeCount,
        channels: Type.Array(HelloChannelSchema),
      },
      {
        title: "HostLinkHello",
        description:
          "First daemon message: version, identity, capabilities, last applied downlink sequence and channel state.",
        examples: [
          {
            type: "hello",
            v: 11,
            ompVersion: null,
            platform: "linux",
            home: "/home/user",
            autoApproveExtension: false,
            ack: 0,
            channels: [],
          },
        ],
      },
    ),
    Type.Object(
      {
        type: Type.Literal("pty_event"),
        id: Type.String(),
        payload: Type.String(),
      },
      {
        title: "HostLinkPtyEvent",
        description:
          "Connection-scoped terminal event, sent once and never replayed.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("stdout"),
        seq: SafeCount,
        ch: Type.String(),
        line: Type.String(),
      },
      {
        title: "HostLinkStdout",
        description: "Opaque runner stdout line for a child channel.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("stderr"),
        seq: SafeCount,
        ch: Type.String(),
        chunk: Type.String(),
      },
      { title: "HostLinkStderr", description: "Child channel stderr chunk." },
    ),
    Type.Object(
      {
        type: Type.Literal("exit"),
        seq: SafeCount,
        ch: Type.String(),
        code: Type.Union([Type.Number(), Type.Null()]),
        signal: Type.Union([Type.String(), Type.Null()]),
        reason: Type.Optional(Type.String()),
      },
      {
        title: "HostLinkExit",
        description:
          "Child exit; reason is present when deliberately stopped and absent for a crash.",
      },
    ),
    Type.Object(
      { type: Type.Literal("resync"), seq: SafeCount, ch: Type.String() },
      {
        title: "HostLinkResync",
        description: "Channel output needs resynchronization.",
      },
    ),
    Type.Object(
      { type: Type.Literal("sessions_changed"), seq: SafeCount },
      {
        title: "HostLinkSessionsChanged",
        description: "Host session list changed.",
      },
    ),
    ShipPrDigestFrame,
    Type.Object(
      {
        type: Type.Literal("channels_changed"),
        seq: SafeCount,
        channels: Type.Array(HelloChannelSchema),
      },
      {
        title: "HostLinkChannelsChanged",
        description: "Host channel metadata changed.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("stats"),
        seq: SafeCount,
        samples: Type.Array(LinkStatSampleSchema),
        invalid: Type.Optional(
          Type.Number({
            description:
              "Decoder-only count of dropped samples; senders omit this field.",
          }),
        ),
      },
      {
        title: "HostLinkStats",
        description:
          "Advisory link samples: the receiver drops and counts invalid or excess samples rather than rejecting the line. invalid is decoder-only, not a sender field.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("upload_ack"),
        seq: SafeCount,
        id: Type.String(),
        attempt: Type.String(),
        received: SafeCount,
        done: Type.Boolean(),
        error: Type.Optional(error),
      },
      {
        title: "HostLinkUploadAck",
        description:
          "Bytes written for an upload attempt; done means synced, error means the staged file is gone.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("terminal_event"),
        seq: SafeCount,
        id: Type.String(),
        event: TerminalEventSchema,
      },
      {
        title: "HostLinkTerminalEvent",
        description: "Terminal event for an identified terminal.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("workspace_file"),
        seq: SafeCount,
        id: Type.String(),
        epoch: Type.String(),
        event: WorkspaceFileEventSchema,
      },
      {
        title: "HostLinkWorkspaceFile",
        description: "Workspace file watch event and watch epoch.",
      },
    ),
    Type.Object(
      {
        type: Type.Literal("res"),
        seq: SafeCount,
        id: Type.String(),
        ok: Type.Literal(true),
        result: Type.Optional(
          Type.Unknown({
            description:
              "Opaque operation-specific result; individual operation payloads are outside this contract.",
          }),
        ),
        blob: Type.Optional(
          Type.Object(
            { bytes: Type.Number() },
            {
              description:
                "Length of the separately transmitted binary result.",
            },
          ),
        ),
      },
      {
        title: "HostLinkResult",
        description:
          "Successful host operation response, optionally followed by binary result frames.",
        examples: [
          { type: "res", seq: 1, id: "request-1", ok: true, result: [] },
        ],
      },
    ),
    Type.Object(
      {
        type: Type.Literal("res"),
        seq: SafeCount,
        id: Type.String(),
        ok: Type.Literal(false),
        error,
      },
      {
        title: "HostLinkError",
        description:
          "Failed host operation response with status, code and message.",
      },
    ),
    ping,
    pong,
    ack,
    PartSchema,
  ],
  {
    title: "HostLinkUpMessage",
    description:
      "Daemon-to-server text messages, including handshake, child channel events, host operation replies and advisory samples. Sequenced frames are acknowledged cumulatively and replayed on link resume; unsequenced samples are not retained.",
  },
);
export type UpMessage = Static<typeof UpMessageSchema>;
