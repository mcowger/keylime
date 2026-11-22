import { Type } from "@sinclair/typebox";
import {
  ExitedRpcSessionSchema,
  CrossSessionHostToolEventSchema,
} from "./domain";
import { NotificationEventSchema } from "./notification-models";
import { TerminalEventSchema, WorkspaceFileEventSchema } from "./host-schemas";
import { AgentEventSchema } from "./runner-messages";
import { HostSnapshotSchema, MuxControlFrameSchema } from "./http-system";
import { WorkspaceJobsChangedSchema } from "./workspace-job-events";

export const RunningRpcSessionSchema = Type.Object(
  {
    id: Type.String({ description: "Live session identifier." }),
    cwd: Type.String({ description: "Session working directory on its host." }),
    hostId: Type.String({ description: "Owning host, including local." }),
    awaitingInput: Type.Optional(
      Type.Literal(true, {
        description: "Present only while the session is awaiting input.",
      }),
    ),
  },
  {
    title: "RunningRpcSession",
    description:
      "A live RPC session on the named host. awaitingInput is present only when true.",
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

export const StreamPayloadSchema = Type.Union(
  [
    MuxControlFrameSchema,
    AgentEventSchema,
    Type.Object(HostSnapshotSchema.properties, {
      title: "HostStreamSnapshot",
      description: "Independent hosts, local first. Matches GET /api/hosts.",
    }),
    TerminalEventSchema,
    WorkspaceFileEventSchema,
    WorkspaceJobsChangedSchema,
    Type.Object({
      type: Type.Literal("connected"),
      filePath: Type.String(),
      hostId: Type.String(),
    }),
    Type.Object({
      type: Type.Literal("running"),
      runningSessionIds: Type.Array(Type.String()),
      runningSessions: Type.Array(RunningRpcSessionSchema),
      exitedSessions: Type.Array(ExitedRpcSessionSchema),
      refreshSessionList: Type.Optional(Type.Boolean()),
    }),
    Type.Object({
      type: Type.Literal("sessions-changed"),
      sessions: Type.Array(
        Type.Object({ sessionId: Type.String(), hostId: Type.String() }),
      ),
      refreshSessionList: Type.Literal(true),
    }),
    Type.Object({
      sessionIds: Type.Array(Type.String()),
      openSessions: Type.Array(
        Type.Object({ sessionId: Type.String(), hostId: Type.String() }),
      ),
    }),
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
