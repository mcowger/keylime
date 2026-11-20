import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { mock } from "bun:test";
import { captureExpectedConsole } from "../../tests/expected-console.ts";
import type { ManifestFile, PluginEntry } from "./cluster-config.ts";

const scratch = realpathSync(
  mkdtempSync(join(tmpdir(), "keylime-cluster-config-route-test-")),
);
const agentDir = join(scratch, "agent");
const homeDir = join(scratch, "home");
mkdirSync(agentDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
const saved = Object.fromEntries(
  ["PI_CODING_AGENT_DIR", "HOME", "KEYLIME_OMP_BIN"].map((name) => [
    name,
    process.env[name],
  ]),
);
// A fake omp prints plugins.json, so the plugin list is the test's to choose.
const pluginsFile = join(scratch, "plugins.json");
const fakeOmp = join(scratch, "omp");
writeFileSync(pluginsFile, '{"npm":[],"marketplace":[]}');
// Counts its runs (one byte each) in `counts`, and fails the way omp does, on stderr, when plugins.json says FAIL.
const countFile = join(scratch, "counts");
const source = `const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(countFile)}, "x");\nconst out = fs.readFileSync(${JSON.stringify(pluginsFile)}, "utf8");\nif (out === "FAIL") { console.error("secret omp output"); process.exit(1); }\nprocess.stdout.write(out);`;
writeFileSync(fakeOmp, `#!${process.execPath}\n${source}`, { mode: 0o755 });
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: agentDir,
  HOME: homeDir,
  KEYLIME_OMP_BIN: fakeOmp,
});
after(() => {
  Date.now = realNow;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

// Every readFileSync outside keylime's own state files is a configuration read. Copies of the real modules: Bun patches
// the live namespaces in place, so a wrapper calling them would otherwise call itself. Bun's homedir() reads HOME only
// at startup, so it is mocked too; "fs" and "node:fs" are separate mock keys.
const realFs = { ...(await import("node:fs")) };
const realFsp = { ...(await import("node:fs/promises")) };
const realOs = { ...(await import("node:os")) };
const configReads: string[] = [];
// `unreadable`: a directory both walks (the fingerprint's and buildManifest's) fail to read. `held`: a directory the
// fingerprint walk waits at until released.
let unreadable: string | null = null;
let held: {
  dir: string;
  reached: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
} | null = null;
const mockedFs = () => ({
  ...realFs,
  readFileSync: ((...args: Parameters<typeof realFs.readFileSync>) => {
    const path = args[0];
    if (
      typeof path === "string" &&
      path.startsWith(scratch) &&
      !path.startsWith(join(agentDir, "keylime"))
    )
      configReads.push(path);
    return Reflect.apply(realFs.readFileSync, undefined, args);
  }) as typeof realFs.readFileSync,
  readdirSync: ((...args: Parameters<typeof realFs.readdirSync>) => {
    if (args[0] === unreadable)
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return Reflect.apply(realFs.readdirSync, undefined, args);
  }) as typeof realFs.readdirSync,
});
const mockedFsp = () => ({
  ...realFsp,
  readdir: (async (...args: Parameters<typeof realFsp.readdir>) => {
    if (args[0] === unreadable)
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    if (held && args[0] === held.dir) {
      const { reached, release } = held;
      held = null;
      reached.resolve();
      await release.promise;
    }
    return Reflect.apply(realFsp.readdir, undefined, args);
  }) as typeof realFsp.readdir,
});
const mockedOs = () => ({ ...realOs, homedir: () => homeDir });
for (const name of ["fs", "node:fs"]) mock.module(name, mockedFs);
for (const name of ["fs/promises", "node:fs/promises"])
  mock.module(name, mockedFsp);
for (const name of ["os", "node:os"]) mock.module(name, mockedOs);
const manifestRoute =
  await import("../../app/api/hosts/cluster-config/manifest/route.ts");
const fileRoute =
  await import("../../app/api/hosts/cluster-config/file/[hash]/route.ts");
const { createHost, revokeHost, rotateLocalHostToken } =
  await import("./registry.ts");
const { savePools } = await import("./pools.ts");

const hostsFile = join(agentDir, "keylime", "hosts.json");
const poolsFile = join(agentDir, "keylime", "pools.json");

const authorized = (token: string | undefined): RequestInit => ({
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const getManifest = (token: string | undefined, _hash?: string) =>
  manifestRoute.GET(
    new Request(
      "http://main.test/api/hosts/cluster-config/manifest",
      authorized(token),
    ),
  );
const getFile = (token: string | undefined, hash: string) =>
  fileRoute.GET(
    new Request(
      `http://main.test/api/hosts/cluster-config/file/${hash}`,
      authorized(token),
    ),
    { params: Promise.resolve({ hash }) },
  );

/** Moves the clock past the plugin list's 120 s lifetime. */
let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;
const expirePluginList = () => {
  skew += 121_000;
};

function clusterMember() {
  const { host, token } = createHost("member");
  savePools([
    {
      id: "cluster",
      label: "cluster",
      enabled: true,
      projects: [],
      members: [
        {
          hostId: host.id,
          projectsRoot: "/srv/p",
          provisioned: true,
          draining: false,
        },
      ],
    },
  ]);
  return token;
}

beforeEach(() => {
  rmSync(poolsFile, { force: true });
  for (const entry of ["AGENTS.md", "config.yml", "skills"])
    rmSync(join(agentDir, entry), { recursive: true, force: true });
  rmSync(join(homeDir, ".agents"), { recursive: true, force: true });
  rmSync(join(scratch, "linked"), { recursive: true, force: true });
  writeFileSync(join(agentDir, "AGENTS.md"), "master rules\n");
  writeFileSync(join(agentDir, "config.yml"), "theme: dark\n");
  mkdirSync(join(agentDir, "skills", "s"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "s", "SKILL.md"), "skill\n");
  mkdirSync(join(homeDir, ".agents", "skills", "h"), { recursive: true });
  writeFileSync(
    join(homeDir, ".agents", "skills", "h", "SKILL.md"),
    "home skill\n",
  );
});

// These two run first: the plugin list is module state, and "none ever read" only holds before the first success.
test("with no plugin list ever read, a failing omp is 409 unreadable and concurrent requests run it once", async (t) => {
  captureExpectedConsole(
    t,
    "log",
    (message) =>
      typeof message === "string" &&
      (message === "[keylime] cluster-config the plugin list cannot be read" ||
        /^\[keylime\] cluster-config [\w-]+ unreadable the plugin list cannot be read \(omp plugin list failed\)$/.test(
          message,
        )),
  );
  const token = clusterMember();
  writeFileSync(pluginsFile, "FAIL");
  writeFileSync(countFile, "");
  const responses = await Promise.all([getManifest(token), getManifest(token)]);
  for (const response of responses) {
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "unreadable");
    assert.doesNotMatch(body.error, /secret omp output/);
  }
  assert.equal(realFs.readFileSync(countFile, "utf8").length, 1);
});

test("a failure after a success keeps serving the last good plugin list", async (t) => {
  captureExpectedConsole(
    t,
    "log",
    (message) =>
      message ===
      "[keylime] cluster-config the plugin list cannot be read; serving the last one read",
  );
  const token = clusterMember();
  writeFileSync(countFile, "");
  writeFileSync(
    pluginsFile,
    '{"npm":[{"name":"omp-keep","version":"1.0.0","enabled":true}],"marketplace":[]}',
  );
  assert.deepEqual(
    (await (await getManifest(token)).json()).plugins.map(
      (plugin: PluginEntry) => plugin.id,
    ),
    ["omp-keep"],
  );
  writeFileSync(pluginsFile, "FAIL");
  expirePluginList();
  const response = await getManifest(token);
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).plugins.map((plugin: PluginEntry) => plugin.id),
    ["omp-keep"],
  );
  assert.equal(realFs.readFileSync(countFile, "utf8").length, 2);
  await getManifest(token); // the failed read is not retried at once
  assert.equal(realFs.readFileSync(countFile, "utf8").length, 2);
});

test("no token and an unknown token are 401", async () => {
  for (const token of [undefined, "not-a-host-token"]) {
    for (const response of [
      await getManifest(token),
      await getFile(token, "a".repeat(64)),
    ])
      assert.equal(response.status, 401);
  }
});

test("a linked host outside any pool gets the server configuration", async () => {
  const { token } = createHost("unpooled");
  const manifest = await getManifest(token);
  assert.equal(manifest.status, 200);
  const { files } = await manifest.json();
  assert.equal((await getFile(token, files[0].hash)).status, 200);
});

test("the local record's token is 403 even when pools.json lists it", async () => {
  const localToken = rotateLocalHostToken();
  savePools([
    {
      id: "cluster",
      label: "cluster",
      enabled: true,
      projects: [],
      members: [
        {
          hostId: "local",
          projectsRoot: "/srv/p",
          provisioned: true,
          draining: false,
        },
      ],
    },
  ]);
  assert.equal((await getManifest(localToken)).status, 403);
});

test("an unreadable registry blocks configuration, but unreadable pools do not", async () => {
  const token = clusterMember();
  writeFileSync(poolsFile, "{not json");
  const manifest = await getManifest(token);
  assert.equal(manifest.status, 200);
  const { files } = await manifest.json();
  assert.equal((await getFile(token, files[0].hash)).status, 200);
  const hosts = realFs.readFileSync(hostsFile, "utf8");
  writeFileSync(hostsFile, "{not json");
  try {
    assert.equal((await getManifest(token)).status, 503);
  } finally {
    writeFileSync(hostsFile, hosts);
  }
});

test("a member gets the manifest and each listed file by hash", async () => {
  writeFileSync(
    pluginsFile,
    '{"npm":[{"name":"omp-foo","version":"1.0.0","enabled":true}],"marketplace":[]}',
  );
  expirePluginList();
  const token = clusterMember();
  const response = await getManifest(token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const manifest = await response.json();
  assert.deepEqual(
    manifest.files.map((file: ManifestFile) => `${file.root}:${file.path}`),
    [
      "agent:AGENTS.md",
      "agent:config.yml",
      "agent:skills/s/SKILL.md",
      "home:.agents/skills/h/SKILL.md",
    ],
  );
  assert.deepEqual(manifest.plugins, [
    { kind: "npm", id: "omp-foo", version: "1.0.0", enabled: true },
  ]);
  const expected: Record<string, string> = {
    "AGENTS.md": "master rules\n",
    "skills/s/SKILL.md": "skill\n",
    ".agents/skills/h/SKILL.md": "home skill\n",
  };
  for (const file of manifest.files) {
    if (!(file.path in expected)) continue;
    const served = await getFile(token, file.hash);
    assert.equal(served.status, 200);
    assert.equal(
      served.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.equal(await served.text(), expected[file.path]);
  }
});

test("a hash that is not in the manifest, or not a hash, is 404", async () => {
  const token = clusterMember();
  for (const hash of [
    "a".repeat(64),
    "../x",
    "a".repeat(63),
    "A".repeat(64),
    "a".repeat(65),
  ])
    assert.equal((await getFile(token, hash)).status, 404, hash);
});

test("a master file over the limit is 409 file_too_large on the manifest", async (t) => {
  captureExpectedConsole(
    t,
    "log",
    (message) =>
      typeof message === "string" &&
      /^\[keylime\] cluster-config [\w-]+ file_too_large AGENTS\.md is 5242881 bytes, over the 5242880 byte limit$/.test(
        message,
      ),
  );
  const token = clusterMember();
  writeFileSync(join(agentDir, "AGENTS.md"), Buffer.alloc(5_242_881));
  const response = await getManifest(token);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "file_too_large");
  assert.equal(typeof body.error, "string");
});

test("a changed file gives a new version, and its old hash is 404", async () => {
  const token = clusterMember();
  const first = await (await getManifest(token)).json();
  const old = first.files.find(
    (file: ManifestFile) => file.path === "AGENTS.md",
  );
  assert.equal((await getFile(token, old.hash)).status, 200);
  writeFileSync(join(agentDir, "AGENTS.md"), "master rules, edited\n");
  const second = await (await getManifest(token)).json();
  assert.notEqual(second.version, first.version);
  assert.equal((await getFile(token, old.hash)).status, 404);
  const fresh = second.files.find(
    (file: ManifestFile) => file.path === "AGENTS.md",
  );
  assert.equal(
    await (await getFile(token, fresh.hash)).text(),
    "master rules, edited\n",
  );
});

test("a file edited inside a linked directory gives a new version", async () => {
  const token = clusterMember();
  mkdirSync(join(scratch, "linked"), { recursive: true });
  writeFileSync(join(scratch, "linked", "SKILL.md"), "one\n");
  symlinkSync(join(scratch, "linked"), join(agentDir, "skills", "l"));
  const first = await (await getManifest(token)).json();
  assert.ok(
    first.files.some((file: ManifestFile) => file.path === "skills/l/SKILL.md"),
  );
  writeFileSync(join(scratch, "linked", "SKILL.md"), "two, longer\n");
  assert.notEqual(
    (await (await getManifest(token)).json()).version,
    first.version,
  );
});

test("an unchanged tree is not read again", async () => {
  const token = clusterMember();
  writeFileSync(join(agentDir, "AGENTS.md"), "something new\n"); // a change, so the first call below must build
  configReads.length = 0;
  const first = await (await getManifest(token)).json();
  assert.ok(configReads.length > 0, "the first call reads the files");
  configReads.length = 0;
  const second = await (await getManifest(token)).json();
  assert.equal(second.version, first.version);
  assert.deepEqual(configReads, []);
});

test("a file replaced by rename, with the same size and modification time, gives a new version", async () => {
  const token = clusterMember();
  const original = join(agentDir, "AGENTS.md");
  const fixed = 1_700_000_000;
  writeFileSync(original, "aaaa\n");
  utimesSync(original, fixed, fixed);
  const first = await (await getManifest(token)).json();
  const replacement = join(agentDir, "AGENTS.md.new");
  writeFileSync(replacement, "bbbb\n");
  utimesSync(replacement, fixed, fixed);
  renameSync(replacement, original);
  assert.notEqual(
    (await (await getManifest(token)).json()).version,
    first.version,
  );
});

test("a revoked host gets 401 on its next file request", async () => {
  const { host, token } = createHost("revoked");
  savePools([
    {
      id: "cluster",
      label: "cluster",
      enabled: true,
      projects: [],
      members: [
        {
          hostId: host.id,
          projectsRoot: "/srv/p",
          provisioned: true,
          draining: false,
        },
      ],
    },
  ]);
  const { files } = await (await getManifest(token)).json();
  assert.equal((await getFile(token, files[0].hash)).status, 200);
  assert.equal(revokeHost(host.id), true);
  assert.equal((await getFile(token, files[0].hash)).status, 401);
  assert.equal((await getManifest(token)).status, 401);
});

test("removing a host from a pool does not revoke configuration access", async () => {
  const token = clusterMember();
  const { files } = await (await getManifest(token)).json();
  assert.equal((await getFile(token, files[0].hash)).status, 200);
  rmSync(poolsFile);
  assert.equal((await getFile(token, files[0].hash)).status, 200);
  assert.equal((await getManifest(token)).status, 200);
});

test("a host revoked while configuration is built gets neither the manifest nor a file", async () => {
  for (const get of [getManifest, getFile]) {
    const { host, token } = createHost("revoked-during-build");
    const { files } = await (await getManifest(token)).json();
    held = {
      dir: join(agentDir, "skills"),
      reached: Promise.withResolvers(),
      release: Promise.withResolvers(),
    };
    const { reached, release } = held;
    const answer = get(token, files[0].hash);
    await reached.promise;
    assert.equal(revokeHost(host.id), true);
    release.resolve();
    assert.equal((await answer).status, 401);
  }
});

test("a mirrored directory that cannot be read is 409 unreadable, also when the last build had none", async (t) => {
  captureExpectedConsole(
    t,
    "log",
    (message) =>
      typeof message === "string" &&
      /^\[keylime\] cluster-config [\w-]+ unreadable skills cannot be read \(EACCES\)$/.test(
        message,
      ),
  );
  const token = clusterMember();
  rmSync(join(agentDir, "skills"), { recursive: true, force: true });
  assert.equal((await getManifest(token)).status, 200);
  mkdirSync(join(agentDir, "skills"));
  unreadable = join(agentDir, "skills");
  try {
    const response = await getManifest(token);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "unreadable");
  } finally {
    unreadable = null;
  }
});
