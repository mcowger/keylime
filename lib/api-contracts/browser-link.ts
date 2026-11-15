import { Type } from "@sinclair/typebox";
import type { Static, TProperties } from "@sinclair/typebox";
import {
  BROWSER_LINK_PATH,
  BROWSER_LINK_VERSION,
  COMMAND_DEDUPE_MS,
  LINK_RESUME_MS,
} from "../event-stream-protocol";
import { LINK_LIMITS } from "../hosts/link-protocol";
import type { SocketContract } from "./types";

/** Bootstrapped from EventStreamChannel with TypeScriptToTypeBox.Generate. The existing parser remains authoritative. */
export const EventStreamChannelSchema = Type.Union(
  [
    Type.Object({ kind: Type.Literal("running") }),
    Type.Object({ kind: Type.Literal("open-chat"), sessionId: Type.String() }),
    Type.Object({ kind: Type.Literal("open-chats") }),
    Type.Object({
      kind: Type.Literal("terminal"),
      hostId: Type.String(),
      terminalId: Type.String(),
    }),
    Type.Object({
      kind: Type.Literal("notifications"),
      clientId: Type.String(),
    }),
    Type.Object({ kind: Type.Literal("session"), sessionId: Type.String() }),
    Type.Object({
      kind: Type.Literal("file"),
      path: Type.String(),
      hostId: Type.Optional(Type.String()),
      sessionId: Type.Union([Type.String(), Type.Null()]),
    }),
    Type.Object({ kind: Type.Literal("host-tools") }),
    Type.Object({ kind: Type.Literal("hosts") }),
  ],
  {
    title: "EventStreamChannel",
    description:
      "Selector for a shared subscription consumed by browser tabs: running sessions, open chats, terminal, notifications, session events, file watches, host tools or hosts. The parser additionally validates identifiers and paths. A file's null sessionId selects no session; an omitted hostId uses the default resolution.",
  },
);
export type EventStreamChannel = Static<typeof EventStreamChannelSchema>;

const count = () =>
  Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const seq = () =>
  Type.Integer({
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    description: "Per-direction sequence number, acknowledged cumulatively.",
  });
const object = <T extends TProperties>(
  title: string,
  description: string,
  properties: T,
) => Type.Object(properties, { title, description });
const Hello = object(
  "BrowserHello",
  "First text frame; token is null for a new link, otherwise an owner-bound resume token. ack is the last applied server sequence.",
  {
    type: Type.Literal("hello"),
    v: Type.Number(),
    token: Type.Union([Type.String(), Type.Null()], {
      description: "Owner-bound resume token, or null to create a link.",
    }),
    ack: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Highest server sequence applied by the browser.",
    }),
  },
);
const Welcome = object(
  "BrowserWelcome",
  "Resume result and server identity; ack is the last applied browser sequence. If resumed is false, rebuild subscriptions and reconcile outstanding commands.",
  {
    type: Type.Literal("welcome"),
    v: Type.Number(),
    token: Type.String(),
    serverId: Type.String(),
    resumed: Type.Boolean(),
    ack: count(),
  },
);
export type BrowserWelcome = Static<typeof Welcome>;
const Ack = object(
  "BrowserAck",
  "Unsequenced cumulative acknowledgement of the other direction.",
  { type: Type.Literal("ack"), ack: count() },
);
const Ping = object(
  "BrowserPing",
  "Unsequenced heartbeat. Browser clock pings carry c; server heartbeats carry at.",
  {
    type: Type.Literal("ping"),
    c: Type.Optional(Type.Number()),
    at: Type.Optional(Type.Number()),
  },
);
const Pong = object(
  "BrowserPong",
  "Unsequenced reply to a browser clock ping, echoing c and providing server epoch milliseconds at.",
  {
    type: Type.Literal("pong"),
    c: Type.Optional(Type.Unknown()),
    at: Type.Optional(Type.Number()),
  },
);
const Part = object(
  "BrowserPart",
  "Sequenced slice of a larger JSON line; at is the UTF-16 offset, data is text, end marks the final slice. Reassemble before applying the joined line.",
  {
    type: Type.Literal("part"),
    seq: seq(),
    at: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description:
        "UTF-16 offset in the original JSON line, not a byte offset.",
    }),
    end: Type.Boolean(),
    data: Type.String(),
  },
);
const Sub = object(
  "BrowserSubscribe",
  "Subscribe to a channel; id is also the event name and matches ^s[0-9]{1,15}$.",
  {
    type: Type.Literal("sub"),
    seq: seq(),
    id: Type.String(),
    channel: EventStreamChannelSchema,
  },
);
const Unsub = object("BrowserUnsubscribe", "Release a subscription.", {
  type: Type.Literal("unsub"),
  seq: seq(),
  id: Type.String(),
});
const Command = object(
  "BrowserCommand",
  "Agent command for an existing session. rid is scoped to session for deduplication, not globally; a reply reports dispatch outcome and is not necessarily completion of the resulting turn. advisor selects the advisor.",
  {
    type: Type.Literal("cmd"),
    seq: seq(),
    rid: Type.String(),
    session: Type.String(),
    advisor: Type.Optional(Type.Boolean()),
    command: Type.Unknown(),
  },
);
const UploadStart = object(
  "BrowserUploadStart",
  "Open or resume an upload. n identifies this start generation; ignore acknowledgements for older generations. mime is the file MIME type, size and acknowledged offsets are bytes.",
  {
    type: Type.Literal("up_start"),
    seq: seq(),
    id: Type.String(),
    n: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description:
        "Upload start generation echoed by progress and error frames.",
    }),
    host: Type.String({ description: "Host receiving this upload." }),
    name: Type.String({ description: "Upload file name." }),
    size: count(),
    mime: Type.String(),
  },
);
export type BrowserUploadStart = Static<typeof UploadStart>;
const UploadAbort = object(
  "BrowserUploadAbort",
  "Abort an upload; host may be omitted.",
  {
    type: Type.Literal("up_abort"),
    seq: seq(),
    id: Type.String(),
    host: Type.Optional(Type.String()),
  },
);
const Event = object(
  "BrowserEvent",
  "Event stream frame. name is mux for control or the subscription id; at is epoch milliseconds. data is an opaque JSON value, inserted as already-serialized JSON text on the wire; strings remain JSON strings, not decoded event text.",
  {
    type: Type.Literal("e"),
    name: Type.String(),
    at: Type.Number(),
    data: Type.Unknown(),
    seq: seq(),
  },
);
const UploadBinary = Type.String({
  title: "BrowserUploadBinary",
  format: "binary",
  description: `Binary WebSocket frame: unsigned one-byte UTF-8 id length, id bytes, then upload payload bytes (at most ${LINK_LIMITS.pieceBytes} bytes). Only an upload started on this link is accepted; binary chunks are not sequenced.`,
});
const Reply = object(
  "BrowserReply",
  "Command response; data is the opaque JSON response body. recvAt and at are server epoch milliseconds; deduped indicates a remembered run or reply.",
  {
    type: Type.Literal("reply"),
    rid: Type.String(),
    status: Type.Number(),
    recvAt: Type.Number(),
    at: Type.Number(),
    deduped: Type.Boolean(),
    data: Type.Unknown(),
    seq: seq(),
  },
);
const UploadAck = object(
  "BrowserUploadAck",
  "Upload progress in bytes. start identifies the up_start generation; proof is an optional string only on completion and must be passed through unchanged.",
  {
    type: Type.Literal("up_ack"),
    id: Type.String(),
    received: count(),
    done: Type.Boolean(),
    start: count(),
    proof: Type.Optional(Type.String()),
    seq: seq(),
  },
);
const UploadError = object(
  "BrowserUploadError",
  "Upload failure. start echoes the up_start generation when present; an invalid start may be any JSON value.",
  {
    type: Type.Literal("up_error"),
    id: Type.String(),
    status: Type.Number(),
    code: Type.String(),
    message: Type.String(),
    start: Type.Optional(Type.Unknown()),
    seq: seq(),
  },
);

export const BrowserUpSchema = Type.Union(
  [Hello, Ack, Ping, Pong, Part, Sub, Unsub, Command, UploadStart, UploadAbort],
  {
    title: "BrowserUp",
    description:
      "Browser-to-server JSON frames; hello starts a connection, sequenced application frames are replayed after successful resume, and control frames are unsequenced. Binary upload frames are a separate wire shape.",
  },
);
export const BrowserDownSchema = Type.Union(
  [Welcome, Ack, Ping, Pong, Part, Event, Reply, UploadAck, UploadError],
  {
    title: "BrowserDown",
    description:
      "Server-to-browser JSON frames: welcome and controls, subscription events, command replies and upload progress. Sequenced application frames are cumulatively acknowledged; a new link requires subscription and command reconciliation.",
  },
);
export type BrowserUp = Static<typeof BrowserUpSchema>;
export type BrowserDown = Static<typeof BrowserDownSchema>;
export type BrowserSubscribe = Static<typeof Sub>;
export type BrowserUnsubscribe = Static<typeof Unsub>;
export type BrowserUploadAbort = Static<typeof UploadAbort>;
export type BrowserUploadAck = Static<typeof UploadAck>;
export type BrowserUploadError = Static<typeof UploadError>;

/** Bootstrapped from the worker's DownHead declaration; its permissive shape preserves the existing decoder. */
export const BrowserDownHeadSchema = Type.Object(
  {
    type: Type.Optional(Type.Unknown()),
    seq: Type.Optional(Type.Unknown()),
    name: Type.Optional(Type.Unknown()),
    at: Type.Optional(Type.Unknown()),
    rid: Type.Optional(Type.Unknown()),
    status: Type.Optional(Type.Unknown()),
    recvAt: Type.Optional(Type.Unknown()),
    deduped: Type.Optional(Type.Unknown()),
    token: Type.Optional(Type.Unknown()),
    serverId: Type.Optional(Type.Unknown()),
    resumed: Type.Optional(Type.Unknown()),
    ack: Type.Optional(Type.Unknown()),
    c: Type.Optional(Type.Unknown()),
    id: Type.Optional(Type.Unknown()),
    received: Type.Optional(Type.Unknown()),
    done: Type.Optional(Type.Unknown()),
    proof: Type.Optional(Type.Unknown()),
    start: Type.Optional(Type.Unknown()),
    code: Type.Optional(Type.Unknown()),
    message: Type.Optional(Type.Unknown()),
  },
  {
    title: "BrowserDownHead",
    description:
      "Permissive untrusted decoder header used to inspect incoming frames before validation. Optional unknown fields do not define valid server messages; use BrowserDown for the wire contract.",
  },
);
export type BrowserDownHead = Static<typeof BrowserDownHeadSchema>;

/** The HTTP gate authenticates and checks applicable API origins before upgrade; resume tokens and uploads are owner-bound, while command request IDs are scoped to the session rather than the connection. */
export const browserLinkContract: SocketContract = {
  id: "browser-link",
  title: "Browser link",
  path: BROWSER_LINK_PATH,
  version: BROWSER_LINK_VERSION,
  security: "webSession",
  description: `One authenticated web-session WebSocket multiplexes subscriptions, agent commands and uploads. Text frames are JSON; the first must be hello. Welcome supplies an owner-bound token: reconnect within ${LINK_RESUME_MS} ms with that token and the last applied server ack to resume; a new link requires resubscription. Each direction sequences application lines independently, cumulatively acks them, resends unacknowledged lines after resume and ignores already applied sequences. Controls hello, welcome, ack, ping and pong are unsequenced. Lines exceeding the ${LINK_LIMITS.pieceBytes}-byte piece limit are split into sequenced part frames with UTF-16 offsets; join before parsing. Queues are fair per subscription, command session or upload and flow-controlled by unacked windows. Server e and reply lines place data immediately before seq: data is JSON text embedded as a value, and the worker forwards its raw serialization for subscription events. mux events contain subscription and transport controls. Complete per-command exchanges and channel payloads are composed from their source registries; tool, provider and extension data remain explicitly extensible. Mutating commands are deduplicated by session and rid for ${COMMAND_DEDUPE_MS} ms, including across a new link on the same server; repeatable commands are not remembered. Uploads begin with up_start and resume at the received byte offset returned by an up_ack with matching start generation; stale generations must be ignored. Binary upload frames are unsequenced: one unsigned length byte, that many UTF-8 upload-id bytes, then up to ${LINK_LIMITS.pieceBytes} bytes of payload. They belong to an upload started on this link; up_abort stops it. A completed ack may include an opaque proof string. WebSocket close or failed resume can require reconciliation; schemas do not replace existing runtime validation.`,
  send: [Welcome, Ack, Ping, Pong, Part, Event, Reply, UploadAck, UploadError],
  receive: [
    Hello,
    Ack,
    Ping,
    Pong,
    Part,
    Sub,
    Unsub,
    Command,
    UploadStart,
    UploadAbort,
    UploadBinary,
  ],
};
