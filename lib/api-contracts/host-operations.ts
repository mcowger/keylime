import { Type } from "@sinclair/typebox";
import { hostSessionOperations } from "./host-session-operations";
import { hostWorkspaceOperations } from "./host-workspace-operations";
import { hostControlOperations } from "./host-control-operations";
import type { SocketExchange } from "./types";

export const hostOperations = [
  ...hostSessionOperations,
  ...hostWorkspaceOperations,
  ...hostControlOperations,
];
const seq = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const error = Type.Object({
  type: Type.Literal("res"),
  seq,
  id: Type.String(),
  ok: Type.Literal(false),
  error: Type.Object({
    status: Type.Number(),
    code: Type.String(),
    message: Type.String(),
  }),
});

/** A reply is correlated by id, not by an invented op field. Large results use separate binary frames. */
export const hostExchanges: readonly SocketExchange[] = hostOperations.map(
  (operation) => ({
    name: operation.name,
    description: operation.description,
    correlation: "id",
    action: "send",
    request: Type.Object(
      {
        type: Type.Literal("req"),
        seq,
        id: Type.String(),
        op: Type.Literal(operation.name),
        args: operation.args,
      },
      {
        title: `HostRequest_${operation.name}`,
        description: operation.description,
      },
    ),
    response: Type.Union(
      [
        Type.Object({
          type: Type.Literal("res"),
          seq,
          id: Type.String(),
          ok: Type.Literal(true),
          result:
            operation.name === "readMedia" || operation.name === "readFileChunk"
              ? Type.Extract(
                  operation.result,
                  Type.Object({ ok: Type.Literal(false) }),
                )
              : operation.result,
        }),
        Type.Object(
          {
            type: Type.Literal("res"),
            seq,
            id: Type.String(),
            ok: Type.Literal(true),
            blob: Type.Object({ bytes: Type.Integer({ minimum: 0 }) }),
          },
          {
            description:
              "Result bytes precede this envelope in binary frames. Media/file chunks are raw bytes; other operations carry a UTF-8 JSON encoding of their logical result.",
            "x-decoded-result": operation.result,
          },
        ),
        error,
      ],
      {
        title: `HostReply_${operation.name}`,
        description: `Reply to ${operation.name}; match the request id. Outer ok:false reports a transport or dispatch error; outer ok:true can contain an inline logical operation failure (result.ok:false). Successful media and file chunks use binary frames, not inline JSON bytes. ${operation.description}`,
      },
    ),
  }),
);
