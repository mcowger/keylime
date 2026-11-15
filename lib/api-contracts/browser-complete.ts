import { Type, type TObject, type TSchema } from "@sinclair/typebox";
import { browserLinkContract } from "./browser-link";
import {
  AgentCommandSchema,
  AgentCommandResponseSchema,
  browserExchanges,
} from "./runner-messages";
import { StreamPayloadSchema } from "./stream-payloads";
import type { SocketContract } from "./types";

/** The decoder's untrusted header stays permissive; public message bodies use the complete protocol registries. */
function refine(schema: TSchema): TSchema {
  if (
    !["BrowserCommand", "BrowserReply", "BrowserEvent"].includes(
      schema.title ?? "",
    )
  )
    return schema;
  // These are known Type.Object envelope definitions from the source registry, not external values.
  const envelope = schema as TObject;
  const property = schema.title === "BrowserCommand" ? "command" : "data";
  const payload =
    schema.title === "BrowserCommand"
      ? AgentCommandSchema
      : schema.title === "BrowserReply"
        ? AgentCommandResponseSchema
        : StreamPayloadSchema;
  return Type.Object(
    { ...envelope.properties, [property]: payload },
    {
      title: schema.title,
      description:
        schema.title === "BrowserEvent"
          ? "Multiplexed subscription event: name chooses the subscribed channel or mux controls; data is a JSON value and the worker preserves its serialization. Consumers decode by channel and inner discriminator. Session cursors are independent of link acknowledgements; a merged delta's web.first marks the first sequence represented, and a snapshot inside that range cannot safely apply it."
          : schema.description,
    },
  );
}
export const completeBrowserLinkContract: SocketContract = {
  ...browserLinkContract,
  description: browserLinkContract.description,
  send: browserLinkContract.send.map(refine),
  receive: browserLinkContract.receive.map(refine),
  exchanges: browserExchanges,
};
