import type { ConfigState as SchemaConfigState } from "../api-contracts/host-schemas";
// Host daemon only (Bun's native TypeScript runtime): relative imports, `node:*` modules and the global fetch.
// Each link gets its own mirror. Publishing a generation never changes the daemon's own OMP configuration.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { listPlugins } from "../omp/plugins-cli";
import { isRecord } from "../type-guards";
import { sanitizeAgentEnvValues } from "../omp/agent-env-policy";
import { HOST_CONFIG_MIRROR_DIR } from "../omp/paths";
import {
  CONFIG_LIMITS,
  isManagedPath,
  mergeLocalSettings,
  type ConfigManifest,
  type ConfigRoot,
  type ManifestFile,
  type PluginEntry,
} from "./cluster-config";
import { HostOpError } from "./link-protocol";

export type ConfigState = SchemaConfigState;
/** Every request to the master, its body included, must finish within `fetchMs`; a failed plugin step runs again at most
 * once per `pluginRetryMs` (the hub's sync interval). Tests shorten them. */
export const clusterConfigTimings = { fetchMs: 30_000, pluginRetryMs: 30_000 };

const API = "/api/hosts/cluster-config/";
const HASH_RE = /^[0-9a-f]{64}$/;
const LIST_MS = 60_000;
const INSTALL_MS = 300_000;
const UNINSTALL_MS = 120_000;
const TOGGLE_MS = 60_000;

/** A failure whose message is safe to report and log: paths and statuses, never content. */
class ApplyError extends Error {}
const fail = (reason: string): never => {
  throw new ApplyError(reason);
};
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const lastLine = (error: unknown) =>
  messageOf(error).trim().split("\n").at(-1) ?? "";
const exists = (path: string) =>
  lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const removeAll = (path: string) =>
  rmSync(path, { recursive: true, force: true });
/** Answers the topmost directory it created, if any. */
const makeDir = (dir: string) =>
  mkdirSync(dir, { recursive: true, mode: 0o700 });

/** Written under a fresh name beside `path`, then renamed over it: never half a file, never written through a link at `path`. */
function writeAtomic(path: string, data: string | Uint8Array, mode = 0o600) {
  makeDir(dirname(path));
  const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, data, { mode, flag: "wx" });
    chmodSync(temp, mode); // the umask may have narrowed it
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** JSON without the parser's own message, which quotes the input (the manifest and the backup hold secrets). */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${what} is not valid JSON`);
  }
}

const isPlugin = (p: unknown): p is PluginEntry =>
  isRecord(p) &&
  (p.kind === "npm" || p.kind === "marketplace") &&
  typeof p.id === "string" &&
  /^[^-\s]\S*$/.test(p.id) &&
  (p.version === null || typeof p.version === "string") &&
  typeof p.enabled === "boolean" &&
  (p.source === undefined || p.source === null || typeof p.source === "string");

/**
 * What `omp plugin install` takes for `plugin`, or null when only a directory on the master holds it (linked, `file:`).
 * A git source (`github:…`, `git+…`, a repository URL) installs as itself, a tarball URL under the plugin's name, and a
 * registry range, or a master that sent no source, as the version the master runs.
 */
function installSpec(plugin: PluginEntry): string | null {
  const { source } = plugin;
  if (plugin.kind === "marketplace") return plugin.id; // a marketplace plugin cannot be pinned to a version
  if (
    source === null ||
    (source !== undefined &&
      /^(file:|link:|portal:|[./~\\]|[A-Za-z]:)/.test(source))
  )
    return null;
  if (source !== undefined && /^https?:\/\/\S+\.(tgz|tar\.gz)$/i.test(source))
    return `${plugin.id}@${source}`;
  if (
    source !== undefined &&
    /^(?!npm:)([A-Za-z][\w+.-]*:|git@)\S+$/.test(source)
  )
    return source;
  return plugin.version === null ? plugin.id : `${plugin.id}@${plugin.version}`;
}

const isFile = (f: unknown): f is ManifestFile =>
  isRecord(f) &&
  (f.root === "agent" || f.root === "home") &&
  typeof f.path === "string" &&
  typeof f.hash === "string" &&
  HASH_RE.test(f.hash) &&
  typeof f.size === "number" &&
  Number.isSafeInteger(f.size) &&
  f.size >= 0 &&
  f.size <= CONFIG_LIMITS.fileBytes &&
  typeof f.exec === "boolean";

/** The master's manifest, checked whole before anything touches the disk. */
function checkManifest(value: unknown): ConfigManifest {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !HASH_RE.test(value.version) ||
    !Array.isArray(value.files) ||
    !value.files.every(isFile) ||
    !isRecord(value.agentEnv) ||
    !Object.values(value.agentEnv).every((v) => typeof v === "string") ||
    !Array.isArray(value.plugins) ||
    !value.plugins.every(isPlugin)
  ) {
    return fail("the master's manifest is malformed");
  }
  const manifest = value as unknown as ConfigManifest;
  let total = 0;
  for (const file of manifest.files) {
    if (!isManagedPath(file.root, file.path))
      fail(
        `the manifest names ${file.root}:${JSON.stringify(file.path)}, which is not a mirrored path`,
      );
    total += file.size;
  }
  if (total > CONFIG_LIMITS.bundleBytes)
    fail(`the manifest exceeds ${CONFIG_LIMITS.bundleBytes} bytes`);
  return manifest;
}

/** The body, refused as soon as it passes `limit` bytes. */
async function readBody(
  res: Response,
  limit: number,
  tooLong: string,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      fail(tooLong);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Whether a member's own settings file is something `mergeLocalSettings` can keep values from. */
function readsAsMap(yaml: string): boolean {
  try {
    const doc = parseDocument(yaml);
    const value: unknown = doc.errors.length === 0 ? doc.toJS() : false;
    return value === null || value === undefined || isRecord(value);
  } catch {
    return false;
  }
}

/** The member's own settings in `dir`: `.yml` before `.yaml`, as omp reads them. */
function ownSettings(dir: string): { path: string; yaml: string } | null {
  for (const name of ["config.yml", "config.yaml"]) {
    const path = join(dir, name);
    try {
      return { path, yaml: readFileSync(path, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

type ClusterConfigDeps = {
  roots(): Record<ConfigRoot, string>;
  sessionsDir?(): string;
  blobsDir(): string;
  stateDir(): string;
  fetch(serverUrl: string, path: string, signal: AbortSignal): Promise<Response>;
  runOmp(args: string[], timeoutMs: number, signal: AbortSignal, env: Record<string, string>): Promise<string>;
  commandExists(command: string): Promise<boolean>;
  onState(state: ConfigState, serverUrl: string): void;
  log(message: string): void;
};

type Applied = { version: string; generation: string; plugins: PluginEntry[]; agentEnv: Record<string, string> };

type Mirror = {
  ensure(version: string): Promise<Record<string, string>>;
  apply(version: string): Promise<Record<string, string>>;
  restore(): Promise<void>;
  recover(): Record<string, string>;
  state(): ConfigState;
  holds(): boolean;
  stop(): Promise<void>;
};

const emptyState = (): ConfigState => ({
  version: null, files: "none", plugins: "none", error: null, missingCommands: [],
});

export function createClusterConfig(deps: ClusterConfigDeps) {
  const mirrors = new Map<string, Mirror>();
  const mirror = (url: string) => {
    let scoped = mirrors.get(url);
    if (!scoped) {
      scoped = createMirror(deps, url);
      mirrors.set(url, scoped);
    }
    return scoped;
  };
  return {
    ensure: (version: string, serverUrl: string) => mirror(serverUrl).ensure(version),
    apply: (version: string, serverUrl: string) => mirror(serverUrl).apply(version),
    restore: (serverUrl: string) => mirror(serverUrl).restore(),
    recover: (serverUrl: string) => mirror(serverUrl).recover(),
    state: (serverUrl: string) => mirror(serverUrl).state(),
    holds: (serverUrl: string) => mirror(serverUrl).holds(),
    async stop() { await Promise.all([...mirrors.values()].map((scope) => scope.stop())); },
  };
}

function createMirror(deps: ClusterConfigDeps, serverUrl: string): Mirror {
  let applied: Applied | null = null;
  let files: ConfigState["files"] = "none";
  let plugins: ConfigState["plugins"] = "none";
  let filesError: string | null = null;
  let pluginsError: string | null = null;
  let missingCommands: string[] = [];
  /** When the last plugin step started (Date.now()). */
  let pluginsTried = 0;
  let stopped = false;
  // Restores called and not yet finished: while one is, ensure is refused.
  let restoring = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, Promise<Record<string, string>>>();
  // Leaving or stopping cancels only this link's active work.
  let halt = new AbortController();
  let left = false;

  const state = (): ConfigState => ({
    version: applied?.version ?? null,
    files,
    plugins,
    error: filesError ?? pluginsError,
    missingCommands: [...missingCommands],
  });
  const report = () => deps.onState(state(), serverUrl);
  const cc = join(
    deps.stateDir(),
    HOST_CONFIG_MIRROR_DIR,
    "servers",
    createHash("sha256").update(serverUrl).digest("hex"),
  );
  const objects = join(cc, "objects");
  const stateFile = join(cc, "state.json");
  const rootsOf = (generation: string) => ({
    agent: join(cc, "generations", generation, "agent"),
    home: join(cc, "generations", generation, "home"),
  });
  const environment = ({ generation, agentEnv }: Applied) => {
    const { agent, home } = rootsOf(generation);
    return {
      ...sanitizeAgentEnvValues(agentEnv).values,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      PI_CODING_AGENT_DIR: agent,
      OMP_CODING_AGENT_DIR: agent,
      PI_CONFIG_DIR: ".omp",
      COPILOT_HOME: join(home, ".copilot"),
      COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "",
      PI_PROFILE: "",
      OMP_PROFILE: "",
    };
  };
  /** Applies, restores and plugin jobs run one at a time in call order: a restore never races an apply or its plugins. */
  const enqueue = (job: () => Promise<void>) => {
    const run = queue.then(job);
    queue = run.catch(() => undefined);
    return run;
  };
  const installedPlugins = (env: Record<string, string>) =>
    listPlugins((args) => deps.runOmp(args, LIST_MS, halt.signal, env));

  function failure(error: unknown, what: string): HostOpError {
    if (error instanceof HostOpError) return error; // reported where it was raised
    const reason = messageOf(error);
    files = "failed";
    filesError = reason;
    report();
    deps.log(`cluster-config: ${what} failed: ${reason}`);
    return new HostOpError(409, "cluster_config_failed", reason);
  }

  function current() {
    if (files === "current" && filesError === null) return;
    files = "current";
    filesError = null;
    report();
  }

  /** A request to the master: answered, body included, within clusterConfigTimings.fetchMs, and cut short by stop(). */
  async function fromMaster<T>(
    serverUrl: string,
    path: string,
    what: string,
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const signal = AbortSignal.any([
      halt.signal,
      AbortSignal.timeout(clusterConfigTimings.fetchMs),
    ]);
    try {
      return await read(await deps.fetch(serverUrl, path, signal));
    } catch (error) {
      if (!signal.aborted) throw error;
      return fail(
        stopped
          ? "the host daemon is stopping"
          : left
            ? "this host is leaving the cluster"
            : `the master did not send ${what} within ${clusterConfigTimings.fetchMs / 1000} s`,
      );
    }
  }

  async function fetchManifest(serverUrl: string): Promise<ConfigManifest> {
    const body = await fromMaster(
      serverUrl,
      `${API}manifest`,
      "the manifest",
      async (res) => {
        if (!res.ok) {
          await res.body?.cancel();
          fail(`the master answered ${res.status} for the manifest`);
        }
        return readBody(
          res,
          CONFIG_LIMITS.manifestBytes,
          `the manifest is longer than ${CONFIG_LIMITS.manifestBytes} bytes`,
        );
      },
    );
    return checkManifest(parseJson(body.toString("utf8"), "the manifest"));
  }

  /** Every file of `manifest` in `objects/`, verified before it enters; false when the master no longer has one (404). */
  async function download(
    serverUrl: string,
    manifest: ConfigManifest,
  ): Promise<boolean> {
    for (const file of manifest.files) {
      if (stopped) fail("the host daemon is stopping");
      const target = join(objects, file.hash);
      if (exists(target)) continue;
      const bytes = await fromMaster(
        serverUrl,
        `${API}file/${file.hash}`,
        file.path,
        async (res) => {
          if (res.ok)
            return readBody(
              res,
              file.size,
              `${file.path} is longer than the manifest says`,
            );
          await res.body?.cancel();
          return res.status === 404
            ? null
            : fail(`the master answered ${res.status} for ${file.path}`);
        },
      );
      if (bytes === null) return false;
      if (createHash("sha256").update(bytes).digest("hex") !== file.hash)
        fail(`${file.path} does not match its hash`);
      writeAtomic(target, bytes);
    }
    return true;
  }

  function mergedSettings(
    master: string,
    own: { path: string; yaml: string } | null,
  ): string {
    if (own && !readsAsMap(own.yaml))
      deps.log(
        `cluster-config: ${own.path} cannot be read as settings; this host's own machine-specific settings were not kept`,
      );
    return mergeLocalSettings(master, own?.yaml ?? null);
  }

  function install(manifest: ConfigManifest): Applied {
    const next = {
      version: manifest.version,
      generation: randomBytes(16).toString("hex"),
      plugins: manifest.plugins,
      agentEnv: manifest.agentEnv,
    };
    const roots = rootsOf(next.generation);
    const own = ownSettings(deps.roots().agent);
    try {
      makeDir(roots.agent);
      makeDir(roots.home);
      // The blob references in a transcript must outlive any config generation.
      const blobs = deps.blobsDir();
      makeDir(blobs);
      symlinkSync(blobs, join(roots.agent, "blobs"), "dir");
      symlinkSync(
        deps.sessionsDir?.() ?? join(deps.roots().agent, "sessions"),
        join(roots.agent, "sessions"),
        "dir",
      );
      let settings = false;
      for (const file of manifest.files) {
        const bytes = readFileSync(join(objects, file.hash));
        if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.hash)
          fail(`${file.path} does not match its hash or size`);
        const isSettings = file.root === "agent" && file.path === "config.yml";
        settings ||= isSettings;
        writeAtomic(join(roots[file.root], file.path), isSettings ? mergedSettings(bytes.toString("utf8"), own) : bytes, file.exec ? 0o700 : 0o600);
      }
      if (!settings && own)
        writeAtomic(join(roots.agent, "config.yml"), mergedSettings("", own));
      writeAtomic(stateFile, JSON.stringify(next));
      return next;
    } catch (error) {
      removeAll(dirname(roots.agent));
      throw error;
    }
  }

  async function applyFiles(version: string): Promise<void> {
    if (stopped) fail("the host daemon is stopping");
    if (applied?.version !== version) {
      let manifest = await fetchManifest(serverUrl);
      if (manifest.version !== applied?.version && !(await download(serverUrl, manifest))) {
        manifest = await fetchManifest(serverUrl);
        if (manifest.version !== applied?.version && !(await download(serverUrl, manifest)))
          fail("the master's configuration changed during the download");
      }
      if (stopped) fail("the host daemon is stopping");
      if (left || restoring > 0) fail("this host is leaving the cluster");
      if (manifest.version !== applied?.version) {
        applied = install(manifest);
        files = "none"; // Publish the new version even when the previous one was current.
        plugins = "pending";
        pluginsError = null;
        missingCommands = [];
      }
    }
    current();
  }

  /** omp's plugins in line with `target`: installs, then removals, then enabled states. Answers the first failure's last line of omp output. */
  async function reconcile(target: Applied): Promise<string | null> {
    const env = environment(target);
    let failed: string | null = null;
    // Logs name the plugin, never the install spec: a declared source can carry credentials (`git+https://user:token@…`).
    const run = async (
      action: string,
      id: string,
      timeoutMs: number,
      spec = id,
    ) => {
      if (stopped) return;
      try {
        await deps.runOmp(["plugin", action, spec], timeoutMs, halt.signal, env);
      } catch (error) {
        failed ??= lastLine(error);
        deps.log(`cluster-config: omp plugin ${action} ${id} failed`);
      }
    };
    const key = (plugin: PluginEntry) => `${plugin.kind}:${plugin.id}`;
    try {
      let have = new Map(
        (await installedPlugins(env)).map((plugin) => [key(plugin), plugin]),
      );
      const wanted = new Set(target.plugins.map(key));
      const installed: PluginEntry[] = [];
      for (const plugin of target.plugins) {
        const present = have.get(key(plugin));
        const spec = installSpec(plugin);
        // Same version from another source (the registry's package for a Git plugin) is not the master's plugin. A master that
        // sent no source counts by version; a member whose source is unknown installs the master's.
        const sameSource =
          plugin.source === undefined ||
          (present?.source !== undefined && installSpec(present) === spec);
        if (
          present &&
          (plugin.kind !== "npm" ||
            ((plugin.version === null || present.version === plugin.version) &&
              sameSource))
        )
          continue;
        if (spec === null) {
          failed ??= `${plugin.id} is installed from a local directory on the master; install it on this host by hand`;
          deps.log(
            `cluster-config: ${plugin.id} cannot be installed here (a local directory on the master)`,
          );
          continue;
        }
        await run("install", plugin.id, INSTALL_MS, spec);
        installed.push(plugin);
      }
      for (const plugin of have.values())
        if (!wanted.has(key(plugin)))
          await run("uninstall", plugin.id, UNINSTALL_MS);
      // Whether a fresh install starts enabled is omp's choice: read it back.
      if (installed.length > 0 && !stopped)
        have = new Map(
          (await installedPlugins(env)).map((plugin) => [key(plugin), plugin]),
        );
      // An unpinned source (a git branch, a tarball) can resolve to another version than the master runs.
      for (const plugin of installed) {
        const present = have.get(key(plugin));
        if (
          stopped ||
          plugin.kind !== "npm" ||
          plugin.version === null ||
          present?.version === plugin.version
        )
          continue;
        failed ??= `${plugin.id}: installed ${present?.version ?? "nothing"}, the master runs ${plugin.version}`;
      }
      for (const plugin of target.plugins) {
        const present = have.get(key(plugin));
        if (present && present.enabled !== plugin.enabled)
          await run(
            plugin.enabled ? "enable" : "disable",
            plugin.id,
            TOGGLE_MS,
          );
      }
    } catch (error) {
      failed ??= lastLine(error);
    }
    return failed;
  }

  /** The `command` of every server in the mirrored MCP files that this host lacks. Diagnostic only. */
  async function missingMcpCommands(target: Applied): Promise<string[]> {
    const commands = new Set<string>();
    for (const name of ["mcp.json", ".mcp.json"]) {
      let servers: unknown;
      try {
        servers = JSON.parse(
          readFileSync(join(rootsOf(target.generation).agent, name), "utf8"),
        ).mcpServers;
      } catch {
        continue; // absent or unreadable: omp reports it itself
      }
      if (!isRecord(servers)) continue;
      for (const server of Object.values(servers))
        if (
          isRecord(server) &&
          typeof server.command === "string" &&
          server.command.trim()
        )
          commands.add(server.command.trim());
    }
    const missing: string[] = [];
    for (const command of commands)
      if (!(await deps.commandExists(command))) missing.push(command);
    return missing;
  }



  /** Step 7, in the queue after the files and without the caller waiting for it. */
  async function syncPlugins(target: Applied) {
    pluginsTried = Date.now();
    const failed = await reconcile(target);
    const missing = await missingMcpCommands(target).catch(() => missingCommands);
    if (stopped || left) return;
    plugins = failed === null ? "current" : "failed";
    pluginsError = failed;
    missingCommands = missing;
    report();
  }

  let saved: unknown;
  try {
    saved = parseJson(readFileSync(stateFile, "utf8"), "the mirror's state.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      deps.log("cluster-config: state.json cannot be read; no version counts as applied");
  }
  if (
    isRecord(saved) &&
    typeof saved.version === "string" && HASH_RE.test(saved.version) &&
    typeof saved.generation === "string" && /^[0-9a-f]{32}$/.test(saved.generation) &&
    Array.isArray(saved.plugins) && saved.plugins.every(isPlugin) &&
    isRecord(saved.agentEnv) && Object.values(saved.agentEnv).every((value) => typeof value === "string") &&
    exists(rootsOf(saved.generation).agent) && exists(rootsOf(saved.generation).home)
  ) {
    const target = saved as Applied;
    applied = target;
    files = "current";
    plugins = "pending";
    void enqueue(() => syncPlugins(target));
  }

  function ensure(version: string): Promise<Record<string, string>> {
    if (stopped || left || restoring > 0)
      return Promise.reject(new HostOpError(409, "cluster_config_failed", "This host is no longer available for this cluster configuration"));
    if (applied?.version === version && (
      plugins !== "failed" || Date.now() - pluginsTried < clusterConfigTimings.pluginRetryMs
    )) {
      current();
      return Promise.resolve(environment(applied));
    }
    const shared = inflight.get(version);
    if (shared) return shared;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, string>>();
    inflight.set(version, promise);
    void enqueue(async () => {
      try {
        if (left || restoring > 0) fail("this host is leaving the cluster");
        await applyFiles(version);
        if (left || restoring > 0) fail("this host is leaving the cluster");
        const target = applied ?? fail("no cluster configuration is available");
        resolve(environment(target));
        if (plugins === "pending" || (plugins === "failed" && Date.now() - pluginsTried >= clusterConfigTimings.pluginRetryMs)) {
          const wasFailed = plugins === "failed";
          plugins = "pending";
          pluginsError = null;
          if (wasFailed) report();
          await syncPlugins(target);
        }
      } catch (error) {
        reject(failure(error, "applying"));
      } finally {
        inflight.delete(version);
      }
    });
    return promise;
  }

  return {
    ensure,
    apply(version: string) {
      if (restoring > 0) return queue.then(() => {
        left = false;
        return ensure(version);
      });
      left = false;
      return ensure(version);
    },
    recover() {
      if (!applied || stopped || left || restoring > 0)
        throw new HostOpError(409, "cluster_config_failed", "No saved configuration is available for the session's server");
      return environment(applied);
    },
    restore() {
      left = true;
      restoring++;
      halt.abort();
      // A restart during plugin cancellation must not resurrect this mirror.
      try {
        rmSync(stateFile, { force: true });
        applied = null;
      } catch (error) {
        restoring--;
        return Promise.reject(failure(error, "restoring"));
      }
      return enqueue(async () => {
        try {
          if (!stopped) halt = new AbortController();
          removeAll(cc);
          ({ files, plugins, missingCommands } = emptyState());
          filesError = pluginsError = null;
          report();
        } catch (error) {
          throw failure(error, "restoring");
        }
      }).finally(() => { restoring--; });
    },
    state,
    holds: () => applied !== null && !left,
    async stop() {
      stopped = true;
      halt.abort();
      await queue;
    },
  };
}
