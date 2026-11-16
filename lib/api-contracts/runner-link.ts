import { Type } from "@sinclair/typebox";
import {
  runnerExchanges,
  runnerHostFrames,
  RunnerEventSchema,
} from "./runner-messages";
import type { SocketContract } from "./types";
import { UiDialogValueSchema } from "./domain";

/** Runner transport is local NDJSON, not an inbound daemon HTTP service. */
export const runnerLinkContract: SocketContract = {
  id: "runner-channel",
  title: "Host to runner channel",
  path: "keylime-runner",
  protocol: "stdio",
  security: "localProcess",
  version: 1,
  description:
    "One local runner and its owning host exchange newline-delimited JSON over child stdin/stdout or a per-user Unix socket. The socket directory is private and the socket is mode 0600; there is no remote TCP listener. Directions in this document are from the host application's perspective. The runner sends hello first, with proto, pid, identity and cwd; ready releases held commands after initialization. cmd/res IDs correlate independently of unsolicited events. Missing data is omitted, not null. UI/tool/URI requests may block and must be answered or cancelled using the corresponding frame IDs; first valid dialog answer wins. A refused channel closes and stops redialing. A lost host link does not terminate an already-running session. JSON Schema describes logical frames, not the newline byte terminator.",
  exchanges: runnerExchanges,
  send: [
    ...runnerHostFrames,
    Type.Object(
      {
        t: Type.Literal("ui_response"),
        id: Type.Number(),
        value: Type.Optional(UiDialogValueSchema),
      },
      {
        title: "RunnerUiResponse",
        description:
          "Answer a runner UI request by its local request id; omitted value means no value was supplied. The first valid dialog answer wins.",
      },
    ),
    Type.Object(
      { t: Type.Literal("ui_input"), id: Type.Number(), data: Type.String() },
      {
        title: "RunnerUiInput",
        description:
          "Forward text input to the runner UI request identified by id.",
      },
    ),
    Type.Object(
      { t: Type.Literal("refused"), reason: Type.Optional(Type.String()) },
      {
        title: "RunnerRefused",
        description:
          "Refuse the local runner channel, optionally explaining why; the runner closes it and stops redialing.",
      },
    ),
  ],
  receive: [RunnerEventSchema],
};
