import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { loadPools, savePools } from "./pools.ts";
import type { HostPool, PoolMember } from "./pools.ts";

const scratch = mkdtempSync(join(tmpdir(), "omp-web-pools-test-"));
const environmentKeys = [
  "HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];
const previousEnvironment = new Map(
  environmentKeys.map((key) => [key, process.env[key]]),
);
// Isolate every path override before the first call that discovers agent state.
for (const key of environmentKeys) delete process.env[key];
process.env.HOME = join(scratch, "home");
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
process.env.XDG_CONFIG_HOME = join(scratch, "config");
process.env.XDG_DATA_HOME = join(scratch, "data");

const configDirectory = join(process.env.PI_CODING_AGENT_DIR, "omp-web");
const configFile = join(configDirectory, "pools.json");
after(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => rmSync(configDirectory, { recursive: true, force: true }));

const member = (
  hostId: string,
  overrides: Partial<PoolMember> = {},
): PoolMember => ({
  hostId,
  projectsRoot: `/srv/${hostId}/projects`,
  provisioned: true,
  draining: false,
  ...overrides,
});
const pool = (
  members: PoolMember[] = [member("host-a"), member("host-b")],
  overrides: Partial<HostPool> = {},
): HostPool => ({
  id: "workers",
  label: "Workers",
  enabled: true,
  members,
  projects: [],
  ...overrides,
});

const configuredPool = () =>
  pool([member("host-a")], {
    projects: [
      {
        id: "project-a",
        name: "Same display name",
        origin: "https://github.com/example/one.git",
        defaultRef: "main",
        clonePaths: { "host-a": "/srv/host-a/projects/existing-checkout" },
        addedAt: "2026-11-10T00:00:00.000Z",
        hidden: false,
        alias: "Alias",
        sortOrder: 2,
        pinOrder: 1,
        launchConfig: {
          profile: "work",
          advisor: true,
          extraArgs: ["--model", "test-model"],
        },
      },
      {
        id: "project-b",
        name: "Same display name",
        origin: "git@github.com:example/two.git",
        clonePaths: { "host-a": "/srv/host-a/projects/project-b" },
        addedAt: "2026-11-09T00:00:00.000Z",
        hidden: true,
      },
    ],
  });
const writeConfig = (value: unknown) => {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(
    configFile,
    typeof value === "string" ? value : JSON.stringify(value),
  );
};

test("missing configuration is empty and does not create a default pool", () => {
  assert.deepEqual(loadPools(), []);
  assert.equal(existsSync(configFile), false);
});

test("worker project roots reject unsafe paths", () => {
  const configured = [configuredPool()];
  savePools(configured);
  assert.deepEqual(loadPools(), configured);
  for (const root of ["/srv/../etc", "/"]) {
    const bad = configuredPool();
    bad.members[0].projectsRoot = root;
    assert.throws(
      () => savePools([bad]),
      /Invalid pool member configuration/,
      root,
    );
  }
});

test("pools round-trip explicit membership, distinct project IDs, metadata and literal registered clone paths", () => {
  const configured = [configuredPool()];
  savePools(configured);
  assert.deepEqual(loadPools(), configured);
  const persisted = JSON.parse(readFileSync(configFile, "utf8"));
  assert.deepEqual(persisted.pools, configured);
  assert.deepEqual(readdirSync(configDirectory), ["pools.json"]);
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
});

test("saving a replacement removes members without auto-joining known snapshots", () => {
  savePools([pool()]);
  savePools([pool([member("host-b")])]);
  const loaded = loadPools();
  assert.deepEqual(
    loaded[0].members.map(({ hostId }) => hostId),
    ["host-b"],
  );
  savePools([]);
  assert.deepEqual(loadPools(), []);
});

for (const text of ["{not json", "null", "{}", '{"pools":[]}']) {
  test(`corrupt or unversioned configuration fails closed: ${text}`, () => {
    writeConfig(text);
    assert.throws(() => loadPools());
    assert.equal(readFileSync(configFile, "utf8"), text);
  });
}

test("an unsupported stored version fails closed rather than silently losing pools", () => {
  savePools([configuredPool()]);
  const persisted = JSON.parse(readFileSync(configFile, "utf8"));
  persisted.version = "unsupported-future-version";
  writeConfig(persisted);
  assert.throws(() => loadPools());
});

test("an unreadable actual config path fails closed instead of becoming a local pool", () => {
  mkdirSync(configFile, { recursive: true });
  assert.throws(() => loadPools());
  assert.equal(statSync(configFile).isDirectory(), true);
});

const invalidConfigurations: Array<[string, (pool: HostPool) => void]> = [
  [
    "unsafe pool ID",
    (p) => {
      p.id = "../workers";
    },
  ],
  [
    "unsafe member ID",
    (p) => {
      p.members[0].hostId = "../host";
    },
  ],
  [
    "unsafe project ID",
    (p) => {
      p.projects[0].id = "../project";
    },
  ],
  [
    "duplicate member ID",
    (p) => {
      p.members.push({ ...p.members[0] });
    },
  ],
  [
    "duplicate project ID",
    (p) => {
      p.projects.push({ ...p.projects[0] });
    },
  ],
  [
    "relative projects root",
    (p) => {
      p.members[0].projectsRoot = "projects";
    },
  ],
  [
    "relative clone path",
    (p) => {
      p.projects[0].clonePaths["host-a"] = "project-a";
    },
  ],
  [
    "invalid origin",
    (p) => {
      p.projects[0].origin = "/tmp/not-a-registered-origin";
    },
  ],
  [
    "HTTPS credential origin",
    (p) => {
      p.projects[0].origin = "https://user:secret@github.com/example/one.git";
    },
  ],
  [
    "reserved launch argument",
    (p) => {
      p.projects[0].launchConfig = { extraArgs: ["--cwd=/tmp"] };
    },
  ],
];
for (const [name, invalidate] of invalidConfigurations) {
  test(`save rejects ${name} without overwriting valid configuration`, () => {
    savePools([configuredPool()]);
    const original = readFileSync(configFile, "utf8");
    const invalid = configuredPool();
    invalidate(invalid);
    assert.throws(() => savePools([invalid]));
    assert.equal(readFileSync(configFile, "utf8"), original);
  });
  test(`load rejects stored ${name} rather than using a partial or fallback pool`, () => {
    savePools([configuredPool()]);
    const persisted = JSON.parse(readFileSync(configFile, "utf8"));
    invalidate(persisted.pools[0]);
    writeConfig(persisted);
    assert.throws(() => loadPools());
  });
}

test("removing membership preserves registered clone paths without rejoining the former member", () => {
  const configured = configuredPool();
  configured.members = [];
  savePools([configured]);
  const [loaded] = loadPools();
  assert.deepEqual(loaded.projects[0].clonePaths, {
    "host-a": "/srv/host-a/projects/existing-checkout",
  });
});
