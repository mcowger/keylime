// `bun run build:binary [--target bun-<os>-<arch>]` (after the client build and the runner build,
// `bun runner/scripts/build-binary.ts <os>-<arch>`): compiles server/binary.ts into release/ompweb-<os>-<arch>/ompweb
// next to the files it serves, the omp runner it spawns (ompweb-omp; not with --no-runner,
// where ompweb fetches it from its release, lib/omp/runner-fetch.ts) and the licenses of what it redistributes, then
// archives that directory as release/ompweb-<os>-<arch>.tar.gz. Default target: this machine.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { bundledPackageDirs, writeLicenses } from "./licenses";

const root = path.join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string" },
    "no-runner": { type: "boolean" },
    "no-archive": { type: "boolean" },
  },
});
const target = (values.target ??
  `bun-${process.platform}-${process.arch}`) as Bun.Build.CompileTarget;
if (!/^bun-(linux|darwin)-(x64|arm64)(-baseline)?$/.test(target)) {
  console.error(
    `Unsupported target: ${target}. Expected a Linux or macOS x64 or arm64 Bun target.`,
  );
  process.exit(1);
}
// A -baseline target (x64 without AVX2, what releases ship) keeps the plain name, which the README and the update notice use.
const name = `ompweb-${target.replace(/^bun-/, "").replace(/-baseline$/, "")}`;
const release = path.join(root, "release");
const out = path.join(release, name);
rmSync(out, { recursive: true, force: true });

// build-client.ts lists the npm packages in the client bundle; the binary embeds this Bun's runtime.
const clientPackagesFile = path.join(root, "build", "client-packages.json");
if (!existsSync(clientPackagesFile)) {
  console.error("No build/client-packages.json: run `bun run build` first.");
  process.exit(1);
}
const bunLicense = path.join(import.meta.dir, `bun-LICENSE-${Bun.version}.md`);
if (!existsSync(bunLicense)) {
  console.error(
    `No scripts/bun-LICENSE-${Bun.version}.md: save https://github.com/oven-sh/bun/blob/bun-v${Bun.version}/LICENSE.md there.`,
  );
  process.exit(1);
}

const result = await Bun.build({
  entrypoints: [path.join(root, "server", "binary.ts")],
  // A .env or bunfig.toml in the directory ompweb is started from belongs to the user's project, not to ompweb.
  compile: {
    target,
    outfile: path.join(out, "ompweb"),
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  // What `bun build --compile --production` sets. Without the define the bundle reads NODE_ENV as "development", and
  // the server never writes the local daemon link (instrumentation.node.ts), so no session ever lists.
  minify: true,
  metafile: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  throw: false,
});
for (const log of result.logs) console.log(log);
if (!result.success) process.exit(1);

// The static root (server/binary.ts): the client, the public files, the KaTeX CSS and fonts (where the server
// resolves the katex package), and the licenses of what ships. Beside the binary, unless --no-runner: the omp runner
// it spawns (`ompweb-omp`, lib/omp/omp-cli.ts), built first by runner/scripts/build-binary.ts.
const copy = (from: string, to: string) =>
  cpSync(from, path.join(out, to), { recursive: true });
for (const file of ["dist", "public", "LICENSE"])
  copy(path.join(root, file), file);
if (!values["no-runner"]) {
  const runnerTarget = name.slice("ompweb-".length);
  const runner = path.join(
    root,
    "runner",
    "release",
    `ompweb-omp-${runnerTarget}`,
  );
  if (!existsSync(runner)) {
    console.error(
      `No ${path.relative(root, runner)}: run \`bun runner/scripts/build-binary.ts ${runnerTarget}\` first.`,
    );
    process.exit(1);
  }
  copy(runner, "ompweb-omp");
}
for (const file of new Bun.Glob("app/fonts/*-{OFL.txt,LICENSE.*}").scanSync(
  root,
))
  copy(path.join(root, file), file);
const katex = path.dirname(Bun.resolveSync("katex/package.json", root));
for (const file of [
  "package.json",
  "LICENSE",
  "dist/katex.min.css",
  "dist/fonts",
])
  copy(path.join(katex, file), `node_modules/katex/${file}`);
const clientPackages = (
  JSON.parse(readFileSync(clientPackagesFile, "utf8")) as string[]
).map((dir) => path.resolve(root, dir));
writeLicenses(
  out,
  [
    ...new Set([
      ...bundledPackageDirs(result.metafile!, process.cwd()),
      ...clientPackages,
    ]),
  ].sort(),
  bunLicense,
);

if (!values["no-archive"]) {
  // Bun.Archive writes every entry as 0644; tar preserves the binary's execute bit.
  const archive = path.join(release, `${name}.tar.gz`);
  rmSync(archive, { force: true });
  const command = ["tar", "-czf", path.basename(archive), name];
  if (
    Bun.spawnSync(command, {
      cwd: release,
      stdio: ["ignore", "inherit", "inherit"],
    }).exitCode !== 0
  )
    process.exit(1);
  console.log(`built ${path.relative(root, out)} and ${path.relative(root, archive)}`);
} else {
  console.log(`built ${path.relative(root, out)}`);
}
