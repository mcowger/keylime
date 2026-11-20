import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { HostRow as HubHostRow } from "./hub";

const agentDir = mkdtempSync(join(tmpdir(), "keylime-hosts-route-test-"));
const configEnv = [
  "HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];
const previousEnv = new Map(configEnv.map((key) => [key, process.env[key]]));
for (const key of configEnv) delete process.env[key];
process.env.HOME = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.XDG_CONFIG_HOME = join(agentDir, "config");
process.env.XDG_DATA_HOME = join(agentDir, "data");
after(() => {
  // The hub's held link samples go to this file's agent dir, before it is gone.
  hub.flushLinkSamples();
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(agentDir, { recursive: true, force: true });
});

const route = await import("../../app/api/hosts/route.ts");
// Load the release handlers after isolating the agent directory, like the hosts route.
const releases = await import("../../app/api/hosts/[id]/releases/route.ts");
const hub = await import("./hub.ts");
const { LinkDriver, upgradeSocket } =
  await import("./link-driver.test-helper.ts");

const hostsFile = join(agentDir, "keylime", "hosts.json");
const BASE = "http://main.test/api/hosts";

const send = (
  method: "POST" | "PATCH",
  body: unknown,
  headers: Record<string, string> = {},
) =>
  route[method](
    new Request(BASE, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
type HostRow = HubHostRow & {
  serverPlatform?: string;
};
const get = async (): Promise<{ hosts: HostRow[] }> =>
  (await route.GET()).json();

test("POST returns the token once; GET lists the host without any secret", async () => {
  const response = await send(
    "POST",
    { label: "  laptop " },
    { host: "omp.example.com:8443", "x-forwarded-proto": "https" },
  );
  assert.equal(response.status, 200);
  const { host, token, command } = await response.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(host.label, "laptop");
  assert.equal(
    command,
    "keylime host login --url https://omp.example.com:8443",
  );

  const text = JSON.stringify(await get());
  assert.ok(!text.includes(token) && !text.includes("tokenHash"));
  const { hosts }: { hosts: HostRow[] } = JSON.parse(text);
  assert.equal(hosts[0].id, "local");
  for (const row of [host, ...hosts]) {
    assert.ok(!("allowAgentStart" in row));
  }
  assert.equal(hosts[0].serverPlatform, process.platform);
  assert.deepEqual(
    hosts.slice(1).map((h) => [h.id, h.status]),
    [[host.id, "offline"]],
  );
});

test("the command follows x-forwarded-host over the request host", async () => {
  const response = await send(
    "POST",
    { label: "box" },
    { "x-forwarded-host": "proxy.example.com", "x-forwarded-proto": "https" },
  );
  assert.equal(
    (await response.json()).command,
    "keylime host login --url https://proxy.example.com",
  );
});

test("DELETE revokes: the host's socket closes and its token then gets 401 on the link", async () => {
  const { host, token } = await (
    await send("POST", { label: "doomed" })
  ).json();
  const link = new LinkDriver(host.id, token);
  await link.dial();

  const response = await route.DELETE(
    new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }),
  );
  assert.equal(response.status, 200);
  assert.equal(await link.next(), null, "revoking closes the host's socket");
  assert.equal(upgradeSocket(token).response?.status, 401);
  assert.ok(!(await get()).hosts.some((h) => h.id === host.id));
  assert.equal(
    (
      await route.DELETE(
        new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }),
      )
    ).status,
    404,
  );
});

test("PATCH renames a linked host", async () => {
  const { host } = await (await send("POST", { label: "old" })).json();
  const patched = await send("PATCH", {
    id: host.id,
    label: "new",
  });
  assert.equal(patched.status, 200);
  const row = (await get()).hosts.find((h) => h.id === host.id);
  assert.equal(row?.label, "new");

  assert.equal(
    (await send("PATCH", { id: "missing", label: "x" })).status,
    404,
  );
});

test("PATCH rejects unknown fields, even alongside a valid rename", async () => {
  const { host } = await (await send("POST", { label: "linked" })).json();
  const before = await get();
  for (const id of [host.id, "local"]) {
    for (const label of [undefined, "new"]) {
      const response = await send("PATCH", {
        id,
        label,
        allowAgentStart: true,
      });
      assert.equal(response.status, 400);
    }
  }
  assert.equal(
    (await send("PATCH", { poolId: "workers", label: "new" })).status,
    400,
  );
  assert.equal(
    (await send("PATCH", { id: host.id, poolId: "workers", label: "new" }))
      .status,
    400,
  );
  assert.equal("PUT" in route, false);
  assert.deepEqual(await get(), before);
});

test("bodies are validated at the route", async () => {
  assert.equal((await send("POST", {})).status, 400);
  assert.equal((await send("POST", { label: "   " })).status, 400);
  assert.equal((await send("POST", { label: 5 })).status, 400);
  assert.equal((await send("POST", { label: "x".repeat(101) })).status, 400);
  assert.equal((await send("POST", { label: "x".repeat(100) })).status, 200);
  const { host } = await (await send("POST", { label: "ok" })).json();
  for (const body of [
    { id: host.id },
    { id: host.id, label: "" },
    { id: host.id, label: "y".repeat(101) },
    { label: "no id" },
  ])
    assert.equal((await send("PATCH", body)).status, 400, JSON.stringify(body));
  assert.equal(
    (await route.POST(new Request(BASE, { method: "POST", body: "{nope" })))
      .status,
    400,
  );
});

test("an unreadable hosts.json answers 503 and is never rewritten", async () => {
  const { host } = await (await send("POST", { label: "keep" })).json();
  const broken = "{not json";
  mkdirSync(join(hostsFile, ".."), { recursive: true });
  writeFileSync(hostsFile, broken);

  assert.equal((await send("POST", { label: "new" })).status, 503);
  assert.equal((await send("PATCH", { id: host.id, label: "x" })).status, 503);
  assert.equal(
    (
      await route.DELETE(
        new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }),
      )
    ).status,
    503,
  );
  assert.equal(readFileSync(hostsFile, "utf8"), broken);
});

test("the local row and getHost(local) show the reserved record's real link status", async () => {
  writeFileSync(hostsFile, '{"hosts":[]}');
  const { ensureLocalHostLink } = await import("./local-bootstrap.ts");
  const localRows = async () =>
    (await get()).hosts.filter((h) => h.id === "local");

  // Dev server, or before the first bootstrap: no record, no daemon.
  assert.deepEqual(
    (await localRows()).map((h) => [h.label, h.status]),
    [["", "offline"]],
    "no custom name: the UI shows the localized default",
  );
  assert.equal(hub.getHost("local").status(), "offline");

  const { token } = await ensureLocalHostLink({
    url: "http://127.0.0.1:30177",
  });
  assert.deepEqual(
    (await localRows()).map((h) => h.status),
    ["offline"],
    "a record alone is not a link",
  );

  await new LinkDriver("local", token).dial();
  const [row] = await localRows();
  assert.equal(row.status, "online");
  assert.equal(row.ompVersion, "14.0.0");
  assert.equal((await get()).hosts[0].id, "local");
  assert.equal((await get()).hosts.filter((h) => h.id === "local").length, 1);

  // Sessions on this machine run through the same link.
  const local = hub.getHost("local");
  assert.equal(local.id, "local");
  assert.equal(local.status(), "online");

  assert.equal(
    (await route.DELETE(new Request(`${BASE}?id=local`, { method: "DELETE" })))
      .status,
    400,
  );

  // Renamed, the name reaches the row and server-side text; an empty or blank name resets it.
  const renamed = await send("PATCH", { id: "local", label: "  Desk " });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).host.label, "Desk");
  assert.deepEqual(
    (await localRows()).map((h) => h.label),
    ["Desk"],
  );
  assert.equal(hub.getHost("local").label, "Desk");
  assert.equal(
    (await send("PATCH", { id: "local", label: "x".repeat(101) })).status,
    400,
  );
  assert.equal((await send("PATCH", { id: "local", label: 5 })).status, 400);
  assert.equal((await send("PATCH", { id: "local" })).status, 400);
  assert.equal((await send("PATCH", { id: "local", label: "  " })).status, 200);
  assert.deepEqual(
    (await localRows()).map((h) => h.label),
    [""],
  );
  assert.equal(hub.getHost("local").label, "This machine");
});

test("release deployment refuses an installed pair even if an earlier check found a difference", async () => {
  const arch = process.arch === "arm64" ? "x64" : "arm64";
  const fixture = join(agentDir, `release/keylime-linux-${arch}`);
  mkdirSync(fixture, { recursive: true });
  for (const name of ["keylime", "keylime-omp"]) {
    const path = join(fixture, name);
    writeFileSync(path, name);
    chmodSync(path, 0o755);
  }

  const previous = process.env.KEYLIME_PACKAGE_DIR;
  process.env.KEYLIME_PACKAGE_DIR = agentDir;
  const { host, token } = await (
    await send("POST", { label: "Release host" })
  ).json();
  const link = new LinkDriver(host.id, token);
  try {
    await link.dial({
      hello: { arch, canActivateArtifact: true, canReportBinaryDigests: true },
    });
    const keylime = new Bun.CryptoHasher("sha256")
      .update("keylime")
      .digest("hex");
    const runner = new Bun.CryptoHasher("sha256")
      .update("keylime-omp")
      .digest("hex");
    let installedRunner: string | null = null;
    const ops: string[] = [];
    void link.serve({
      hostInstalledBinaryDigests() {
        ops.push("compare");
        return { keylime, runner: installedRunner };
      },
      uploadStart() {
        ops.push("upload");
        throw new Error("A matching build must not start uploading");
      },
    });

    const url = `${BASE}/${host.id}/releases`;
    const context = { params: Promise.resolve({ id: host.id }) };
    const list = async () =>
      (await releases.GET(new Request(url), context)).json();
    const initial = (await list()).releases[0];
    assert.equal(initial.status, "different");
    installedRunner = runner;
    const deployment = await releases.POST(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({
          releaseId: initial.id,
          operationId: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
      }),
      { ...context, disableIdleTimeout() {} },
    );
    const frames = (await deployment.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].status, 409);
    assert.equal(frames[0].code, "host_release_already_installed");
    assert.deepEqual(ops, ["compare", "compare"]);
    assert.equal((await list()).releases[0].status, "installed");

    // The runner changed on the server without changing its filename or size.
    writeFileSync(join(fixture, "keylime-omp"), "keylime-new");
    assert.equal((await list()).releases[0].status, "different");
  } finally {
    if (link.socket) link.drop();
    if (previous === undefined) delete process.env.KEYLIME_PACKAGE_DIR;
    else process.env.KEYLIME_PACKAGE_DIR = previous;
  }
});
