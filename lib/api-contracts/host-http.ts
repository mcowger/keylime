import { Type } from "@sinclair/typebox";

const security = [{ hostBearer: [] }];
const error = Type.Object(
  { error: Type.String() },
  { title: "Host request error" },
);
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: error } },
});
const authResponses = {
  401: errorResponse("Missing or invalid host bearer token."),
  503: errorResponse("The host registry or required service is unavailable."),
};

/** HTTP operations exposed to host daemons. */
export const hostHttpOperations = [
  {
    path: "/api/hosts/link",
    method: "get",
    route: "/api/hosts/link",
    operationId: "hostLinkUpgrade",
    summary: "Upgrade the host link",
    description:
      "The hello is the first WebSocket frame. The server refuses upgrades while shutting down.",
    security,
    responses: {
      101: { description: "WebSocket upgrade accepted." },
      ...authResponses,
      426: errorResponse("A WebSocket upgrade is required."),
    },
  },
  {
    path: "/api/hosts/link",
    method: "post",
    route: "/api/hosts/link",
    operationId: "hostLinkLegacyHello",
    summary: "Refuse an obsolete host link",
    description:
      "The hello body is inspected for its version, but malformed or oversized bodies are also refused.",
    security,
    requestBody: {
      required: false,
      content: {
        "application/json": {
          schema: Type.Unknown({
            title: "Legacy hello",
            description:
              "Obsolete hello payload; only an integer v is inspected.",
          }),
        },
      },
    },
    responses: {
      ...authResponses,
      426: {
        description: "The host must update its link protocol.",
        content: {
          "application/json": {
            schema: Type.Object(
              {
                error: Type.String(),
                hostVersion: Type.Union([Type.Number(), Type.Null()]),
                serverVersion: Type.Number(),
              },
              { title: "Link protocol mismatch" },
            ),
          },
        },
      },
    },
  },
];
