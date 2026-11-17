#!/usr/bin/env bun
/**
 * Compiles `src/cli.ts` into a standalone `keylime-omp-<os>-<arch>` binary under `release/`, the way
 * omp builds its release binaries (`scripts/ci-release-build-binaries.ts` and
 * `packages/coding-agent/scripts/compile-binary.ts` upstream). Those helpers assume the monorepo
 * (addons under `packages/natives/native`, docs and the stats client generated in place), so this
 * script feeds the same `Bun.build` the prebuilt equivalents the npm packages ship. The packages are
 * the pinned `ompweb-dev/oh-my-pi` build's tarballs in `vendor/` (`scripts/use-omp-build.ts`).
 *
 * Usage: `bun scripts/build-binary.ts [target...]`; with no target it builds the host's.
 * A cross target needs its addon package installed: `bun install --os=<os> --cpu=<cpu>`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { USER_AGENT } from "@oh-my-pi/pi-utils/dirs";
import { createJsonParsePlugin } from "../node_modules/@oh-my-pi/pi-coding-agent/scripts/json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "../node_modules/@oh-my-pi/pi-coding-agent/scripts/legacy-pi-virtual-module";
import { embeddedAddonFiles } from "./embed-native";

interface Target {
  /** Native addon platform tag (`process.platform`). */
  readonly platform: string;
  readonly arch: string;
  readonly bun: Bun.Build.CompileTarget;
  readonly outName: string;
}

// The four targets omp's release ships to glibc/macOS users.
const TARGETS: Record<string, Target> = {
  "linux-x64": {
    platform: "linux",
    arch: "x64",
    bun: "bun-linux-x64-baseline",
    outName: "keylime-omp-linux-x64",
  },
  "linux-arm64": {
    platform: "linux",
    arch: "arm64",
    bun: "bun-linux-arm64",
    outName: "keylime-omp-linux-arm64",
  },
  "darwin-x64": {
    platform: "darwin",
    arch: "x64",
    bun: "bun-darwin-x64",
    outName: "keylime-omp-darwin-x64",
  },
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    bun: "bun-darwin-arm64",
    outName: "keylime-omp-darwin-arm64",
  },
};

/** Never bundled: omp installs them on demand at runtime (upstream `COMPILED_EXTERNAL_DEPENDENCIES`). */
const EXTERNAL = ["@huggingface/transformers", "fastembed", "onnxruntime-node"];

const runnerDir = path.resolve(import.meta.dir, "..");

function packageDir(name: string, from: string): string {
  // Every package here maps `.` to a file one level below its root (`src/index.ts`, `native/index.js`).
  return path.dirname(path.dirname(Bun.resolveSync(name, from)));
}

const codingAgentDir = packageDir("@oh-my-pi/pi-coding-agent", runnerDir);
const statsDir = await fs.realpath(
  packageDir("@oh-my-pi/omp-stats", codingAgentDir),
);


/** The `omp stats` dashboard as the base64 gzip tar omp-stats serves when compiled (upstream `gen:stats`). */
async function embeddedStatsClient(): Promise<Record<string, string>> {
  const clientDir = path.join(statsDir, "dist", "client");
  const entries: Record<string, Uint8Array> = {};
  for await (const file of new Bun.Glob("**/*").scan({
    cwd: clientDir,
    onlyFiles: true,
  })) {
    entries[file.split(path.sep).join("/")] = await Bun.file(
      path.join(clientDir, file),
    ).bytes();
  }
  if (!entries["index.html"])
    throw new Error(`omp-stats ships no dashboard in ${clientDir}`);
  const archive = Bun.gzipSync(await new Bun.Archive(entries).bytes(), {
    level: 9,
  });
  return {
    [path.join(statsDir, "src", "embedded-client.generated.txt")]:
      Buffer.from(archive).toString("base64"),
  };
}
// The pinned OMP broker assembles Chromium's argv itself. Patch only that
// assembly, and reject an upstream change instead of silently losing capture.
function browserVideoLaunchPlugin(applied: () => void): Bun.BunPlugin {
  const launchPath = path.join(codingAgentDir, "src/tools/browser/launch.ts");
  const marker = 'args: [...defaults.filter(arg => !ignored.has(arg)), "--no-startup-window", "--remote-debugging-port=0"],';
  return {
    name: "keylime-browser-video-launch",
    setup(build) {
      build.onLoad({ filter: /[\\/]tools[\\/]browser[\\/]launch\.ts$/ }, async ({ path: file }) => {
        if (await fs.realpath(file) !== await fs.realpath(launchPath)) return;
        const source = await fs.readFile(file, "utf8");
        if (source.split(marker).length !== 2) throw new Error("Pinned OMP browser launch changed; update the video launch patch");
        applied();
        const helper = path.join(runnerDir, "src/commands/native-video-extension.ts");
        return {
          loader: "ts",
          contents: `import { prepareNativeVideoExtension as keylimePrepareVideoExtension, NATIVE_VIDEO_EXTENSION_ID as keylimeVideoExtensionId } from ${JSON.stringify(helper)};\n` + source.replace(marker,
            'args: [...defaults.filter(arg => !ignored.has(arg) && arg !== "--disable-extensions"), "--no-startup-window", "--remote-debugging-port=0", `--load-extension=${await keylimePrepareVideoExtension(path.dirname(opts.userDataDir))}`, `--allowlisted-extension-id=${keylimeVideoExtensionId}`],'),
        };
      });
    },
  };
}


async function build(
  id: string,
  target: Target,
  statsClient: Record<string, string>,
  docsEmbed: string,
): Promise<void> {
  let videoLaunchPatched = false;
  const outfile = path.join(runnerDir, "release", target.outName);
  console.log(`Building ${path.relative(runnerDir, outfile)}...`);
  const output = await Bun.build({
    entrypoints: [path.join(runnerDir, "src", "cli.ts")],
    root: runnerDir,
    external: EXTERNAL,
    files: { ...(await embeddedAddonFiles(target)), ...statsClient },
    define: {
      "process.env.PI_COMPILED": JSON.stringify("true"),
      "process.env.PI_DOCS_EMBED": JSON.stringify(docsEmbed),
    },
    format: "esm",
    bytecode: true,
    splitting: true,
    // Upstream's `chunks/[name]-[hash]` collides here: type-only modules from different packages
    // (`pi-tui/src/render/types.ts`, `pi-coding-agent/src/dap/types.ts`) emit identical chunks.
    naming: { chunk: "chunks/[dir]/[name]-[hash].[ext]" },
    minify: { identifiers: true, keepNames: true },
    plugins: [
      browserVideoLaunchPlugin(() => { videoLaunchPatched = true; }),
      createJsonParsePlugin(),
      await createLegacyPiVirtualModulePlugin(),
    ],
    compile: {
      execArgv: [`--user-agent=${USER_AGENT}`],
      target: target.bun,
      outfile,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    throw: false,
  });
  if (!videoLaunchPatched) throw new Error("Pinned OMP browser launch was not patched for video");
  if (!output.success)
    throw new Error(
      `${id}: bundle failed:\n${output.logs.map((log) => log.message).join("\n")}`,
    );
  // shortcut: darwin binaries carry only Bun's built-in ad-hoc signature (no hardened runtime, no
  // entitlements); add omp's Developer ID signing step before distributing outside our own machines.
}

const hostId = `${process.platform}-${process.arch}`;
const ids = process.argv.length > 2 ? process.argv.slice(2) : [hostId];
for (const id of ids) {
  if (!TARGETS[id])
    throw new Error(
      `unknown target ${id}; expected one of ${Object.keys(TARGETS).join(", ")}`,
    );
}
const root = path.resolve(runnerDir, "..");
await fs.cp(
  path.join(root, "docs", "api"),
  path.join(runnerDir, "release", "docs", "api"),
  { recursive: true },
);
await fs.copyFile(path.join(runnerDir, "src/commands/native-video-LICENSE.txt"), path.join(runnerDir, "release", "native-video-LICENSE.txt"));
// npm packs the docs corpus the compiled binary would otherwise embed from the monorepo's `docs/`.
const docsEmbed = (
  await Bun.file(
    path.join(codingAgentDir, "dist", "docs-index.generated.txt"),
  ).text()
).trimEnd();
const statsClient = await embeddedStatsClient();
for (const id of ids) await build(id, TARGETS[id], statsClient, docsEmbed);
