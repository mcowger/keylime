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
import test, { after, type TestContext } from "node:test";
import type { HostRow as HubHostRow } from "./hub";
import type { HostPool } from "./pools";

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
const hub = await import("./hub.ts");
const { LinkDriver, upgradeSocket } =
  await import("./link-driver.test-helper.ts");
const { LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");

const hostsFile = join(agentDir, "keylime", "hosts.json");
const poolsFile = join(agentDir, "keylime", "pools.json");
const BASE = "http://main.test/api/hosts";

const send = (
  method: "POST" | "PATCH" | "PUT",
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
const get = async (): Promise<{ hosts: HostRow[]; pools: HostPool[] }> =>
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
  assert.equal(command, "keylime host login --url https://omp.example.com:8443");

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
      const response = await send("PATCH", { id, label, allowAgentStart: true });
      assert.equal(response.status, 400);
    }
  }
  assert.deepEqual(await get(), before);
});

test("revoking a cluster member removes it from the pool", async (t) => {
  const { host: member } = await (
    await send("POST", { label: "member" })
  ).json();
  seedPools(t, [member.id]);
  writeFileSync(poolsFile, "{not json");

  const revoke = () =>
    route.DELETE(new Request(`${BASE}?id=${member.id}`, { method: "DELETE" }));
  assert.equal(
    (await revoke()).status,
    503,
    "membership unknown: the revoke could leave a stale member",
  );
  assert.equal(readFileSync(poolsFile, "utf8"), "{not json");

  const pool = seedPools(t, ["local", member.id]);
  assert.ok((await get()).hosts.some((host) => host.id === member.id));
  assert.equal((await revoke()).status, 200);
  assert.ok(!(await get()).hosts.some((host) => host.id === member.id));
  // Revoking leaves the cluster by leaveCluster's rules: the member is gone, its checkout inside its folder stays bound.
  assert.deepEqual((await get()).pools, [
    { ...pool, members: pool.members.filter((m) => m.hostId !== member.id) },
  ]);
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

test("an unreadable hosts.json answers 503 and is never rewritten; a revoke leaves the cluster untouched", async (t) => {
  const { host } = await (await send("POST", { label: "keep" })).json();
  seedPools(t, ["local", host.id]);
  const pools = readFileSync(poolsFile, "utf8");
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
  assert.equal(
    readFileSync(poolsFile, "utf8"),
    pools,
    "the member stays while its record and link remain",
  );
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

function configuredPool(hostIds: string[] = ["local"]) {
  return {
    id: "workers",
    label: "Workers",
    enabled: true,
    members: hostIds.map((hostId) => ({
      hostId,
      projectsRoot: "/srv/projects",
      provisioned: true,
      draining: false,
    })),
    projects: [
      {
        id: "app",
        name: "App",
        origin: "https://example.com/team/app.git",
        defaultRef: "main",
        clonePaths: Object.fromEntries(
          hostIds.map((id) => [id, "/srv/projects/app"]),
        ),
        addedAt: "2026-11-10T00:00:00.000Z",
        hidden: false,
        alias: "Work",
        sortOrder: 2,
        pinOrder: 1,
        launchConfig: {
          profile: "coding",
          advisor: true,
          extraArgs: ["--verbose"],
        },
      },
    ],
  };
}

function seedPools(t: TestContext, hostIds?: string[]) {
  const pool = configuredPool(hostIds);
  writeFileSync(
    poolsFile,
    `${JSON.stringify({ version: 1, pools: [pool] }, null, 2)}\n`,
  );
  t.after(() => rmSync(poolsFile, { recursive: true, force: true }));
  return pool;
}

test("GET with no pool file retains standalone hosts and adds an empty pools list", async () => {
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.pools, []);
  assert.equal(body.hosts[0].id, "local");
  assert.ok(!JSON.stringify(body).includes("tokenHash"));
});

test("PUT replaces the complete pool registry and GET returns its project metadata", async (t) => {
  t.after(() => rmSync(poolsFile, { recursive: true, force: true }));
  const { host } = await (await send("POST", { label: "Pool worker" })).json();
  const pool = configuredPool(["local", host.id]);
  const response = await send("PUT", { pools: [pool] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await get()).pools, [pool]);
  assert.deepEqual(JSON.parse(readFileSync(poolsFile, "utf8")), {
    version: 1,
    pools: [pool],
  });

  const { host: unlisted } = await (
    await send("POST", { label: "Not a member" })
  ).json();
  assert.ok(
    !(await get()).pools[0].members.some(
      (member) => member.hostId === unlisted.id,
    ),
  );
  assert.equal(
    (await send("PATCH", { id: host.id, label: "Renamed worker" })).status,
    200,
  );
  assert.deepEqual(
    (await get()).pools,
    [pool],
    "standalone changes do not change explicit membership",
  );

  const replacement = {
    ...pool,
    id: "replacement",
    label: "Replacement",
    enabled: false,
    members: [],
  };
  assert.equal((await send("PUT", { pools: [replacement] })).status, 200);
  assert.deepEqual((await get()).pools, [replacement]);
  assert.equal((await send("PUT", { pools: [] })).status, 200);
  assert.deepEqual((await get()).pools, []);
  assert.deepEqual(JSON.parse(readFileSync(poolsFile, "utf8")), {
    version: 1,
    pools: [],
  });
});

test("PUT tells hosts subscribers, so open hosts streams get the new pools; a refused PUT tells nobody", async (t) => {
  t.after(() => rmSync(poolsFile, { recursive: true, force: true }));
  const frames: (HostPool[] | undefined)[] = [];
  t.after(hub.onHostsChange(() => frames.push(hub.hostsSnapshot().pools)));
  const pool = configuredPool();
  assert.equal((await send("PUT", { pools: [pool] })).status, 200);
  assert.deepEqual(frames, [[pool]]);
  assert.equal(
    (await send("PUT", { pools: [{ ...pool, members: "broken" }] })).status,
    400,
  );
  assert.equal(frames.length, 1);
});

test("PUT rejects malformed and ambiguous bodies without changing existing pool bytes", async (t) => {
  const pool = seedPools(t);
  const original = readFileSync(poolsFile, "utf8");
  for (const body of [
    null,
    [],
    {},
    { pools: null },
    { pools: {} },
    ...[
      "id",
      "label",
      "allowAgentStart",
      "hosts",
      "status",
      "linkProtocol",
      "capacity",
      "unexpected",
    ].map((key) => ({
      pools: [pool],
      [key]: key === "allowAgentStart" ? true : "forged",
    })),
  ]) {
    assert.equal((await send("PUT", body)).status, 400, JSON.stringify(body));
    assert.equal(readFileSync(poolsFile, "utf8"), original);
  }
  assert.equal(
    (await route.PUT(new Request(BASE, { method: "PUT", body: "{broken" })))
      .status,
    400,
  );
  assert.equal(readFileSync(poolsFile, "utf8"), original);
});

test("PUT rejects invalid pool domain data without replacing the last valid configuration", async (t) => {
  const pool = seedPools(t);
  const original = readFileSync(poolsFile, "utf8");
  for (const pools of [
    [{ ...pool, id: "../escape" }],
    [pool, pool],
    [{ ...pool, enabled: "yes" }],
    [{ ...pool, members: [pool.members[0], pool.members[0]] }],
    [{ ...pool, members: [{ ...pool.members[0], projectsRoot: "relative" }] }],
    [{ ...pool, members: [{ ...pool.members[0], provisioned: "yes" }] }],
    [
      {
        ...pool,
        projects: [
          {
            ...pool.projects[0],
            origin: "https://user:secret@example.com/app.git",
          },
        ],
      },
    ],
    [
      {
        ...pool,
        projects: [{ ...pool.projects[0], clonePaths: { local: "relative" } }],
      },
    ],
    [
      {
        ...pool,
        projects: [
          { ...pool.projects[0], launchConfig: { extraArgs: ["--cwd"] } },
        ],
      },
    ],
  ]) {
    assert.equal(
      (await send("PUT", { pools })).status,
      400,
      JSON.stringify(pools),
    );
    assert.equal(readFileSync(poolsFile, "utf8"), original);
  }
});

test("PUT accepts only known members but retains clone paths after a member is removed", async (t) => {
  const pool = seedPools(t);
  const original = readFileSync(poolsFile, "utf8");
  const unknown = configuredPool(["never-linked"]);
  assert.equal((await send("PUT", { pools: [unknown] })).status, 400);
  assert.equal(readFileSync(poolsFile, "utf8"), original);

  const { host } = await (
    await send("POST", { label: "Former member" })
  ).json();
  const withWorker = configuredPool([host.id]);
  assert.equal((await send("PUT", { pools: [withWorker] })).status, 200);
  assert.equal(
    (
      await route.DELETE(
        new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }),
      )
    ).status,
    200,
  );
  const beforeRejected = readFileSync(poolsFile, "utf8");
  assert.equal(
    (await send("PUT", { pools: [withWorker] })).status,
    400,
    "a revoked host is not a known member",
  );
  assert.equal(readFileSync(poolsFile, "utf8"), beforeRejected);
  const removed = { ...withWorker, members: [] };
  assert.equal((await send("PUT", { pools: [removed] })).status, 200);
  assert.deepEqual((await get()).pools[0].projects[0].clonePaths, {
    [host.id]: "/srv/projects/app",
  });
  assert.equal(
    (await send("PUT", { pools: [pool] })).status,
    200,
    "the reserved local daemon remains an explicit valid member",
  );
});

test("removing a pool member does not revoke the host", async (t) => {
  const { host } = await (await send("POST", { label: "worker" })).json();
  const pool = seedPools(t, [host.id]);
  const response = await send("PUT", { pools: [{ ...pool, members: [] }] });
  assert.equal(response.status, 200);
  assert.ok((await get()).hosts.some((row) => row.id === host.id));
});

test("GET and PUT fail closed for damaged existing pool registries without overwriting them", async (t) => {
  const pool = seedPools(t);
  for (const broken of [
    "{not json",
    JSON.stringify({ pools: [] }),
    JSON.stringify({ version: 2, pools: [] }),
    JSON.stringify({ version: 1, pools: [{ ...pool, members: "broken" }] }),
  ]) {
    writeFileSync(poolsFile, broken);
    assert.equal((await route.GET()).status, 503);
    assert.equal((await send("PUT", { pools: [] })).status, 503);
    assert.equal(readFileSync(poolsFile, "utf8"), broken);
  }
});

test("unreadable existing pool state returns 503 rather than an empty pool or replacement", async (t) => {
  t.after(() => rmSync(poolsFile, { recursive: true, force: true }));
  mkdirSync(poolsFile);
  const sentinel = join(poolsFile, "keep");
  writeFileSync(sentinel, "untouched");
  assert.equal((await route.GET()).status, 503);
  assert.equal((await send("PUT", { pools: [] })).status, 503);
  assert.equal(readFileSync(sentinel, "utf8"), "untouched");
});

test(
  "a real persistence permission failure is 503, not invalid submission 400",
  {
    skip: process.getuid?.() === 0,
  },
  async (t) => {
    const pool = seedPools(t);
    const original = readFileSync(poolsFile, "utf8");
    const directory = join(agentDir, "keylime");
    chmodSync(directory, 0o500);
    try {
      assert.equal(
        (await route.GET()).status,
        200,
        "the existing registry remains readable",
      );
      assert.equal(
        (await send("PUT", { pools: [{ ...pool, label: "Changed" }] })).status,
        503,
      );
      assert.equal(readFileSync(poolsFile, "utf8"), original);
    } finally {
      chmodSync(directory, 0o700);
    }
  },
);

test("PUT cannot configure pools against an unreadable host registry", async (t) => {
  const pool = seedPools(t);
  const originalPools = readFileSync(poolsFile, "utf8");
  const originalHosts = readFileSync(hostsFile, "utf8");
  writeFileSync(hostsFile, "{broken");
  try {
    assert.equal((await send("PUT", { pools: [pool] })).status, 503);
    assert.equal(readFileSync(poolsFile, "utf8"), originalPools);
    assert.equal(readFileSync(hostsFile, "utf8"), "{broken");
  } finally {
    writeFileSync(hostsFile, originalHosts);
  }
});

test("caller telemetry cannot be stored as pool configuration", async (t) => {
  const credentials: { host: { id: string }; token: string }[] = [];
  for (const label of ["Offline", "Old protocol", "Ready"]) {
    credentials.push(await (await send("POST", { label })).json());
  }
  const [offline, old, ready] = credentials;
  const readyLink = new LinkDriver(ready.host.id, ready.token);
  t.after(() => {
    hub.closeHostLink(old.host.id);
    hub.closeHostLink(ready.host.id);
  });
  const { socket: refused } = upgradeSocket(old.token);
  assert.ok(refused);
  refused.frame(`${JSON.stringify({ type: "hello", v: 10 })}\n`);
  assert.equal(
    refused.closed?.code,
    4426,
    "a daemon below the minimum link protocol is refused",
  );
  await readyLink.dial();
  const pool = seedPools(
    t,
    credentials.map(({ host }) => host.id),
  );
  const original = readFileSync(poolsFile, "utf8");
  const sample = {
    effectiveCpus: 4,
    load1: 0.5,
    busyFraction: 0.1,
    stealFraction: 0.05,
    availableMemoryBytes: 8 * 1024 ** 3,
    activeSessions: 1,
  };
  const telemetry: Record<string, unknown> = {
    status: "online",
    linkProtocol: LINK_PROTOCOL_VERSION,
    capacity: { sample, receivedAt: performance.now() },
  };
  for (const key of Object.keys(telemetry)) {
    for (const forged of [
      { ...pool, [key]: telemetry[key] },
      {
        ...pool,
        members: pool.members.map((member) => ({
          ...member,
          [key]: telemetry[key],
        })),
      },
    ]) {
      assert.equal(
        (await send("PUT", { pools: [forged] })).status,
        400,
        `caller ${key} is not configuration`,
      );
      assert.equal(readFileSync(poolsFile, "utf8"), original);
    }
  }
  assert.equal((await send("PUT", { pools: [pool] })).status, 200);
  assert.equal(hub.getHostCapacity(old.host.id), null);
  assert.equal(hub.getHost(offline.host.id)?.status(), "offline");
  await readyLink.post({ type: "capacity", sample });
  assert.deepEqual(hub.getHostCapacity(ready.host.id)?.sample, sample);
});

test("PATCH { poolId, label } renames only that pool and keeps the rest of its configuration", async (t) => {
  const pool = seedPools(t, ["local"]);
  const response = await send("PATCH", {
    poolId: pool.id,
    label: "  Proxmox  ",
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await get()).pools, [{ ...pool, label: "Proxmox" }]);
  assert.equal(
    (await send("PATCH", { poolId: pool.id, label: "   " })).status,
    400,
  );
  assert.equal(
    (await send("PATCH", { poolId: "missing", label: "x" })).status,
    404,
  );
  assert.equal(
    (await send("PATCH", { poolId: pool.id, label: "x", enabled: false }))
      .status,
    400,
  );
  assert.equal((await get()).pools[0].label, "Proxmox");
});
