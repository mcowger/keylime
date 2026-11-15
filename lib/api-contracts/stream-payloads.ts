import { Type, type TObject, type TSchema } from "@sinclair/typebox";
import {
  ExitedRpcSessionSchema,
  CrossSessionHostToolEventSchema,
} from "./domain";
import { NotificationEventSchema } from "./notification-models";
import { TerminalEventSchema, WorkspaceFileEventSchema } from "./host-schemas";
import { AgentEventSchema } from "./runner-messages";
import { MuxControlFrameSchema, systemHttpOperations } from "./http-system";

export const RunningRpcSessionSchema = Type.Object(
  {
    id: Type.String({ description: "Live session identifier." }),
    cwd: Type.String({ description: "Session working directory on its host." }),
    hostId: Type.Optional(
      Type.String({ description: "Owning host when known." }),
    ),
    awaitingInput: Type.Optional(
      Type.Literal(true, {
        description: "Present only while the session is awaiting input.",
      }),
    ),
  },
  {
    title: "RunningRpcSession",
    description:
      "A live RPC session advertised to running-session subscribers; hostId is omitted when unavailable and awaitingInput is present only when true.",
  },
);
export const NotificationMessageSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("toast"), Type.Literal("os")]),
    event: NotificationEventSchema,
  },
  {
    title: "NotificationMessage",
    description:
      "A notification routed to the subscribed client, with kind distinguishing in-app toast from OS delivery.",
  },
);

function hostsSchema(): TObject {
  const operation = systemHttpOperations.find(
    (item) => item.operationId === "getHosts",
  );
  const response = operation?.responses[200];
  if (!response || typeof response !== "object" || !("content" in response))
    throw new Error("Missing hosts response contract");
  // This is authored, in-process HTTP metadata, not unvalidated remote JSON.
  const content = response.content as Record<string, { schema: TSchema }>;
  const schema = content["application/json"]?.schema;
  if (!schema || schema.type !== "object")
    throw new Error("Hosts response must be an object schema");
  const hostObject = schema as TObject;
  return Type.Object(
    {
      ...hostObject.properties,
      pools: Type.Optional(hostObject.properties.pools),
    },
    {
      title: "HostStreamSnapshot",
      description:
        "Unlike GET /hosts, a live snapshot omits pools while pools.json is unreadable so clients retain their last successful pool state.",
    },
  );
}
export const StreamPayloadSchema = Type.Union(
  [
    MuxControlFrameSchema,
    AgentEventSchema,
    hostsSchema(),
    TerminalEventSchema,
    WorkspaceFileEventSchema,
    Type.Object({ type: Type.Literal("connected"), filePath: Type.String() }),
    Type.Object({
      type: Type.Literal("running"),
      runningSessionIds: Type.Array(Type.String()),
      runningSessions: Type.Array(RunningRpcSessionSchema),
      exitedSessions: Type.Array(ExitedRpcSessionSchema),
      refreshSessionList: Type.Optional(Type.Boolean()),
    }),
    Type.Object({
      type: Type.Literal("sessions-changed"),
      sessionIds: Type.Array(Type.String()),
      refreshSessionList: Type.Literal(true),
    }),
    Type.Object({ sessionIds: Type.Array(Type.String()) }),
    Type.Intersect([
      Type.Object({ type: Type.Literal("notification") }),
      NotificationMessageSchema,
    ]),
    CrossSessionHostToolEventSchema,
  ],
  {
    title: "StreamPayload",
    description:
      "Payload selected by the subscription channel; subscription IDs correlate events to selectors and mux is reserved for connection controls. Running and hosts payloads are snapshots; terminal and file channels have their own ordering and watch epochs. Session event cursors are independent of link sequence: merged deltas retain the later sequence and web.first records the first included sequence, so a snapshot within that range cannot safely apply the merged delta.",
  },
);
