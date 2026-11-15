import { Type } from "@sinclair/typebox";
import {
  lifecycleRunnerOperations,
  lifecycleRunnerFrames,
  lifecycleRunnerEvents,
} from "./runner-lifecycle";
import {
  toolsRunnerOperations,
  toolsRunnerFrames,
  toolsRunnerEvents,
} from "./runner-tools";
import { jobRunnerOperations } from "./runner-jobs";
import {
  eventRunnerOperations,
  runnerInboundFrameSchemas,
  browserEventSchemas,
} from "./runner-events";
import {
  webAgentOperations,
  browserAgentCommandNames,
} from "./browser-agent-operations";
import { ApiErrorSchema } from "./http-helpers";
import type { OperationContract } from "./operations";
import type { SocketExchange } from "./types";

export const runnerOperations: readonly OperationContract[] = [
  ...lifecycleRunnerOperations,
  ...toolsRunnerOperations,
  ...jobRunnerOperations,
  ...eventRunnerOperations,
];
const native = new Map(
  runnerOperations.map((operation) => [operation.name, operation]),
);
const web = new Map(
  webAgentOperations.map((operation) => [operation.name, operation]),
);
/** Browser dispatch has its own allow-list; native-only commands are not advertised as accepted web operations. */
export const agentOperations: readonly OperationContract[] = [
  ...browserAgentCommandNames.map((name) => {
    const operation = web.get(name) ?? native.get(name);
    if (!operation) throw new Error(`No agent command contract for ${name}`);
    return operation;
  }),
  ...webAgentOperations.filter(
    (operation) => !browserAgentCommandNames.includes(operation.name),
  ),
];
export const AgentCommandSchema = Type.Union(
  agentOperations
    .filter((operation) => operation.name !== "ensure_session")
    .map((operation) =>
      Type.Intersect(
        [Type.Object({ type: Type.Literal(operation.name) }), operation.args],
        {
          title: `AgentCommand_${operation.name}`,
          description: operation.description,
        },
      ),
    ),
  {
    title: "AgentCommand",
    description:
      "Every accepted existing-session agent command. ensure_session belongs only to POST /api/agent/new.",
  },
);
const ensureSession = web.get("ensure_session");
if (!ensureSession) throw new Error("Missing ensure_session contract");
export const NewAgentCommandSchema = Type.Union(
  [
    AgentCommandSchema,
    Type.Intersect([
      Type.Object({ type: Type.Literal("ensure_session") }),
      ensureSession.args,
    ]),
  ],
  {
    title: "NewAgentCommand",
    description:
      "Fresh-session initialization also accepts ensure_session without submitting a prompt.",
  },
);
export const AgentCommandResultSchema = Type.Union(
  agentOperations
    .filter((operation) => operation.name !== "ensure_session")
    .map((operation) => operation.result),
  {
    title: "AgentCommandResult",
    description:
      "Successful command data. Match the command/request ID; result unions are not separately tagged.",
  },
);
export const AgentCommandResponseSchema = Type.Union(
  [
    Type.Object({
      success: Type.Literal(true),
      data: AgentCommandResultSchema,
    }),
    ApiErrorSchema,
  ],
  {
    title: "AgentCommandResponse",
    description:
      "Browser command response: success data is correlated with the request, while API errors describe dispatch failure. A successful response may acknowledge acceptance rather than completion of the resulting work.",
  },
);
export const AgentEventSchema = Type.Union([...browserEventSchemas], {
  title: "AgentEvent",
  description:
    "Events delivered to browser session subscribers, including lifecycle and agent updates. Session stream cursors identify an epoch and sequence; they are distinct from transport sequence acknowledgements.",
});
export const RunnerEventSchema = Type.Union([...runnerInboundFrameSchemas], {
  title: "RunnerEvent",
  description:
    "Native runner-to-host frames over the local runner channel, including unsolicited events and correlated responses; native frames are not restricted to the browser command allow-list.",
});
export const runnerHostFrames = [
  ...lifecycleRunnerFrames,
  ...toolsRunnerFrames,
];
export const runnerGroupEvents = [
  ...lifecycleRunnerEvents,
  ...toolsRunnerEvents,
];

/** Native command replies have numeric IDs and optional data; undefined is omitted by JSON serialization. */
export const runnerExchanges: readonly SocketExchange[] = runnerOperations.map(
  (operation) => ({
    name: operation.name,
    description: operation.description,
    correlation: "id",
    action: "send",
    request: Type.Object(
      {
        t: Type.Literal("cmd"),
        id: Type.Number(),
        op: Type.Literal(operation.name),
        args: operation.args,
      },
      {
        title: `RunnerRequest_${operation.name}`,
        description: operation.description,
      },
    ),
    response: Type.Union(
      [
        Type.Object({
          t: Type.Literal("res"),
          id: Type.Number(),
          ok: Type.Literal(true),
          data: operation.result,
        }),
        Type.Object({
          t: Type.Literal("res"),
          id: Type.Number(),
          ok: Type.Literal(false),
          error: Type.String(),
          code: Type.Optional(Type.String()),
        }),
      ],
      {
        title: `RunnerReply_${operation.name}`,
        description:
          "Match id to the submitted command. An error belongs only to that command, not to another in-flight request.",
      },
    ),
  }),
);
export const browserExchanges: readonly SocketExchange[] = agentOperations
  .filter((operation) => operation.name !== "ensure_session")
  .map((operation) => ({
    name: operation.name,
    description: operation.description,
    correlation: "rid",
    action: "receive",
    request: Type.Object(
      {
        type: Type.Literal("cmd"),
        seq: Type.Integer({ minimum: 1 }),
        rid: Type.String(),
        session: Type.String(),
        advisor: Type.Optional(Type.Boolean()),
        command: Type.Intersect([
          Type.Object({ type: Type.Literal(operation.name) }),
          operation.args,
        ]),
      },
      {
        title: `BrowserRequest_${operation.name}`,
        description: operation.description,
      },
    ),
    response: Type.Object(
      {
        type: Type.Literal("reply"),
        seq: Type.Integer({ minimum: 1 }),
        rid: Type.String(),
        status: Type.Number(),
        recvAt: Type.Number(),
        at: Type.Number(),
        deduped: Type.Boolean(),
        data: Type.Union([
          Type.Object({ success: Type.Literal(true), data: operation.result }),
          ApiErrorSchema,
        ]),
      },
      {
        title: `BrowserReply_${operation.name}`,
        description:
          "The request rid correlates this reply. HTTP-style failures are inside data and never imply that an uncertain native write is safe to retry.",
      },
    ),
  }));
