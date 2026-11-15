import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import { requestProtocol } from "@/lib/request-security";
import {
  createWebSession,
  isValidWebPassword,
  isWebPasswordEnabled,
  OMP_WEB_SESSION_COOKIE,
  OMP_WEB_SESSION_MAX_AGE_SECONDS,
} from "@/lib/web-auth";

const MAX_PASSWORD_REQUEST_BYTES = 8 * 1024;

/**
 * @apiContract postWebAuthSession
 * @apiUsage Exchange the configured web password for a browser session cookie; password protection is optional and this route returns 404 when disabled.
 * @apiInputs Send JSON containing a string password in a body no larger than 8 KiB. Invalid credentials return 401.
 * @apiInvariants The cookie is HttpOnly, SameSite=Lax, path / and has a configured maximum age. Secure is selected from the request protocol, including the first X-Forwarded-Proto value, so the proxy supplying that header must be trusted.
 * @apiEffects A valid password creates a session and sets its cookie; it does not configure the password.
 * @apiRecovery Retry with the correct password after a 401; after an uncertain response, check whether the browser received a usable cookie before issuing another session.
 */
export async function POST(request: Request) {
  if (!isWebPasswordEnabled()) {
    return Response.json(
      { error: "Password protection is disabled" },
      { status: 404 },
    );
  }

  let body: { password?: unknown };
  try {
    body = await parseJsonWithinLimit(request, MAX_PASSWORD_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return Response.json({ error: "Invalid password request" }, { status });
  }
  if (typeof body.password !== "string" || !isValidWebPassword(body.password)) {
    return Response.json({ error: "Incorrect password" }, { status: 401 });
  }

  const secure = requestProtocol(request) === "https:";
  const cookie = new Bun.Cookie(OMP_WEB_SESSION_COOKIE, createWebSession(), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: OMP_WEB_SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": cookie.serialize() } },
  );
}
