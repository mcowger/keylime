// Compile klc without the server, browser assets or runner. The archive includes the licenses for its bundle.
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { bundledPackageDirs, writeLicenses } from "./licenses";
import { embeddedAddonFiles } from "../runner/scripts/embed-native";

const root = path.join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string" },
    "out-dir": { type: "string" },
    "no-archive": { type: "boolean" },
  },
});
const target = values.target ?? `bun-${process.platform}-${process.arch}`;
if (!/^bun-(linux|darwin)-(x64(?:-baseline)?|arm64)$/.test(target)) {
  console.error(`Unsupported target: ${target}. Expected a Linux or macOS x64 or arm64 Bun target.`);
  process.exit(1);
}
const bunLicense = path.join(import.meta.dir, `bun-LICENSE-${Bun.version}.md`);
if (!existsSync(bunLicense)) {
  console.error(`No scripts/bun-LICENSE-${Bun.version}.md: save https://github.com/oven-sh/bun/blob/bun-v${Bun.version}/LICENSE.md there.`);
  process.exit(1);
}
const name = `klc-${target.replace(/^bun-/, "").replace(/-baseline$/, "")}`;
const release = values["out-dir"] ? path.resolve(values["out-dir"]) : path.join(root, "release");
const out = path.join(release, name);
rmSync(out, { recursive: true, force: true });
const [, platform, arch] = target.split("-");
const nativePackage = `@oh-my-pi/pi-natives-${platform}-${arch}`;
const nativesRoot = path.dirname(Bun.resolveSync("@oh-my-pi/pi-natives", path.join(root, "runner")));
const nativeLicenseDir = path.dirname(Bun.resolveSync(`${nativePackage}/package.json`, nativesRoot));

const result = await Bun.build({
  entrypoints: [path.join(root, "runner/src/klc.ts")],
  files: await embeddedAddonFiles({ platform, arch }),
  compile: {
    target: target as Bun.Build.CompileTarget,
    outfile: path.join(out, "klc"),
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  minify: { identifiers: true, keepNames: true },
  metafile: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  throw: false,
});
for (const log of result.logs) console.log(log);
if (!result.success) process.exit(1);
cpSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
writeLicenses(out, [...bundledPackageDirs(result.metafile!, process.cwd()), nativeLicenseDir].sort(), bunLicense, "klc");
if (!values["no-archive"]) {
  // tar preserves the executable bit; Bun.Archive writes every entry as 0644.
  const archive = path.join(release, `${name}.tar.gz`);
  rmSync(archive, { force: true });
  if (Bun.spawnSync(["tar", "-czf", path.basename(archive), name], {
    cwd: release,
    stdio: ["ignore", "inherit", "inherit"],
  }).exitCode !== 0) process.exit(1);
  console.log(`built ${out} and ${archive}`);
} else {
  console.log(`built ${out}`);
}
