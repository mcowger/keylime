import { translate } from "./index";

/**
 * Client-side rendering of API error payloads. Routes attach a stable `code`
 * to well-known failures; the dictionary maps `errors.<code>` to an English
 * message. Unknown or dynamic errors fall back to the server's text.
 */
export interface ApiErrorPayload {
  error?: string;
  code?: string;
}

export function formatApiError(
  payload: ApiErrorPayload | string | null | undefined,
  fallbackKey = "errors.generic",
): string {
  if (typeof payload === "string") return payload;
  const code = payload?.code;
  if (code) {
    const key = `errors.${code}`;
    const message = translate(key);
    if (message !== key) return message;
  }
  if (payload?.error) return payload.error;
  const fallback = translate(fallbackKey);
  return fallback === fallbackKey ? "Request failed" : fallback;
}
