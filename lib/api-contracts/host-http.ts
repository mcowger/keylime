import { Type } from "@sinclair/typebox";
import { ConfigManifestSchema } from "../hosts/cluster-config";

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
const clusterResponses = {
  ...authResponses,
  403: errorResponse("The bearer token identifies the local host, not a linked host."),
  409: {
    description: "The configuration cannot be built.",
    content: {
      "application/json": {
        schema: Type.Object(
          { error: Type.String(), code: Type.String() },
          { title: "Configuration error" },
        ),
      },
    },
  },
  500: errorResponse("The configuration cannot be served."),
};
const brokerDescription =
  "Only content-type, accept, if-none-match, and omp-auth-broker-capabilities request headers and content-type, etag, cache-control, and vary response headers pass through. Query strings are forwarded; broker payload formats are intentionally opaque.";
const opaque = Type.Unknown({
  title: "Opaque broker payload",
  description:
    "Payload interpreted by the upstream auth broker; this proxy does not define or validate its shape.",
});
const brokerResponses = {
  ...authResponses,
  403: errorResponse("The bearer token identifies the local host, not a linked host."),
  404: errorResponse(
    "Method and path are not allowed, or the upstream returned 404.",
  ),
  413: errorResponse("Request body exceeds 1 MiB."),
  502: errorResponse("The broker request failed or was aborted."),
  default: {
    description:
      "Upstream broker response; status, body and selected headers are forwarded.",
    content: {
      "application/json": { schema: opaque },
      "text/event-stream": {
        schema: Type.String({ description: "Opaque broker event stream." }),
      },
      "application/octet-stream": {
        schema: Type.String({
          format: "binary",
          description: "Opaque broker response bytes.",
        }),
      },
    },
  },
};
const brokerRoute = "/api/hosts/broker/[...path]";
const broker = (
  method: "get" | "post" | "delete",
  suffix: string,
  operationId: string,
  summary: string,
  credential = false,
) => ({
  path: `/api/hosts/broker/v1/${suffix}`,
  method,
  route: brokerRoute,
  operationId,
  summary,
  description: brokerDescription,
  security,
  ...(credential
    ? {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Decimal credential identifier.",
            schema: Type.String({ pattern: "^[0-9]+$" }),
          },
        ],
      }
    : {}),
  ...(method !== "get"
    ? {
        requestBody: {
          required: false,
          description: "Opaque broker request body, at most 1 MiB.",
          content: {
            "application/json": { schema: opaque },
            "application/octet-stream": {
              schema: Type.String({ format: "binary" }),
            },
          },
        },
      }
    : {}),
  responses: brokerResponses,
});

/** HTTP operations exposed to host daemons; the broker's allow-list is deliberately enumerated. */
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
  {
    path: "/api/hosts/cluster-config/manifest",
    method: "get",
    route: "/api/hosts/cluster-config/manifest",
    operationId: "hostClusterManifest",
    summary: "Get cluster configuration manifest",
    description: "Returns the web server's current configuration to a linked host.",
    security,
    responses: {
      200: {
        description: "Current manifest.",
        content: { "application/json": { schema: ConfigManifestSchema } },
      },
      ...clusterResponses,
    },
  },
  {
    path: "/api/hosts/cluster-config/file/{hash}",
    method: "get",
    route: "/api/hosts/cluster-config/file/[hash]",
    operationId: "hostClusterFile",
    summary: "Get a mirrored configuration file",
    description:
      "The hash addresses content in the current manifest, not an older configuration.",
    security,
    parameters: [
      {
        name: "hash",
        in: "path",
        required: true,
        description: "Lowercase SHA-256 content hash.",
        schema: Type.String({ pattern: "^[0-9a-f]{64}$" }),
      },
    ],
    responses: {
      200: {
        description: "Current file bytes.",
        content: {
          "application/octet-stream": {
            schema: Type.String({ format: "binary" }),
          },
        },
      },
      ...clusterResponses,
      404: errorResponse(
        "Hash is invalid or absent from the current manifest.",
      ),
    },
  },
  broker("get", "healthz", "hostBrokerHealth", "Get broker health"),
  broker("get", "snapshot", "hostBrokerSnapshot", "Get broker snapshot"),
  broker(
    "get",
    "snapshot/stream",
    "hostBrokerSnapshotStream",
    "Stream broker snapshots",
  ),
  broker(
    "get",
    "credentials/disabled",
    "hostBrokerDisabledCredentials",
    "Get disabled credentials",
  ),
  broker("get", "usage", "hostBrokerUsage", "Get broker usage"),
  broker(
    "get",
    "usage/history",
    "hostBrokerUsageHistory",
    "Get broker usage history",
  ),
  broker(
    "get",
    "usage/clients",
    "hostBrokerUsageClients",
    "Get broker usage clients",
  ),
  broker(
    "post",
    "credential/{id}/refresh",
    "hostBrokerRefreshCredential",
    "Refresh a credential",
    true,
  ),
  broker(
    "post",
    "credential/{id}/disable",
    "hostBrokerDisableCredential",
    "Disable a credential",
    true,
  ),
  broker(
    "post",
    "credential/{id}/block",
    "hostBrokerBlockCredential",
    "Block a credential",
    true,
  ),
  broker(
    "delete",
    "credential/{id}/block",
    "hostBrokerDeleteCredentialBlock",
    "Delete a credential block",
    true,
  ),
  broker(
    "delete",
    "credential/{id}/blocks",
    "hostBrokerDeleteCredentialBlocks",
    "Delete credential blocks",
    true,
  ),
  broker(
    "post",
    "usage/observed",
    "hostBrokerObservedUsage",
    "Report observed usage",
  ),
  broker("post", "usage/stale", "hostBrokerStaleUsage", "Report stale usage"),
];
