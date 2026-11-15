import { readdirSync, watch, type Dirent, type FSWatcher } from "node:fs";
import path from "node:path";
import { runApiGeneration } from "./api-lifecycle";

const ignored: Record<string, true> = {
  node_modules: true,
  ".git": true,
  dist: true,
  build: true,
};
const sourceFile = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml)$/;
const rootInputs: Record<string, true> = {
  "package.json": true,
  "bun.lock": true,
  "bun.lockb": true,
  "bunfig.toml": true,
  "tsconfig.json": true,
};
const runnerInputs: Record<string, true> = {
  "package.json": true,
  "bun.lock": true,
  "bun.lockb": true,
  "tsconfig.json": true,
};

export interface ApiContractWatcher {
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Watch API inputs without watching generated documentation or dependency trees. */
export function watchApiContracts(
  root: string,
  env: Record<string, string | undefined>,
  onError: (error: unknown) => void,
): ApiContractWatcher {
  const watchers = new Map<string, FSWatcher>();
  const controller = new AbortController();
  let closed = false;
  let dirty = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let initial: Promise<void> | undefined;

  function fail(error: unknown) {
    if (!closed) onError(error);
  }

  function run(): Promise<void> {
    dirty = false;
    const generation = runApiGeneration(root, {
      env,
      signal: controller.signal,
    });
    active = generation;
    void generation.then(
      () => {
        if (active === generation) active = undefined;
        if (dirty && !closed) schedule();
      },
      (error) => {
        if (active === generation) active = undefined;
        fail(error);
      },
    );
    return generation;
  }

  function schedule() {
    if (closed) return;
    dirty = true;
    if (active) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed && dirty && !active) void run().catch(() => {});
    }, 100);
  }

  function addTree(directory: string) {
    if (closed || watchers.has(directory)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const watcher = watch(directory, (event, filename) => {
      if (closed) return;
      const name = filename?.toString();
      if (!name) {
        schedule();
        return;
      }
      if (ignored[name]) return;
      const full = path.join(directory, name);
      if (event === "rename") {
        for (const [watched, handle] of watchers) {
          if (watched === full || watched.startsWith(`${full}${path.sep}`)) {
            handle.close();
            watchers.delete(watched);
          }
        }
        try {
          addTree(full);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") fail(error);
        }
      }
      if (sourceFile.test(name) || event === "rename") schedule();
    });
    watcher.on("error", fail);
    watchers.set(directory, watcher);
    for (const entry of entries) {
      if (entry.isDirectory() && !ignored[entry.name])
        addTree(path.join(directory, entry.name));
    }
  }

  function addFiltered(directory: string, names: Record<string, true>) {
    const watcher = watch(directory, (_event, filename) => {
      if (!filename || names[filename.toString()]) schedule();
    });
    watcher.on("error", fail);
    watchers.set(directory, watcher);
  }

  try {
    addFiltered(root, rootInputs);
    addFiltered(path.join(root, "runner"), runnerInputs);
    for (const directory of ["lib", "app/api", "runner/src", "server"])
      addTree(path.join(root, directory));
    addFiltered(path.join(root, "scripts"), {
      "generate-api-docs.ts": true,
      "api-schema.ts": true,
      "bootstrap-api-schema.ts": true,
      "api-semantics.ts": true,
      "api-lifecycle.ts": true,
      "dev-api-contracts.ts": true,
    });
  } catch (error) {
    for (const watcher of watchers.values()) watcher.close();
    throw error;
  }

  return {
    start() {
      return (initial ??= run());
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      controller.abort();
      if (active) await active.catch(() => {});
    },
  };
}
