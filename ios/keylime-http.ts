import type { operations } from "./generated/web-http";
import { nativeRequest } from "./native-network";
import { readChatCreation } from "./chat-creation";

export type HostsResponse =
  operations["getHosts"]["responses"][200]["content"]["application/json"];
type LoginRequest =
  operations["postWebAuthSession"]["requestBody"]["content"]["application/json"];
type LoginResponse =
  operations["postWebAuthSession"]["responses"][200]["content"]["application/json"];
type CreateChatOperation = operations["createAgentSession"];
type EnsureChatRequest = Extract<
  CreateChatOperation["requestBody"]["content"]["application/json"],
  { type: "ensure_session" }
>;

export type HttpErrorKind =
  "unauthorized" | "unreachable" | "http" | "invalid-response";

export class KeylimeHttpError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    readonly status?: number,
  ) {
    super(
      kind === "unauthorized"
        ? "Authentication required"
        : kind === "unreachable"
          ? "Could not reach server"
          : kind === "invalid-response"
            ? "Invalid server response"
            : `Server request failed${status ? ` (${status})` : ""}`,
    );
    this.name = "KeylimeHttpError";
  }
}

/** Accept an origin, not a URL with credentials, a path, a query, or a fragment. */
export function normalizeOrigin(input: string): string {
  // React Native's URL polyfill does not fully validate URLs or normalize origins.
  const match =
    /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?\/?$/i.exec(
      input.trim(),
    );
  if (!match)
    throw new Error(
      "Enter a valid server origin, such as https://keylime.example.com.",
    );
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  const port = match[3] === undefined ? undefined : Number(match[3]);
  if (
    !host.startsWith("[") &&
    (host.startsWith(".") ||
      host.endsWith(".") ||
      host.includes("..") ||
      host
        .split(".")
        .some((label) => label.startsWith("-") || label.endsWith("-")))
  ) {
    throw new Error(
      "Enter a valid server origin, such as https://keylime.example.com.",
    );
  }
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw new Error(
      "Enter a valid server origin, such as https://keylime.example.com.",
    );
  }
  const defaultPort =
    (scheme === "http" && port === 80) || (scheme === "https" && port === 443);
  return `${scheme}://${host}${port === undefined || defaultPort ? "" : `:${port}`}`;
}

/** The native transport refuses redirects and confines cookies to the selected origin. */
async function request(
  origin: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const server = normalizeOrigin(origin);
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\#\x00-\x1f\x7f]/.test(path)
  ) {
    throw new Error("Request path must be relative to the server origin.");
  }
  let response: Response;
  try {
    response = await nativeRequest(server, path, {
      ...init,
      credentials: "include",
    });
  } catch {
    throw new KeylimeHttpError("unreachable");
  }
  if (response.status === 401) throw new KeylimeHttpError("unauthorized", 401);
  return response;
}

export async function requestJson<T>(
  origin: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await request(origin, path, init);
  if (!response.ok) throw new KeylimeHttpError("http", response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new KeylimeHttpError("invalid-response", response.status);
  }
}

export async function ensureChatSession(
  origin: string,
  body: EnsureChatRequest,
) {
  const response = await request(origin, "/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await readChatCreation(response);
  if (result) return result;
  throw new KeylimeHttpError(
    response.ok ? "invalid-response" : "http",
    response.status,
  );
}

export async function getHosts(origin: string): Promise<HostsResponse> {
  const response = await requestJson<HostsResponse>(origin, "/api/hosts");
  if (!response || !Array.isArray(response.hosts))
    throw new KeylimeHttpError("invalid-response");
  return response;
}

/** The password is sent only to the selected origin and is never persisted. */
export async function createSession(
  origin: string,
  password: string,
): Promise<LoginResponse> {
  const body: LoginRequest = { password };
  const response = await requestJson<LoginResponse>(
    origin,
    "/api/web-auth/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response || response.ok !== true)
    throw new KeylimeHttpError("invalid-response");
  return response;
}
