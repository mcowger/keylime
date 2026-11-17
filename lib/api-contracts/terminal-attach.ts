import { Type, type Static } from "@sinclair/typebox";
import type { SocketContract } from "./types";

/** Interactive attachments are connection-scoped; input is never replayed after a disconnect. */
export const TerminalAttachClientSchema = Type.Union([
  Type.Object({ type: Type.Literal("hello"), version: Type.Literal(1), cols: Type.Integer({ minimum: 2, maximum: 1000 }), rows: Type.Integer({ minimum: 2, maximum: 1000 }) }, { title: "TerminalAttachHello", description: "Start an attachment with the protocol version and terminal dimensions." }),
  Type.Object({ type: Type.Literal("input"), data: Type.String({ maxLength: 65536 }) }, { title: "TerminalAttachInput", description: "Send terminal input once on this connection; it is never replayed." }),
  Type.Object({ type: Type.Literal("resize"), cols: Type.Integer({ minimum: 2, maximum: 1000 }), rows: Type.Integer({ minimum: 2, maximum: 1000 }) }, { title: "TerminalAttachResize", description: "Resize the attached terminal." }),
  Type.Object({ type: Type.Literal("detach") }, { title: "TerminalAttachDetach", description: "Close this attachment without ending the session." }),
], { title: "TerminalAttachClient", description: "Frames sent by an authenticated terminal client; hello must be first and input is never replayed." });
export type TerminalAttachClient = Static<typeof TerminalAttachClientSchema>;
export const TerminalAttachServerSchema = Type.Union([
  Type.Object({ type: Type.Literal("snapshot"), data: Type.String({ maxLength: 4000000 }), cols: Type.Integer({ minimum: 2, maximum: 1000 }), rows: Type.Integer({ minimum: 2, maximum: 1000 }), cursor: Type.Integer({ minimum: 0 }) }, { title: "TerminalAttachSnapshot", description: "Initial serialized terminal screen and output cursor." }),
  Type.Object({ type: Type.Literal("output"), data: Type.String({ maxLength: 262144 }), cursor: Type.Integer({ minimum: 0 }) }, { title: "TerminalAttachOutput", description: "Terminal output after the snapshot boundary." }),
  Type.Object({ type: Type.Literal("exit"), code: Type.Union([Type.Integer(), Type.Null()]) }, { title: "TerminalAttachExit", description: "The attached terminal process exited." }),
  Type.Object({ type: Type.Literal("error"), message: Type.String({ maxLength: 4096 }) }, { title: "TerminalAttachError", description: "The attachment failed and cannot continue." }),
  Type.Object({ type: Type.Literal("notice"), message: Type.String({ maxLength: 4096 }) }, { title: "TerminalAttachNotice", description: "An attachment-specific informational notice." }),
], { title: "TerminalAttachServer", description: "Frames sent to an attached terminal client, beginning with a snapshot." });
export type TerminalAttachServer = Static<typeof TerminalAttachServerSchema>;


/** The server sends the snapshot first; reconnecting never replays client input. */
export const terminalAttachContract: SocketContract = {
  id: "terminal-attach",
  title: "Session terminal attachment",
  path: "/api/terminal/attach",
  version: 1,
  security: "webSession",
  description: "Authenticated WebSocket with hostId and sessionId query parameters. The client sends hello first. A snapshot precedes output; input and resize are connection-scoped and never replayed. A new connection obtains a fresh snapshot. Slow clients or disconnected host links are closed.",
  send: TerminalAttachServerSchema.anyOf,
  receive: TerminalAttachClientSchema.anyOf,
};