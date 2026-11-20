// The web server's side of the local daemon link: keep the `local` host record
// and the daemon's host.json in step. Pure Node: no Next or `@/` imports.
import { isLoopbackHost, loginHost } from "./host-login";
import { hostForToken, LOCAL_HOST_ID, rotateLocalHostToken } from "./registry";

/** Where the daemon dials this server, or why it cannot: the daemon uses plain http only on loopback, so a bind address elsewhere gets no link. */
export function localLinkUrl(
  env: NodeJS.ProcessEnv = process.env,
): { url: string } | { skip: string } {
  const port = env.KEYLIME_PORT;
  if (!port)
    return {
      skip: "KEYLIME_PORT is not set (the dev server does not link the daemon)",
    };
  const bind = env.KEYLIME_HOSTNAME || "127.0.0.1";
  // A wildcard bind also answers on 127.0.0.1; "localhost" is dialed by name, so it matches whichever family the server bound.
  const host = ["0.0.0.0", "::", "[::]"].includes(bind)
    ? "127.0.0.1"
    : bind === "::1"
      ? "[::1]"
      : bind;
  if (!isLoopbackHost(host))
    return {
      skip: `KEYLIME_HOSTNAME=${bind} is not loopback, so the local daemon cannot link to it over http`,
    };
  return { url: `http://${host}:${port}` };
}

/** Bootstrap the local controller without taking over a daemon linked elsewhere. */
export async function ensureLocalHostLink(input: {
  url: string;
}): Promise<{ token: string; written: boolean }> {
  const url = input.url.replace(/\/+$/, "");
  let token = "";
  let written = false;
  await loginHost((saved) => {
    if (saved && saved.url !== url) {
      throw new Error(
        `host.json links this machine's daemon to ${saved.url}, not to this server; remove it to use this server for "This machine"`,
      );
    }
    // Select the token under the configuration lock so concurrent boots cannot rotate it twice.
    token =
      saved && hostForToken(saved.token)?.id === LOCAL_HOST_ID
        ? saved.token
        : rotateLocalHostToken();
    written = saved?.token !== token;
    return { url, token };
  });
  return { token, written };
}
