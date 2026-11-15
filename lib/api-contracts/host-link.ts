import { Type } from "@sinclair/typebox";
import {
  LINK_CLOSE,
  LINK_LIMITS,
  LINK_PROTOCOL_VERSION,
  MIN_LINK_PROTOCOL_VERSION,
} from "../hosts/link-protocol";
import { DownMessageSchema, UpMessageSchema } from "./host-schemas";
import type { SocketContract } from "./types";
import { hostExchanges } from "./host-operations";
import { runnerLinkContract } from "./runner-link";

const uploadFrame = Type.String({
  format: "binary",
  title: "HostLinkUploadFrame",
  description:
    "A server-to-daemon upload piece: one unsigned byte n, followed by n UTF-8 bytes of the plain upload ID (1..255), followed by raw payload. The internal up:<id> scheduling key is not encoded in this header. Frames are associated with their upload start and acknowledged by upload_ack.",
});
const resultFrame = Type.String({
  format: "binary",
  title: "HostLinkResultFrame",
  description:
    "A daemon-to-server result piece: one unsigned byte n, followed by n UTF-8 bytes of request ID (1..255), followed by raw payload. Result frames precede the successful res declaring total blob length; a result may span multiple frames.",
});

/** Directions are from the web server's perspective. */
export const hostLinkContract: SocketContract = {
  id: "host-link",
  title: "Host daemon link",
  path: "/api/hosts/link",
  version: LINK_PROTOCOL_VERSION,
  security: "hostBearer",
  exchanges: hostExchanges,
  description: `Authenticated daemon WebSocket; the daemon sends hello first and the server replies welcome. Current protocol is ${LINK_PROTOCOL_VERSION}, minimum ${MIN_LINK_PROTOCOL_VERSION}; incompatible peers close ${LINK_CLOSE.versionMismatch}. Text frames are newline-delimited JSON, with daemon frames allowed to batch lines. stdin/stdout line strings contain runner-channel frames described by x-content-schema and runner-channel.asyncapi.json. All ${hostExchanges.length} operation exchanges define their arguments and correlated replies; unknown future operations still receive 501 unknown_op. Sequenced messages are cumulatively acknowledged and retained until acked, replayed after reconnect and deduplicated by sequence. Unknown or wrong-direction types are skipped but acknowledged. Ping/pong/ack are unsequenced controls. Long lines use part messages with UTF-16 offsets, joined before parsing. Binary frames contain one length byte, that many UTF-8 ID bytes (1..255), then payload. Upload headers carry the plain upload ID; up:<id> is only an internal scheduling key and is not encoded on the wire. Result headers carry the request ID; result bytes arrive before the res envelope naming their total length. Control messages bypass fair per-key queues and the unacked window. Limits: ${LINK_LIMITS.pieceBytes} bytes per part/binary payload, ${LINK_LIMITS.unackedBytes} unacked bytes, ${LINK_LIMITS.maxLineBytes} bytes per joined JSON line, ${LINK_LIMITS.blobBytes} bytes per result blob. Invalid or excess stats samples are discarded and counted by the receiver; invalid is decoder-only. Invalid data/policy/size failures close ${LINK_CLOSE.invalidData}/${LINK_CLOSE.policy}/${LINK_CLOSE.tooBig}; a replaced link closes ${LINK_CLOSE.replaced}. A failed op is never replayed after its caller was told it failed; link loss after dispatch can leave delivery uncertain.`,
  send: [
    ...DownMessageSchema.anyOf.map((schema) =>
      schema.title === "HostLinkStdin"
        ? Type.Object(
            {
              ...schema.properties,
              line: Type.String({
                contentMediaType: "application/json",
                "x-content-schema": Type.Union([
                  ...runnerLinkContract.send,
                  ...(runnerLinkContract.exchanges ?? []).map(
                    (exchange) => exchange.request,
                  ),
                ]),
              }),
            },
            {
              title: schema.title,
              description:
                "Serialized local runner input frame for the identified child channel; the native runner contract defines its contents and request IDs.",
            },
          )
        : schema,
    ),
    uploadFrame,
  ],
  receive: [
    ...UpMessageSchema.anyOf.map((schema) =>
      schema.title === "HostLinkStdout"
        ? Type.Object(
            {
              ...schema.properties,
              line: Type.String({
                contentMediaType: "application/json",
                "x-content-schema": Type.Union([...runnerLinkContract.receive]),
              }),
            },
            {
              title: schema.title,
              description:
                "Serialized local runner output frame for the identified child channel; transport loss does not itself end the session.",
            },
          )
        : schema,
    ),
    resultFrame,
  ],
};
