import type { TSchema } from "@sinclair/typebox";

export interface SocketExchange {
  name: string;
  /** Usage, input, invariant, side-effect and recovery guidance for this correlated exchange. */
  description: string;
  request: TSchema;
  response: TSchema;
  /** Correlation field is an actual wire field, not an invented operation discriminator. */
  correlation: "id" | "rid";
  action: "send" | "receive";
}

/** Documentation metadata only: neither the server nor worker installs schema validation. */
export interface SocketContract {
  /** Stable document name, independent of the release version. */
  id: string;
  title: string;
  path: string;
  version: number;
  /** Framing, byte/character units, ordering, authentication and lifecycle obligations emitted in AsyncAPI. */
  description: string;
  security: "hostBearer" | "webSession" | "localProcess";
  protocol?: "wss" | "stdio";
  exchanges?: readonly SocketExchange[];
  /** Serving-application perspective: web server for remote links, host daemon for its local runner channel. */
  send: readonly TSchema[];
  receive: readonly TSchema[];
}
