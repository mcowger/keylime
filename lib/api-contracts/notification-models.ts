import { Type } from "@sinclair/typebox";

export const NotificationTypeSchema = Type.Union(
  [
    Type.Literal("completed"),
    Type.Literal("input"),
    Type.Literal("error"),
    Type.Literal("modelSwitch"),
  ],
  {
    description:
      "Normal notification categories controlled by per-device preferences.",
  },
);
export const NotificationEventSchema = Type.Object(
  {
    type: Type.Union([
      NotificationTypeSchema,
      Type.Literal("test", {
        description: "Sent only by the test notification button.",
      }),
    ]),
    hostId: Type.Optional(
      Type.String({
        description:
          "Conversation host; absent for historical notifications without provenance and test pushes.",
      }),
    ),
    sessionId: Type.String({
      description: "Conversation identifier; empty for a test push.",
    }),
    sessionName: Type.Union([Type.String(), Type.Null()], {
      description:
        "Display name of the conversation, or null when unavailable.",
    }),
    detail: Type.Optional(
      Type.String({ description: "Question, error, or model-switch reason." }),
    ),
    from: Type.Optional(
      Type.String({ description: "Previous model for a model-switch event." }),
    ),
    to: Type.Optional(
      Type.String({ description: "New model for a model-switch event." }),
    ),
    aliases: Type.Optional(
      Type.Array(Type.String(), { description: "Earlier conversation ids." }),
    ),
  },
  {
    description:
      "Notification payload shared by history, in-app delivery and push; test is reserved for explicit test pushes.",
  },
);
export const NotificationHistoryEntrySchema = Type.Object(
  {
    id: Type.String({
      description:
        "Opaque replace tag scoped to host, session and type for new conversation notifications.",
    }),
    event: NotificationEventSchema,
    at: Type.Number({ description: "Time recorded, in Unix milliseconds." }),
    read: Type.Boolean({
      description:
        "Whether this notification was seen; a replacement gets a fresh read state.",
    }),
  },
  {
    description:
      "Persisted notification history entry; a later event with the same session and type replaces it.",
  },
);
export const NotificationPrefsSchema = Type.Object(
  {
    enabled: Type.Boolean({
      description:
        "Whether this device requests notifications; defaults to false.",
    }),
    types: Type.Object(
      {
        completed: Type.Boolean({
          description: "Notify when a session completes; defaults to true.",
        }),
        input: Type.Boolean({
          description: "Notify when input is requested; defaults to true.",
        }),
        error: Type.Boolean({
          description: "Notify on errors; defaults to true.",
        }),
        modelSwitch: Type.Boolean({
          description: "Notify on model switches; defaults to false.",
        }),
      },
      { description: "Per-category notification switches." },
    ),
    whenActive: Type.Union([Type.Literal("toast"), Type.Literal("system")], {
      description:
        "Delivery preference while a reachable tab is active; defaults to toast.",
    }),
  },
  {
    description:
      "Per-device notification preferences; unrecognized or invalid fields are normalized to defaults when saved.",
  },
);
