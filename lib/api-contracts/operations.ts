import type { TSchema } from "@sinclair/typebox";

/** Source metadata for one HTTP handler; generated documents never serve as an authoring source. */
export interface HttpOperation {
  /** OpenAPI URL template, with braces for client-visible path parameters. */
  path: string;
  /** Registered source route, retaining the router's bracketed segment syntax for handler binding. */
  route: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  operationId: string;
  summary: string;
  /** Optional extra detail; primary client semantics are extracted from this handler's five @api tags. */
  description?: string;
  parameters?: readonly Record<string, unknown>[];
  requestBody?: Record<string, unknown>;
  /** Status/media alternatives; distinguish acceptance, completion, streaming and uncertain outcomes. */
  responses: Record<string, unknown>;
  security?: readonly Record<string, readonly string[]>[];
}

/** One named request/reply exchange; schemas describe logical payloads before binary transport framing. */
export interface OperationContract {
  name: string;
  /** Required Usage, Inputs, Invariants, Effects and Recovery sections; preserve native/web differences explicitly. */
  description: string;
  /** Logical named arguments before the transport's req/cmd envelope; dynamic extension JSON must be labeled. */
  args: TSchema;
  /** Logical result, including any OpResult wrapper. Undefined omits the wire field; it is not JSON null. */
  result: TSchema;
}
