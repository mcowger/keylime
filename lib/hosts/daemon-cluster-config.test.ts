import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";
import { mock } from "bun:test";
import { parse } from "yaml";
import { getBlobsDir } from "../omp/paths";
import { sessionOps } from "./session-ops";
import type { PluginEntry } from "./cluster-config";
import type { ConfigState } from "./daemon-cluster-config";

type Build = ReturnType<typeof buildManifest>;
type Config = ReturnType<typeof createClusterConfig>;
type Fetch = Parameters<typeof createClusterConfig>[0]["fetch"];
type Server = {
  current: Build;
  calls: string[];
  gate: Promise<void> | null;
  onFile: ((hash: string) => Response | null) | null;
  fetch: Fetch;
};
type FakeOmp = {
  installed: Map<string, PluginEntry>;
  commands: string[];
  gate: Promise<void> | null;
  fail: Set<string>;
  run: (args: string[], signal?: AbortSignal) => Promise<string>;
};

// Bun patches the live namespace in place, so call a copy of the real rename.
const realFs = { ...(await import("node:fs")) };
let renameHook: ((from: string, to: string) => void) | null = null;
mock.module("node:fs", () => ({
  ...realFs,
  renameSync(from: PathLike, to: PathLike) {
    renameHook?.(String(from), String(to));
    return realFs.renameSync(from, to);
  },
}));

const { buildManifest } = await import("./cluster-config.ts");
const { clusterConfigTimings, createClusterConfig } =
  await import("./daemon-cluster-config.ts");
const { loadWebServerSettings, saveWebServerSettings } =
  await import("../web-settings.ts");

const MASTER = "https://master.test";
const MANIFEST = "/api/hosts/cluster-config/manifest";
const FILE = "/api/hosts/cluster-config/file/";
const EMPTY = {
  version: null,
  files: "none",
  plugins: "none",
  error: null,
  missingCommands: [],
};
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

let base: string;
let roots: Record<"agent" | "home", string>;
let master: Record<"agent" | "home", string>;
let stateDir: string;
beforeEach(() => {
  base = realpathSync(
    mkdtempSync(join(tmpdir(), "keylime-member-config-test-")),
  );
  roots = {
    agent: join(base, "member", "agent"),
    home: join(base, "member", "home"),
  };
  master = {
    agent: join(base, "master", "agent"),
    home: join(base, "master", "home"),
  };
  for (const dir of [...Object.values(roots), ...Object.values(master)])
    mkdirSync(dir, { recursive: true });
  stateDir = join(roots.agent, "keylime");
  // web-settings resolves keylime-settings.json in the agent directory.
  process.env.PI_CODING_AGENT_DIR = roots.agent;
  renameHook = null;
});
afterEach(() => {
  renameHook = null;
  rmSync(base, { recursive: true, force: true });
});

function mirrorDir() {
  const servers = join(stateDir, "cluster-config", "servers");
  if (!existsSync(servers)) return join(servers, "not-created");
  const scopes = readdirSync(servers);
  assert.ok(scopes.length <= 1);
  return join(servers, scopes[0] ?? "not-created");
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const mode = (path: string) => lstatSync(path).mode & 0o777;
const read = (path: string) => readFileSync(path, "utf8");

function put(root: string, path: string, content = "x", fileMode = 0o644) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, fileMode);
  return file;
}

/** Every entry under both member roots (keylime's own state excluded): type, mode, bytes or link target. */
function tree() {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === roots.agent && name === "keylime") continue;
      const path = join(dir, name);
      const key = `${rel}/${name}`;
      const stat = lstatSync(path);
      const bits = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        out[key] = `dir ${bits}`;
        walk(path, key);
      } else out[key] = `file ${bits} ${readFileSync(path).toString("base64")}`;
    }
  };
  walk(roots.agent, "agent");
  walk(roots.home, "home");
  return out;
}

function memberSetup() {
  put(
    roots.agent,
    "config.yml",
    "shellPath: /member/bash\nmodelRoles:\n  default: member-model\n",
    0o640,
  );
  put(roots.agent, "models.yml", "providers:\n  member: {}\n", 0o600);
  put(roots.agent, "mcp.json", '{"mcpServers":{}}\n');
  put(roots.agent, "AGENTS.md", "member rules\n", 0o640);
  put(roots.agent, "skills/mine/SKILL.md", "member skill\n");
  chmodSync(join(roots.agent, "skills"), 0o755);
  put(roots.agent, "sessions/s.jsonl", "{}\n");
  mkdirSync(getBlobsDir(), { recursive: true });
  put(roots.home, ".agents/skills/home-skill/SKILL.md", "home skill\n");
  saveWebServerSettings({ agentEnv: { MEMBER_ONLY: "1" } });
}

function masterBuild({
  rules = "master rules\n",
  agentEnv = { CLUSTER_KEY: "c" },
  plugins = [],
}: {
  rules?: string;
  agentEnv?: Record<string, string>;
  plugins?: PluginEntry[];
} = {}) {
  put(
    master.agent,
    "config.yml",
    "shellPath: /master/zsh\nmodelRoles:\n  default: master-model\n",
  );
  put(master.agent, "models.yml", "providers: {}\n");
  put(
    master.agent,
    "mcp.json",
    JSON.stringify({
      mcpServers: {
        tool: { command: "present-cmd" },
        other: { command: "absent-cmd" },
        web: { url: "https://x.test" },
      },
    }),
  );
  put(master.agent, "AGENTS.md", rules);
  put(master.agent, "skills/shared/SKILL.md", "shared skill\n");
  put(
    master.agent,
    "skills/shared/scripts/deep/run.sh",
    "#!/bin/sh\necho hi\n",
    0o755,
  );
  put(master.home, ".agents/skills/remote/SKILL.md", "remote skill\n");
  return buildManifest(master, { agentEnv, plugins });
}

/** A master's two routes at `url`; `current` is the bundle served, `gate` holds the manifest answer back. */
function serve(build: Build, url = MASTER) {
  const srv: Server = {
    current: build,
    calls: [],
    gate: null,
    onFile: null,
    fetch: async (serverUrl, path) => {
      assert.equal(serverUrl, url);
      srv.calls.push(path);
      if (path === MANIFEST) {
        if (srv.gate) await srv.gate;
        return Response.json(srv.current.manifest);
      }
      assert.ok(path.startsWith(FILE), path);
      const hash = path.slice(FILE.length);
      const special = srv.onFile?.(hash);
      if (special) return special;
      const bytes = srv.current.content(hash);
      return bytes
        ? new Response(bytes as BodyInit)
        : Response.json({ error: "Not found" }, { status: 404 });
    },
  };
  return srv;
}

/** A stateful `omp plugin`: list prints the installed set; every other action is logged in `commands`. Every call waits for `gate`.
 * `sources`: what installing a source spec puts in place, as `spec → { id, version }`. A plugin's `source` goes to a plugins
 * package.json that list points at, as omp's does. */
function fakeOmp(
  plugins: PluginEntry[] = [],
  {
    fail = new Set<string>(),
    marketplace = new Set<string>(),
    sources = new Map<string, { id: string; version: string | null }>(),
  }: {
    fail?: Set<string>;
    marketplace?: Set<string>;
    sources?: Map<string, { id: string; version: string | null }>;
  } = {},
) {
  const omp: FakeOmp = {
    installed: new Map(plugins.map((plugin) => [plugin.id, { ...plugin }])),
    commands: [],
    gate: null,
    fail,
    run: async (args) => {
      await sleep(1);
      if (omp.gate) await omp.gate;
      assert.equal(args[0], "plugin");
      const [, action, spec] = args;
      if (action === "list") {
        const all = [...omp.installed.values()];
        const npm = all.filter((p) => p.kind === "npm");
        const dir = join(base, "omp-plugins");
        const declared = npm.some((p) => p.source !== undefined);
        if (declared) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
              dependencies: Object.fromEntries(
                npm
                  .filter((p) => typeof p.source === "string")
                  .map((p) => [p.id, p.source]),
              ),
            }),
          );
        }
        return JSON.stringify({
          npm: npm.map((p) => ({
            name: p.id,
            version: p.version,
            enabled: p.enabled,
            ...(declared && { path: join(dir, "node_modules", p.id) }),
          })),
          marketplace: all
            .filter((p) => p.kind === "marketplace")
            .map((p) => ({
              id: p.id,
              entries: [
                {
                  scope: "user",
                  version: p.version ?? undefined,
                  enabled: p.enabled,
                },
              ],
            })),
        });
      }
      omp.commands.push(`${action} ${spec}`);
      if (omp.fail.has(spec))
        throw new Error(
          `Installing ${spec}\nerror: ${spec} could not be resolved`,
        );
      if (action === "install") {
        if (marketplace.has(spec))
          omp.installed.set(spec, {
            kind: "marketplace",
            id: spec,
            version: null,
            enabled: true,
          });
        else if (sources.has(spec))
          omp.installed.set(sources.get(spec)!.id, {
            kind: "npm",
            ...sources.get(spec)!,
            enabled: true,
            source: spec,
          });
        else {
          const at = spec.lastIndexOf("@");
          const id = at > 0 ? spec.slice(0, at) : spec;
          omp.installed.set(id, {
            kind: "npm",
            id,
            version: at > 0 ? spec.slice(at + 1) : "0.0.0",
            enabled: true,
          });
        }
      } else if (action === "uninstall") omp.installed.delete(spec);
      else omp.installed.get(spec)!.enabled = action === "enable";
      return "";
    },
  };
  return omp;
}

function member(
  srv: { fetch: Fetch },
  omp = fakeOmp(),
  available = new Set(["present-cmd"]),
) {
  const logs: string[] = [];
  const states: ConfigState[] = [];
  const config = createClusterConfig({
    roots: () => roots,
    blobsDir: getBlobsDir,
    stateDir: () => stateDir,
    fetch: srv.fetch,
    runOmp: (args, timeoutMs, signal, env) => {
      assert.ok(timeoutMs > 0);
      assert.notEqual(env.PI_CODING_AGENT_DIR, roots.agent);
      assert.notEqual(env.HOME, roots.home);
      return omp.run(args, signal);
    },
    commandExists: async (command) => available.has(command),
    onState: (state) => states.push(state),
    log: (message) => logs.push(message),
  });
  return { config, logs, states, omp };
}

async function pluginsSettled(config: Config) {
  for (let i = 0; i < 400 && config.state(MASTER).plugins === "pending"; i++)
    await sleep(5);
  assert.notEqual(config.state(MASTER).plugins, "pending");
}

const rejectsConfig = (promise: Promise<unknown>, pattern?: RegExp) =>
  assert.rejects(promise, (error) => {
    assert.ok(
      error &&
        typeof error === "object" &&
        "name" in error &&
        "status" in error &&
        "code" in error &&
        "message" in error,
    );
    assert.equal(error.name, "HostOpError");
    assert.equal(error.status, 409);
    assert.equal(error.code, "cluster_config_failed");
    if (pattern) {
      assert.ok(typeof error.message === "string");
      assert.match(error.message, pattern);
    }
    return true;
  });

/** A gate for `omp`, opened by the returned function. */
function hold(omp: FakeOmp) {
  const { promise, resolve } = Promise.withResolvers<void>();
  omp.gate = promise;
  return resolve;
}

async function firstApply(options?: Parameters<typeof masterBuild>[0]) {
  memberSetup();
  const build = masterBuild(options);
  const srv = serve(build);
  const m = member(srv);
  const env = await m.config.ensure(build.manifest.version, MASTER);
  return { ...m, build, srv, env };
}

test("apply writes a private server profile without changing the host profile", async () => {
  memberSetup();
  const original = tree();
  const build = masterBuild({ agentEnv: { CLUSTER_KEY: "c", HOME: "/untrusted" } });
  const { config } = member(serve(build));
  const env = await config.ensure(build.manifest.version, MASTER);
  const agent = env.PI_CODING_AGENT_DIR;
  assert.notEqual(agent, roots.agent);
  assert.notEqual(env.HOME, roots.home);
  assert.equal(env.CLUSTER_KEY, "c");
  assert.equal(env.MEMBER_ONLY, undefined);
  assert.equal(read(join(agent, "AGENTS.md")), "master rules\n");
  assert.equal(mode(join(agent, "AGENTS.md")), 0o600);
  assert.equal(mode(join(agent, "skills/shared/scripts/deep/run.sh")), 0o700);
  assert.equal(mode(join(agent, "skills/shared/scripts/deep")), 0o700);
  assert.equal(read(join(env.HOME, ".agents/skills/remote/SKILL.md")), "remote skill\n");
  assert.equal(read(join(agent, "sessions/s.jsonl")), "{}\n");
  assert.equal(existsSync(join(agent, "skills/mine")), false);
  const settings = parse(read(join(agent, "config.yml")));
  assert.equal(settings.shellPath, "/member/bash");
  assert.equal(settings.modelRoles.default, "master-model");
  assert.deepEqual(loadWebServerSettings().agentEnv, { MEMBER_ONLY: "1" });
  assert.deepEqual(tree(), original);
  assert.equal(config.state(MASTER).version, build.manifest.version);
  await pluginsSettled(config);
});
test("ensure with the applied version fetches nothing", async () => {
  const { config, build, srv } = await firstApply();
  const calls = srv.calls.length;
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(srv.calls.length, calls);
});

test("native OMP reopens a blob-backed chat after a configuration refresh", async () => {
  const { config, srv, env } = await firstApply();
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0l8AAAAASUVORK5CYII=";
  const script = `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { getBlobsDir, getSessionsDir } from "@oh-my-pi/pi-utils";
    import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
    import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

    const file = join(getSessionsDir(), "blob-chat.jsonl");
    if (process.argv.at(-1) === "save") {
      const { hash, ref } = new BlobStore(getBlobsDir()).putSync(Buffer.from(${JSON.stringify(image)}, "base64"));
      const timestamp = new Date().toISOString();
      const entries = [
        { type: "session", version: 3, id: crypto.randomUUID(), timestamp, cwd: ${JSON.stringify(roots.home)} },
        { type: "message", id: "abcd1234", parentId: null, timestamp, message: {
          role: "user", timestamp: Date.now(), content: [{ type: "image", mimeType: "image/png", data: ref }],
        } },
      ];
      writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
      console.log(hash);
    } else {
      const chat = await SessionManager.open(file, undefined, undefined, { throwIfMissing: true });
      try {
        const image = chat.getBranch().find((entry) => entry.type === "message").message.content[0];
        console.log(image.data);
      } finally {
        await chat.close();
      }
    }
  `;
  const run = (profile: Record<string, string>, command: "save" | "open") => {
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script, command], {
      cwd: join(import.meta.dir, "../../runner"),
      env: profile,
      timeout: 4_000,
    });
    assert.equal(child.exitCode, 0, child.stderr.toString());
    return child.stdout.toString().trim();
  };

  const hash = run(env, "save");
  srv.current = masterBuild({ rules: "updated server rules\n" });
  const refreshed = await config.ensure(srv.current.manifest.version, MASTER);
  assert.equal(read(join(refreshed.PI_CODING_AGENT_DIR, "AGENTS.md")), "updated server rules\n");
  assert.equal(run(refreshed, "open"), image);
  const media = await sessionOps.readMedia(hash);
  assert.ok(media.ok);
  assert.equal(Buffer.from(media.value).toString("base64"), image);
});

test("two concurrent ensure calls share one apply", async () => {
  memberSetup();
  const build = masterBuild();
  const srv = serve(build);
  const { config } = member(srv);
  await Promise.all([
    config.ensure(build.manifest.version, MASTER),
    config.ensure(build.manifest.version, MASTER),
  ]);
  assert.equal(srv.calls.filter((path) => path === MANIFEST).length, 1);
  assert.equal(config.state(MASTER).files, "current");
});

test("a manifest path outside the mirrored entries rejects the version before anything is written", async () => {
  memberSetup();
  const build = masterBuild();
  const before = tree();
  for (const bad of [
    { root: "agent", path: "../x" },
    { root: "agent", path: "sessions/a" },
  ] as const) {
    const file = build.manifest.files[0];
    const srv = serve({
      manifest: {
        ...build.manifest,
        files: [...build.manifest.files, { ...file, ...bad }],
      },
      content: build.content,
    });
    const { config } = member(srv);
    await rejectsConfig(config.ensure(build.manifest.version, MASTER));
    assert.deepEqual(srv.calls, [MANIFEST], "no file is downloaded");
    assert.deepEqual(tree(), before);
    assert.equal(
      existsSync(join(mirrorDir(), "objects")),
      false,
    );
    assert.equal(config.state(MASTER).files, "failed");
  }
});

test("a downloaded file whose hash does not match is rejected and never stored", async () => {
  memberSetup();
  const build = masterBuild();
  const agents = build.manifest.files.find((file) => file.path === "AGENTS.md");
  assert.ok(agents);
  const srv = serve(build);
  srv.onFile = (hash) =>
    hash === agents.hash ? new Response("master rulez\n") : null;
  const before = tree();
  const { config } = member(srv);
  await rejectsConfig(
    config.ensure(build.manifest.version, MASTER),
    /AGENTS\.md/,
  );
  assert.deepEqual(tree(), before);
  assert.equal(
    existsSync(join(mirrorDir(), "objects", agents.hash)),
    false,
  );
});

test("a body longer than the manifest's size is refused", async () => {
  memberSetup();
  const build = masterBuild();
  const agents = build.manifest.files.find((file) => file.path === "AGENTS.md");
  assert.ok(agents);
  const srv = serve(build);
  srv.onFile = (hash) =>
    hash === agents.hash
      ? new Response(`master rules\n${"y".repeat(100_000)}`)
      : null;
  const before = tree();
  const { config } = member(srv);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /longer/);
  assert.deepEqual(tree(), before);
  assert.equal(
    existsSync(join(mirrorDir(), "objects", agents.hash)),
    false,
  );
});

test("a 404 for a file fetches the manifest again and applies the new version", async () => {
  memberSetup();
  const v1 = masterBuild();
  const v2 = masterBuild({ rules: "master rules v2\n" });
  const srv = serve(v1);
  srv.onFile = () => {
    srv.onFile = null;
    srv.current = v2;
    return Response.json({ error: "Not found" }, { status: 404 });
  };
  const { config } = member(srv);
  const env = await config.ensure(v1.manifest.version, MASTER);
  assert.equal(srv.calls.filter((path) => path === MANIFEST).length, 2);
  assert.equal(config.state(MASTER).version, v2.manifest.version);
  assert.equal(read(join(env.PI_CODING_AGENT_DIR, "AGENTS.md")), "master rules v2\n");
});

test("a failed publication keeps the selected generation and leaves no partially selected update", async () => {
  const { config, build, srv, env } = await firstApply();
  const original = tree();
  const second = masterBuild({ rules: "version two\n", agentEnv: { SECOND: "yes" } });
  srv.current = second;
  renameHook = (_from, to) => {
    if (to.endsWith("/state.json")) throw new Error("injected publication failure");
  };
  await rejectsConfig(config.ensure(second.manifest.version, MASTER), /injected publication failure/);
  renameHook = null;
  assert.deepEqual(config.recover(MASTER), env);
  assert.equal(config.state(MASTER).version, build.manifest.version);
  assert.equal(read(join(env.PI_CODING_AGENT_DIR, "AGENTS.md")), "master rules\n");
  const next = await config.ensure(second.manifest.version, MASTER);
  assert.notEqual(next.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_DIR);
  assert.equal(next.SECOND, "yes");
  assert.equal(read(join(next.PI_CODING_AGENT_DIR, "AGENTS.md")), "version two\n");
  assert.equal(read(join(env.PI_CODING_AGENT_DIR, "AGENTS.md")), "master rules\n");
  assert.deepEqual(tree(), original);
  await pluginsSettled(config);
});

test("a failed first publication has no recoverable selection after restart", async () => {
  memberSetup();
  const original = tree();
  const build = masterBuild();
  const srv = serve(build);
  const { config } = member(srv);
  renameHook = (_from, to) => {
    if (to.endsWith("/state.json")) throw new Error("injected publication failure");
  };
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /injected publication failure/);
  renameHook = null;
  const restarted = member(srv).config;
  assert.throws(() => restarted.recover(MASTER), /No saved configuration/);
  await restarted.ensure(build.manifest.version, MASTER);
  assert.deepEqual(tree(), original);
  await pluginsSettled(restarted);
});

test("host symlinks stay untouched and are not inherited by the server profile", async () => {
  memberSetup();
  renameSync(join(roots.agent, "AGENTS.md"), join(roots.agent, "local-rules.md"));
  symlinkSync("local-rules.md", join(roots.agent, "AGENTS.md"));
  renameSync(join(roots.agent, "config.yml"), join(roots.agent, "local.yml"));
  symlinkSync("local.yml", join(roots.agent, "config.yml"));
  const original = tree();
  const build = masterBuild();
  const { config } = member(serve(build));
  const env = await config.ensure(build.manifest.version, MASTER);
  assert.equal(read(join(env.PI_CODING_AGENT_DIR, "AGENTS.md")), "master rules\n");
  assert.equal(lstatSync(join(env.PI_CODING_AGENT_DIR, "AGENTS.md")).isSymbolicLink(), false);
  assert.equal(parse(read(join(env.PI_CODING_AGENT_DIR, "config.yml"))).shellPath, "/member/bash");
  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
});

test("each new generation reconciles plugins even when the list has not changed", async () => {
  const { config, srv, states } = await firstApply();
  await pluginsSettled(config);
  srv.current = masterBuild({ rules: "master rules v2\n" });
  const v2 = srv.current.manifest.version;
  await config.ensure(v2, MASTER);
  assert.equal(config.state(MASTER).plugins, "pending");
  srv.current = masterBuild({
    rules: "master rules v3\n",
    plugins: [{ kind: "npm", id: "new", version: "2.0.0", enabled: true }],
  });
  await config.ensure(srv.current.manifest.version, MASTER); // queued after v2's plugin step
  assert.equal(config.state(MASTER).plugins, "pending");
  assert.deepEqual(
    [
      ...new Set(
        states
          .filter((state) => state.version === v2)
          .map((state) => state.plugins),
      ),
    ],
    ["pending", "current"],
  );
  await pluginsSettled(config);
  assert.equal(config.state(MASTER).plugins, "current");
});

test("plugins: install, then uninstall, then disable, after ensure resolved", async () => {
  memberSetup();
  const omp = fakeOmp(
    [
      { kind: "npm", id: "keep", version: "1.0.0", enabled: true },
      { kind: "npm", id: "old", version: "1.0.0", enabled: true },
    ],
    { marketplace: new Set(["market@mp"]) },
  );
  const build = masterBuild({
    plugins: [
      { kind: "npm", id: "keep", version: "1.0.0", enabled: false },
      { kind: "npm", id: "new", version: "2.0.0", enabled: true },
      { kind: "marketplace", id: "market@mp", version: null, enabled: true },
    ],
  });
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  assert.deepEqual(omp.commands, [], "ensure does not wait for the plugins");
  assert.equal(config.state(MASTER).plugins, "pending");
  await pluginsSettled(config);
  assert.deepEqual(omp.commands, [
    "install market@mp",
    "install new@2.0.0",
    "uninstall old",
    "disable keep",
  ]);
  assert.equal(config.state(MASTER).plugins, "current");
  assert.equal(config.state(MASTER).error, null);
});

test("a failing plugin install reports plugins failed with omp's last line, files still current", async () => {
  memberSetup();
  const omp = fakeOmp([], { fail: new Set(["new@2.0.0"]) });
  const build = masterBuild({
    plugins: [{ kind: "npm", id: "new", version: "2.0.0", enabled: true }],
  });
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  const state = config.state(MASTER);
  assert.equal(state.plugins, "failed");
  assert.equal(state.error, "error: new@2.0.0 could not be resolved");
  assert.equal(state.files, "current");
});

test("an npm plugin the master installed from git installs from that source; a linked one is reported, not installed", async () => {
  memberSetup();
  const source =
    "github:andrebrait/superpowers#0957644820429601727cf9cf78baac3e8f62ba4f";
  const tarball = "tarball@https://example.com/tarball-1.0.0.tgz";
  const omp = fakeOmp([], {
    sources: new Map([
      [source, { id: "superpowers", version: "7.0.2" }],
      [tarball, { id: "tarball", version: "1.0.0" }],
    ]),
  });
  const build = masterBuild({
    plugins: [
      {
        kind: "npm",
        id: "superpowers",
        version: "7.0.2",
        enabled: true,
        source,
      },
      {
        kind: "npm",
        id: "graphify-pi",
        version: null,
        enabled: true,
        source: null,
      },
      {
        kind: "npm",
        id: "tarball",
        version: "1.0.0",
        enabled: true,
        source: "https://example.com/tarball-1.0.0.tgz",
      },
      {
        kind: "npm",
        id: "ranged",
        version: "1.2.3",
        enabled: true,
        source: "^1.2.0",
      },
    ],
  });
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  assert.deepEqual(omp.commands, [
    "install ranged@1.2.3",
    `install ${source}`,
    "install tarball@https://example.com/tarball-1.0.0.tgz",
  ]);
  assert.equal(config.state(MASTER).plugins, "failed");
  assert.match(
    config.state(MASTER).error!,
    /graphify-pi is installed from a local directory on the master/,
  );
});

test("a plugin whose unpinned source installs another version than the master runs reports plugins failed; the next step installs it again", async () => {
  memberSetup();
  const source = "git+https://example.com/plugin.git";
  const omp = fakeOmp([], {
    sources: new Map([[source, { id: "plugin", version: "1.1.0" }]]),
  });
  const build = masterBuild({
    plugins: [
      { kind: "npm", id: "plugin", version: "1.0.0", enabled: true, source },
    ],
  });
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  assert.equal(config.state(MASTER).plugins, "failed");
  assert.equal(
    config.state(MASTER).error,
    "plugin: installed 1.1.0, the master runs 1.0.0",
  );
  const saved = clusterConfigTimings.pluginRetryMs;
  clusterConfigTimings.pluginRetryMs = 0;
  try {
    await config.ensure(build.manifest.version, MASTER);
    await pluginsSettled(config);
  } finally {
    clusterConfigTimings.pluginRetryMs = saved;
  }
  assert.deepEqual(omp.commands, [`install ${source}`, `install ${source}`]);
  assert.equal(config.state(MASTER).plugins, "failed");
});

test("a failed install from a source with credentials logs the plugin id, never the source", async () => {
  memberSetup();
  const source = "git+https://user:s3cr3t-token@example.com/plugin.git#v1.0.0";
  const omp = fakeOmp([], { fail: new Set([source]) });
  const build = masterBuild({
    plugins: [
      { kind: "npm", id: "plugin", version: "1.0.0", enabled: true, source },
    ],
  });
  const { config, logs } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  assert.equal(config.state(MASTER).plugins, "failed");
  assert.ok(
    logs.includes("cluster-config: omp plugin install plugin failed"),
    logs.join("\n"),
  );
  assert.ok(
    !logs.some((line) => line.includes("s3cr3t-token")),
    logs.join("\n"),
  );
});

test("a plugin of the master's version installed from another source is installed again from the master's; one from the same source stays", async () => {
  memberSetup();
  const source =
    "github:andrebrait/superpowers#0957644820429601727cf9cf78baac3e8f62ba4f";
  const build = masterBuild({
    plugins: [
      {
        kind: "npm",
        id: "superpowers",
        version: "7.0.2",
        enabled: true,
        source,
      },
    ],
  });
  const fromRegistry = fakeOmp(
    [
      {
        kind: "npm",
        id: "superpowers",
        version: "7.0.2",
        enabled: true,
        source: "7.0.2",
      },
    ],
    { sources: new Map([[source, { id: "superpowers", version: "7.0.2" }]]) },
  );
  const { config } = member(serve(build), fromRegistry);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  assert.deepEqual(fromRegistry.commands, [`install ${source}`]);
  assert.equal(config.state(MASTER).plugins, "current");

  memberSetup();
  const fromSource = fakeOmp([
    { kind: "npm", id: "superpowers", version: "7.0.2", enabled: true, source },
  ]);
  const again = member(serve(build), fromSource).config;
  await again.ensure(build.manifest.version, MASTER);
  await pluginsSettled(again);
  assert.deepEqual(fromSource.commands, []);
  assert.equal(again.state(MASTER).plugins, "current");
});

test("a plugin of the master's version whose source this host cannot read is installed from the master's source", async () => {
  memberSetup();
  const source =
    "github:andrebrait/superpowers#0957644820429601727cf9cf78baac3e8f62ba4f";
  const build = masterBuild({
    plugins: [
      {
        kind: "npm",
        id: "superpowers",
        version: "7.0.2",
        enabled: true,
        source,
      },
    ],
  });
  // No `source`: the fake lists no paths, so this host's plugins package.json cannot be read.
  const omp = fakeOmp(
    [{ kind: "npm", id: "superpowers", version: "7.0.2", enabled: true }],
    { sources: new Map([[source, { id: "superpowers", version: "7.0.2" }]]) },
  );
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  assert.deepEqual(omp.commands, [`install ${source}`]);
  assert.equal(config.state(MASTER).plugins, "current");
});

test("a plugin linked on the master with no version is not satisfied by a registry package of that name; a linked one here is", async () => {
  memberSetup();
  const build = masterBuild({
    plugins: [
      {
        kind: "npm",
        id: "graphify-pi",
        version: null,
        enabled: true,
        source: null,
      },
    ],
  });
  const fromRegistry = fakeOmp([
    {
      kind: "npm",
      id: "graphify-pi",
      version: "1.0.0",
      enabled: true,
      source: "1.0.0",
    },
  ]);
  const { config } = member(serve(build), fromRegistry);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  assert.deepEqual(fromRegistry.commands, []);
  assert.equal(config.state(MASTER).plugins, "failed");
  assert.match(
    config.state(MASTER).error!,
    /graphify-pi is installed from a local directory on the master/,
  );

  memberSetup();
  const linked = fakeOmp([
    {
      kind: "npm",
      id: "graphify-pi",
      version: "1.0.0",
      enabled: true,
      source: null,
    },
  ]);
  const again = member(serve(build), linked).config;
  await again.ensure(build.manifest.version, MASTER);
  await pluginsSettled(again);
  assert.deepEqual(linked.commands, []);
  assert.equal(again.state(MASTER).plugins, "current");
});

test("after a restart the applied version counts and its plugin job runs again", async () => {
  memberSetup();
  const build = masterBuild({
    plugins: [{ kind: "npm", id: "new", version: "2.0.0", enabled: true }],
  });
  const srv = serve(build);
  const before = member(srv);
  await before.config.ensure(build.manifest.version, MASTER);
  await before.config.stop();

  const omp = fakeOmp();
  const { config } = member(srv, omp);
  assert.equal(config.state(MASTER).version, build.manifest.version);
  assert.equal(config.state(MASTER).files, "current");
  await pluginsSettled(config);
  assert.deepEqual(omp.commands, ["install new@2.0.0"]);
  assert.equal(config.state(MASTER).plugins, "current");
  const calls = srv.calls.length;
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(srv.calls.length, calls);
});

test("missingCommands lists the MCP command the member lacks", async () => {
  const { config } = await firstApply();
  await pluginsSettled(config);
  assert.deepEqual(config.state(MASTER).missingCommands, ["absent-cmd"]);
});

test("config.yaml supplies machine settings without changing the local profile", async () => {
  memberSetup();
  renameSync(join(roots.agent, "config.yml"), join(roots.agent, "config.yaml"));
  const original = tree();
  const build = masterBuild();
  const { config } = member(serve(build));
  const env = await config.ensure(build.manifest.version, MASTER);
  assert.equal(parse(read(join(env.PI_CODING_AGENT_DIR, "config.yml"))).shellPath, "/member/bash");
  await config.restore(MASTER);
  assert.deepEqual(config.state(MASTER), EMPTY);
  assert.throws(() => config.recover(MASTER), /No saved configuration/);
  assert.deepEqual(tree(), original);
});

test("invalid host settings do not leak their contents or join the server profile", async () => {
  memberSetup();
  put(roots.agent, "config.yml", "[PRIVATE_HOST_SETTING\n");
  const build = masterBuild();
  const { config, logs } = member(serve(build));
  const env = await config.ensure(build.manifest.version, MASTER);
  assert.equal(parse(read(join(env.PI_CODING_AGENT_DIR, "config.yml"))).shellPath, undefined);
  assert.ok(logs.some((line) => line.includes("config.yml")));
  assert.ok(logs.every((line) => !line.includes("PRIVATE_HOST_SETTING")));
  await config.stop();
});
test("a manifest longer than 5 MiB is refused before anything is downloaded", async () => {
  memberSetup();
  const build = masterBuild();
  const srv = serve({
    manifest: { ...build.manifest, agentEnv: { BIG: "x".repeat(5_300_000) } },
    content: build.content,
  });
  const before = tree();
  const { config } = member(srv);
  await rejectsConfig(
    config.ensure(build.manifest.version, MASTER),
    /manifest is longer/,
  );
  assert.deepEqual(srv.calls, [MANIFEST]);
  assert.deepEqual(tree(), before);
});

const OTHER = "https://other.test";

test("two servers can apply and recover independent profiles; revocation affects only its server", async () => {
  memberSetup();
  const original = tree();
  const first = masterBuild({ rules: "first server\n", agentEnv: { SERVER_NAME: "first" } });
  const second = masterBuild({ rules: "second server\n", agentEnv: { SERVER_NAME: "second" } });
  const a = serve(first);
  const b = serve(second, OTHER);
  const fetch: Fetch = (url, path, signal) => (url === MASTER ? a : b).fetch(url, path, signal);
  const { config } = member({ fetch });
  const [envA, envB] = await Promise.all([
    config.apply(first.manifest.version, MASTER),
    config.apply(second.manifest.version, OTHER),
  ]);
  assert.notEqual(envA.HOME, envB.HOME);
  assert.notEqual(envA.PI_CODING_AGENT_DIR, envB.PI_CODING_AGENT_DIR);
  assert.equal(envA.SERVER_NAME, "first");
  assert.equal(envB.SERVER_NAME, "second");
  assert.equal(read(join(envA.PI_CODING_AGENT_DIR, "AGENTS.md")), "first server\n");
  assert.equal(read(join(envB.PI_CODING_AGENT_DIR, "AGENTS.md")), "second server\n");
  await config.stop();
  const restarted = member({ fetch }).config;
  assert.deepEqual(restarted.recover(MASTER), envA);
  assert.deepEqual(restarted.recover(OTHER), envB);
  await restarted.restore(MASTER);
  assert.deepEqual(restarted.state(MASTER), EMPTY);
  await rejectsConfig(restarted.ensure(first.manifest.version, MASTER), /no longer available/);
  assert.throws(() => restarted.recover(MASTER), /No saved configuration/);
  assert.deepEqual(restarted.recover(OTHER), envB);
  assert.equal(restarted.state(OTHER).version, second.manifest.version);
  assert.equal(existsSync(envA.PI_CODING_AGENT_DIR), false);
  assert.equal(read(join(envB.PI_CODING_AGENT_DIR, "AGENTS.md")), "second server\n");
  assert.deepEqual(tree(), original);
  await restarted.apply(first.manifest.version, MASTER);
  await restarted.stop();
});
test("a failed plugin step runs again when its version is asked for, at most once per retry interval, and nobody waits for it", async (t) => {
  memberSetup();
  const omp = fakeOmp([], { fail: new Set(["new@2.0.0"]) });
  const build = masterBuild({
    plugins: [{ kind: "npm", id: "new", version: "2.0.0", enabled: true }],
  });
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  assert.equal(config.state(MASTER).plugins, "failed");
  omp.commands.length = 0;
  await config.ensure(build.manifest.version, MASTER);
  await sleep(20);
  assert.deepEqual(
    omp.commands,
    [],
    "within the interval of the last try: no retry",
  );
  assert.equal(config.state(MASTER).plugins, "failed");

  const saved = clusterConfigTimings.pluginRetryMs;
  clusterConfigTimings.pluginRetryMs = 0;
  t.after(() => {
    clusterConfigTimings.pluginRetryMs = saved;
  });
  omp.fail.clear();
  const release = hold(omp);
  await config.apply(build.manifest.version, MASTER); // resolves while the plugin step waits for omp
  assert.equal(config.state(MASTER).plugins, "pending");
  assert.equal(config.state(MASTER).error, null);
  release();
  await pluginsSettled(config);
  assert.deepEqual(omp.commands, ["install new@2.0.0"]);
  assert.equal(config.state(MASTER).plugins, "current");
});

/** A master that never finishes a request: the manifest's headers (or, with `body`, every file's body) wait until the request is aborted. */
function stalled({
  body = false,
  build,
}: { body?: boolean; build?: Build } = {}) {
  const srv: { calls: string[]; fetch: Fetch } = {
    calls: [],
    fetch: (serverUrl, path, signal) => {
      srv.calls.push(path);
      if (body && path === MANIFEST) {
        assert.ok(build);
        return Promise.resolve(Response.json(build.manifest));
      }
      if (body) return Promise.resolve(new Response(hang(signal)));
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  };
  const hang = (signal: AbortSignal) =>
    new ReadableStream({
      start: (controller) =>
        signal.addEventListener(
          "abort",
          () => controller.error(signal.reason),
          { once: true },
        ),
    });
  return srv;
}

test("revoking a server aborts its download and leaves no recoverable profile", async () => {
  memberSetup();
  const before = tree();
  const build = masterBuild();
  const srv = stalled({ body: true, build });
  const { config } = member(srv);
  const applying = rejectsConfig(config.ensure(build.manifest.version, MASTER));
  for (let i = 0; i < 200 && srv.calls.length < 2; i++) await sleep(5);
  assert.equal(srv.calls.length, 2);
  await config.restore(MASTER);
  await applying;
  assert.deepEqual(config.state(MASTER), EMPTY);
  assert.throws(() => member(srv).config.recover(MASTER), /No saved configuration/);
  assert.deepEqual(tree(), before);
});

test("a master that stops answering fails the apply within the request time limit, headers or body, and changes nothing", async (t) => {
  memberSetup();
  const before = tree();
  const saved = clusterConfigTimings.fetchMs;
  clusterConfigTimings.fetchMs = 100;
  t.after(() => {
    clusterConfigTimings.fetchMs = saved;
  });
  const build = masterBuild();
  for (const [srv, what] of [
    [stalled(), "the manifest"],
    [stalled({ body: true, build }), build.manifest.files[0].path],
  ] as const) {
    const { config } = member(srv);
    const started = Date.now();
    await rejectsConfig(
      config.ensure(build.manifest.version, MASTER),
      new RegExp(
        `^the master did not send ${what.replaceAll(".", "\\.")} within 0\\.1 s$`,
      ),
    );
    assert.ok(Date.now() - started < 3000, "failed at the time limit");
    assert.equal(config.state(MASTER).files, "failed");
    assert.deepEqual(tree(), before);
    assert.equal(config.holds(MASTER), false);
  }
});

test("stop aborts a stalled request to the master at once instead of waiting for its time limit", async () => {
  memberSetup();
  const build = masterBuild();
  const srv = stalled({ body: true, build });
  const { config } = member(srv);
  const applying = config.ensure(build.manifest.version, MASTER);
  for (let i = 0; i < 200 && srv.calls.length < 2; i++) await sleep(5);
  assert.equal(srv.calls.length, 2, "the first file's body is stalled");
  const started = Date.now();
  await config.stop();
  assert.ok(
    Date.now() - started < 3000,
    "the stop did not wait for the 30 s limit",
  );
  await rejectsConfig(applying, /^the host daemon is stopping$/);
  assert.equal(config.holds(MASTER), false);
});

test("a stop during a plugin install ends the command instead of waiting for it", async () => {
  memberSetup();
  const omp = fakeOmp();
  // An install that never ends by itself: only the stop's signal ends it.
  const installing = Promise.withResolvers<AbortSignal | undefined>();
  const run = omp.run;
  omp.run = (args, signal) => {
    if (args[1] !== "install") return run(args);
    installing.resolve(signal);
    return new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  };
  const build = masterBuild({
    plugins: [{ kind: "npm", id: "slow", version: "1.0.0", enabled: true }],
  });
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  assert.ok(
    (await installing.promise) instanceof AbortSignal,
    "the install gets the stop's signal",
  );
  await config.stop();
  assert.equal(
    config.state(MASTER).plugins,
    "pending",
    "cut short: the next start runs it again",
  );
});

