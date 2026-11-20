import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import runnerManifest from "../runner/package.json";

const root = path.resolve(import.meta.dir, "..");
const runnerDir = path.join(root, "runner");
const releaseTargets = [
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
  "bun-darwin-x64-baseline",
  "bun-darwin-arm64",
];
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string" },
    "no-runner": { type: "boolean" },
    "no-archive": { type: "boolean" },
    "with-klc": { type: "boolean" },
  },
});
const targets = values.target === undefined ? releaseTargets : [values.target];
for (const target of targets) {
  if (!/^bun-(linux|darwin)-(x64(?:-baseline)?|arm64)$/.test(target)) {
    throw new Error(
      `Unsupported target: ${target}. Expected a Linux or macOS x64 or arm64 Bun target.`,
    );
  }
}

async function run(...args: string[]): Promise<void> {
  const code = await Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (code !== 0) throw new Error(`bun ${args.join(" ")} exited with ${code}`);
}

async function finish(jobs: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(jobs);
  const failures = results.filter((result) => result.status === "rejected");
  for (const failure of failures) console.error(failure.reason);
  if (failures.length > 0) process.exit(1);
}

const runnerTargets = targets.map((target) =>
  target.replace(/^bun-/, "").replace(/-baseline$/, ""),
);
async function buildRunners(): Promise<void> {
  // Reuse the pinned tarballs when root postinstall already fetched them.
  if (
    Object.values(runnerManifest.overrides).some(
      (spec) =>
        spec.startsWith("file:./vendor/") &&
        !existsSync(path.resolve(runnerDir, spec.slice("file:".length))),
    )
  ) {
    await run("runner/scripts/use-omp-build.ts");
  }
  const [platform, arch] =
    runnerTargets.length === 1 ? runnerTargets[0].split("-") : ["*", "*"];
  await run(
    "install",
    "--cwd=runner",
    "--frozen-lockfile",
    `--os=${platform}`,
    `--cpu=${arch}`,
  );
  await run("runner/scripts/build-binary.ts", ...runnerTargets);
}

await finish([run("run", "build"), buildRunners()]);
console.log("Client and runners ready; building Keylime binaries");

const archiveArgs = values["no-archive"] ? ["--no-archive"] : [];
const runnerArgs = values["no-runner"] ? ["--no-runner"] : [];
await finish(
  targets.map(async (target) => {
    const start = performance.now();
    console.log(`[${target}] building Keylime`);
    await run(
      "scripts/build-binary.ts",
      "--target",
      target,
      ...archiveArgs,
      ...runnerArgs,
    );
    if (values["with-klc"]) {
      await run(
        "scripts/build-klc-binary.ts",
        "--target",
        target,
        ...archiveArgs,
      );
    }
    console.log(
      `[${target}] finished in ${((performance.now() - start) / 1000).toFixed(1)}s`,
    );
  }),
);
