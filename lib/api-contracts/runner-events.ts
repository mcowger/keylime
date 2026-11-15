import {
  Type,
  type Static,
  type TObject,
  type TProperties,
  type TSchema,
} from "@sinclair/typebox";
import {
  OutboxUpdateFrameSchema,
  UiCustomFrameSchema,
  UiDialogRequestSchema,
  UiPresentationFrameSchema,
} from "./domain";
import { lifecycleRunnerEvents } from "./runner-lifecycle";
import { toolsRunnerEvents } from "./runner-tools";
import {
  browserNativeEventSchemas,
  runnerEventSchemas,
} from "./runner-native-events";
export {
  runnerEventSchemas,
  AssistantStreamEventSchema,
} from "./runner-native-events";
import type { OperationContract } from "./operations";

const s = () => Type.String();
const n = () => Type.Number();
const b = () => Type.Boolean();
const opt = Type.Optional;
const strings = () => Type.Array(s());
const literals = (...values: string[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
const event = (type: string, fields: TProperties = {}) =>
  Type.Object({ type: Type.Literal(type), ...fields });
const frame = (t: string, fields: TProperties = {}) =>
  Type.Object({ t: Type.Literal(t), ...fields });
const dynamic = () =>
  Type.Unknown({
    description: "Tool, provider, or extension-defined JSON value.",
  });
const updateMode = literals("full", "delta");
/** @apiCommand set_event_filter */
export const eventRunnerOperations = [
  {
    name: "set_event_filter",
    description: `Usage: Select which native session events are forwarded to this host.
Inputs: events is null for all or an array of event types; messageUpdates optionally selects full or delta.
Invariants: Message ids are assigned even to filtered events; delta is the default mode.
Effects: Changes the in-memory forwarding filter, not the underlying session activity.
Recovery: Reapply the desired filter after reconnect; fetch a snapshot when events may have been missed.`,
    args: Type.Object({
      events: Type.Union([
        Type.Null(),
        Type.Array(Type.String({ minLength: 1 })),
      ]),
      messageUpdates: opt(updateMode),
    }),
    result: Type.Object({
      events: Type.Union([Type.Null(), strings()]),
      messageUpdates: updateMode,
    }),
  },
] as const satisfies readonly OperationContract[];

const id = Type.Union([n(), s()]);
const uiFields = [
  Type.Intersect([frame("ui_request", { id }), UiDialogRequestSchema.allOf[1]]),
  frame("ui_end", { id }),
  frame("ui", {
    method: Type.Literal("notify"),
    message: s(),
    notifyType: opt(s()),
  }),
  frame("ui", {
    method: Type.Literal("setStatus"),
    statusKey: s(),
    statusText: opt(s()),
  }),
  frame("ui", {
    method: Type.Literal("setWidget"),
    widgetKey: s(),
    widgetLines: opt(strings()),
    widgetPlacement: opt(s()),
  }),
  frame("ui", { method: Type.Literal("setTitle"), title: s() }),
  frame("ui", { method: Type.Literal("set_editor_text"), text: s() }),
  frame("ui", { method: Type.Literal("setWorkingMessage"), message: opt(s()) }),
  frame("ui", {
    method: Type.Literal("custom"),
    id: n(),
    lines: strings(),
    closed: opt(b()),
  }),
];
/** Runner-to-host frames. Unknown future frames still pass through the runtime dispatcher. */
export const runnerInboundFrameSchemas: readonly TSchema[] = [
  frame("hello", {
    proto: n(),
    pid: n(),
    sessionId: s(),
    sessionFile: opt(s()),
    cwd: s(),
  }),
  frame("res", { id: n(), ok: Type.Literal(true), data: opt(dynamic()) }),
  frame("res", {
    id: n(),
    ok: Type.Literal(false),
    error: s(),
    code: opt(s()),
  }),
  frame("event", { event: Type.Union([...runnerEventSchemas]) }),
  ...uiFields,
  ...lifecycleRunnerEvents,
  ...toolsRunnerEvents,
];
/** Browser stream ordering is scoped to a stream, not a durable session revision. */
export const SessionStreamCursorSchema = Type.Object(
  {
    streamId: Type.String({
      description:
        "Identifies the browser event stream whose sequence is being counted.",
    }),
    sequence: Type.Number({
      description:
        "Ordering sequence within this stream; compare only cursors with the same streamId.",
    }),
    first: Type.Optional(
      Type.Number({
        description:
          "First sequence included in a merged delta; sequence is the last, and the range is inclusive. Within the same streamId, a snapshot at S where first <= S < sequence already includes only part of the delta: never replay the whole delta on it. Buffer and reconcile with a covering snapshot.",
      }),
    ),
  },
  {
    description:
      "Browser-assigned ordering cursor; a different streamId starts a distinct sequence.",
  },
);
/** Browser wrapper always replaces native web metadata with its own ordering cursor. */
const withWeb = (schema: TSchema) =>
  Type.Intersect([schema, Type.Object({ web: SessionStreamCursorSchema })]);
const adaptFrame = (schema: TSchema) => {
  const obj = schema as TObject;
  const { title: _title, ...withoutTitle } = Type.Omit(obj, ["t"]);
  return Type.Intersect([
    withoutTitle,
    Type.Object({ type: obj.properties.t }),
  ]);
};
/** @apiEvent model_activity @apiEvent session_settled @apiEvent message_update */
export const browserEventSchemas: readonly TSchema[] = [
  ...browserNativeEventSchemas.map(withWeb),
  ...lifecycleRunnerEvents.map((schema) => withWeb(adaptFrame(schema))),
  ...toolsRunnerEvents.map((schema) => {
    const obj = schema as TObject;
    if (obj.properties.t.const !== "subagent_event")
      return withWeb(adaptFrame(schema));
    const payload = obj.properties.payload as TObject;
    return withWeb(
      adaptFrame(
        Type.Object({
          ...obj.properties,
          payload: Type.Object({
            ...payload.properties,
            event: Type.Union([...browserNativeEventSchemas]),
          }),
        }),
      ),
    );
  }),
  withWeb(UiDialogRequestSchema),
  withWeb(event("ui_end", { id })),
  withWeb(UiPresentationFrameSchema),
  withWeb(UiCustomFrameSchema),
  OutboxUpdateFrameSchema,
  withWeb(event("host_status", { hostId: s(), status: s() })),
  withWeb(event("process_exit", { reason: opt(s()), detail: opt(s()) })),
  withWeb(
    event("session_history_changed", {
      leafId: Type.Union([s(), Type.Null()]),
    }),
  ),
];
export type SessionStreamCursorContract = Static<
  typeof SessionStreamCursorSchema
>;
