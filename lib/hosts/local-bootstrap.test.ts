import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "keylime-local-bootstrap-test-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

const { ensureLocalHostLink, localLinkUrl } =
  await import("./local-bootstrap.ts");
const { createHost, hostForToken, loadHosts, revokeHost } =
  await import("./registry.ts");

const hostJson = join(agentDir, "keylime", "host.json");
const readLogin = (): {
  url: string;
  token: string;
} => JSON.parse(readFileSync(hostJson, "utf8"));

test("bootstrap writes host.json (0600) with the loopback url and a token the registry accepts as local", async () => {
  const { token, written } = await ensureLocalHostLink({
    url: "http://127.0.0.1:30177",
  });
  assert.equal(written, true);
  assert.deepEqual(readLogin(), {
    url: "http://127.0.0.1:30177",
    token,
  });
  assert.equal(statSync(hostJson).mode & 0o777, 0o600);
  assert.equal(hostForToken(token)?.id, "local");
  assert.equal(loadHosts().filter((host) => host.id === "local").length, 1);
});

test("a second call with the same url keeps the token and does not rewrite", async () => {
  const before = readLogin();
  const mtime = statSync(hostJson).mtimeMs;
  const { token, written } = await ensureLocalHostLink({
    url: "http://127.0.0.1:30177/",
  });
  assert.equal(written, false);
  assert.equal(token, before.token);
  assert.equal(statSync(hostJson).mtimeMs, mtime);
});

test("bootstrap refuses to replace another loopback controller", async () => {
  const before = readLogin();
  await assert.rejects(
    ensureLocalHostLink({ url: "http://127.0.0.1:40000" }),
    /not to this server/,
  );
  assert.deepEqual(readLogin(), before);
});

test("a host.json token the registry does not know is replaced, keeping one local record", async () => {
  writeFileSync(
    hostJson,
    JSON.stringify({ url: "http://127.0.0.1:40000", token: "unknown" }),
  );
  const { token, written } = await ensureLocalHostLink({
    url: "http://127.0.0.1:40000",
  });
  assert.equal(written, true);
  assert.notEqual(token, "unknown");
  assert.equal(hostForToken("unknown"), null);
  assert.equal(hostForToken(token)?.id, "local");
  assert.equal(loadHosts().filter((host) => host.id === "local").length, 1);
});

test("concurrent first boots share one token", async () => {
  rmSync(hostJson);
  const url = "http://127.0.0.1:30177";
  const [a, b] = await Promise.all([
    ensureLocalHostLink({ url }),
    ensureLocalHostLink({ url }),
  ]);
  assert.equal(a.token, b.token);
  assert.equal(hostForToken(a.token)?.id, "local");
  assert.deepEqual(readLogin(), { url, token: a.token });
});

test("malformed host.json is left untouched before any local token rotation", async () => {
  const token = readLogin().token;
  writeFileSync(hostJson, "{broken");
  await assert.rejects(ensureLocalHostLink({ url: "http://127.0.0.1:40000" }), {
    name: "HostLoginUnreadableError",
  });
  assert.equal(readFileSync(hostJson, "utf8"), "{broken");
  assert.equal(hostForToken(token)?.id, "local");
});

test("the registry refuses to revoke local, and createHost never makes it", () => {
  assert.throws(() => revokeHost("local"), { name: "ReservedHostError" });
  assert.notEqual(createHost("laptop").host.id, "local");
  assert.equal(loadHosts().filter((host) => host.id === "local").length, 1);
});

test("the link url follows the launcher's port and bind address", () => {
  const url = (env: NodeJS.ProcessEnv) =>
    localLinkUrl({ KEYLIME_PORT: "30177", ...env });
  assert.deepEqual(url({}), { url: "http://127.0.0.1:30177" });
  assert.deepEqual(url({ KEYLIME_HOSTNAME: "127.0.0.1" }), {
    url: "http://127.0.0.1:30177",
  });
  assert.deepEqual(url({ KEYLIME_HOSTNAME: "0.0.0.0" }), {
    url: "http://127.0.0.1:30177",
  });
  assert.deepEqual(url({ KEYLIME_HOSTNAME: "::" }), {
    url: "http://127.0.0.1:30177",
  });
  assert.deepEqual(url({ KEYLIME_HOSTNAME: "::1" }), {
    url: "http://[::1]:30177",
  });
  assert.deepEqual(url({ KEYLIME_HOSTNAME: "[::1]" }), {
    url: "http://[::1]:30177",
  });
  // localhost resolves to whichever family the server bound: dial it by name.
  assert.deepEqual(url({ KEYLIME_HOSTNAME: "localhost" }), {
    url: "http://localhost:30177",
  });
  assert.deepEqual(url({ KEYLIME_HOSTNAME: "127.0.0.2" }), {
    url: "http://127.0.0.2:30177",
  });
});

test("a bind address the daemon could only reach over plain http is skipped with the reason", () => {
  const nonLoopback = localLinkUrl({
    KEYLIME_PORT: "30177",
    KEYLIME_HOSTNAME: "100.64.0.1",
  });
  assert.ok("skip" in nonLoopback);
  assert.match(nonLoopback.skip, /100\.64\.0\.1.*not loopback/);
  const hostname = localLinkUrl({
    KEYLIME_PORT: "30177",
    KEYLIME_HOSTNAME: "example.com",
  });
  assert.ok("skip" in hostname);
  assert.match(hostname.skip, /not loopback/);
  const noPort = localLinkUrl({});
  assert.ok("skip" in noPort);
  assert.match(noPort.skip, /KEYLIME_PORT/);
});

test("a host.json that points at another server is left alone", async () => {
  const remote = JSON.stringify({
    url: "https://main.example.com",
    token: "remote-token",
  });
  writeFileSync(hostJson, remote);
  await assert.rejects(
    ensureLocalHostLink({ url: "http://127.0.0.1:40000" }),
    /main\.example\.com/,
  );
  assert.equal(readFileSync(hostJson, "utf8"), remote);
});
