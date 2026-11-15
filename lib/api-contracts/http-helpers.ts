import { Type, type TSchema } from "@sinclair/typebox";

export const webSecurity: readonly Record<string, readonly string[]>[] = [
  { webSession: [] },
  { trustedProxy: [] },
  {},
];
export const ApiErrorSchema = Type.Object(
  {
    error: Type.String(),
    code: Type.Optional(Type.String()),
    hostOffline: Type.Optional(
      Type.Boolean({
        description:
          "When true, the owning host is offline; unavailable data does not prove that a resource or in-flight work is absent on that host.",
      }),
    ),
    delivery: Type.Optional(
      Type.Union([Type.Literal("refused"), Type.Literal("unknown")], {
        description:
          "Command delivery state when reported: refused means no native command write occurred, not that preparation had no side effects. unknown means it may have run; reconcile rather than retrying independently. An absent delivery field does not establish that a mutation was refused.",
      }),
    ),
  },
  {
    title: "ApiError",
    description:
      "An unsuccessful web-server response, not proof that a mutation was refused. Optional delivery metadata distinguishes a known refusal from uncertainty; callers must reconcile uncertain outcomes before independently retrying.",
  },
);
export const jsonResponse = (
  schema: TSchema,
  description = "Successful response.",
) => ({ description, content: { "application/json": { schema } } });
export const jsonBody = (schema: TSchema, description?: string) => ({
  required: true,
  description,
  content: { "application/json": { schema } },
});
export const pathParameter = (
  name: string,
  schema: TSchema = Type.String(),
) => ({ name, in: "path", required: true, schema });
export const queryParameter = (
  name: string,
  schema: TSchema = Type.String(),
  required = false,
  description?: string,
) => ({ name, in: "query", required, description, schema });
/** Shared gate failures supplement endpoint-specific errors, not a replacement for documenting them. */
export const webErrors = {
  400: jsonResponse(ApiErrorSchema, "Invalid request or rejected operation."),
  401: jsonResponse(
    ApiErrorSchema,
    "Authentication is required when configured.",
  ),
  403: jsonResponse(
    ApiErrorSchema,
    "Origin, ownership or authorization policy refused this request.",
  ),
  404: jsonResponse(ApiErrorSchema, "The requested resource does not exist."),
  500: jsonResponse(ApiErrorSchema, "The operation failed."),
  503: jsonResponse(
    ApiErrorSchema,
    "The owning host or required service is unavailable.",
  ),
};
