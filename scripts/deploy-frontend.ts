import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// Only isolated browser UI source may differ. Shared modules, protocol, dependencies,
// build configuration, and public service worker require a full deployment.
export function assertFrontendCompatible(root: string, activeSha: string, candidateSha: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(activeSha) || !/^[0-9a-f]{40,64}$/.test(candidateSha))
    throw new Error("Active and candidate releases require valid commit SHAs");
  const result = Bun.spawnSync(["git", "-C", root, "diff", "--no-renames", "--name-only", "-z", activeSha, candidateSha, "--"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 || result.signalCode)
    throw new Error(`Cannot compare active and candidate commits: ${result.stderr.toString()}`);
  const changed = result.stdout.toString().split("\0").filter(Boolean);
  const unsafe = changed.filter((file) => !/^(components|hooks)\//.test(file) && !(file.startsWith("app/") && !file.startsWith("app/api/")));
  if (unsafe.length) throw new Error(`Frontend-only deployment includes backend or shared changes: ${unsafe.join(", ")}`);
}

export function prepareFrontend(candidate: string, previous?: string): void {
  const dist = path.join(candidate, "dist");
  if (!existsSync(path.join(dist, "index.html")) || !existsSync(path.join(candidate, "public")))
    throw new Error("Frontend release must contain dist/index.html and public");
  const assets = path.join(dist, "assets");
  const workers = path.join(dist, "workers");
  mkdirSync(assets, { recursive: true });
  mkdirSync(workers, { recursive: true });
  const retain = (source: string, target: string) => {
    if (!existsSync(source)) return;
    for (const name of readdirSync(source)) {
      const from = path.join(source, name);
      const to = path.join(target, name);
      if (existsSync(to)) {
        if (!readFileSync(from).equals(readFileSync(to))) throw new Error(`Conflicting retained frontend asset: ${name}`);
      } else cpSync(from, to);
    }
  };
  if (previous && realpathSync(previous) !== realpathSync(candidate)) {
    retain(path.join(previous, "dist/assets"), assets);
    retain(path.join(previous, "dist/workers"), workers);
    const previousWorker = path.join(previous, "dist/event-stream-worker.js");
    if (existsSync(previousWorker)) {
      const bytes = readFileSync(previousWorker);
      const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.js`;
      const target = path.join(workers, name);
      if (existsSync(target) && !readFileSync(target).equals(bytes)) throw new Error("Conflicting worker hash");
      if (!existsSync(target)) writeFileSync(target, bytes);
    }
  }
  const worker = readFileSync(path.join(dist, "event-stream-worker.js"));
  const hash = createHash("sha256").update(worker).digest("hex").slice(0, 12);
  const workerPath = path.join(workers, `${hash}.js`);
  if (existsSync(workerPath) && !readFileSync(workerPath).equals(worker)) throw new Error("Conflicting worker hash");
  if (!existsSync(workerPath)) writeFileSync(workerPath, worker);
}

export function selectFrontend(base: string, target: string): void {
  const temporary = path.join(base, `frontend-current-${process.pid}`);
  try {
    symlinkSync(target, temporary);
    renameSync(temporary, path.join(base, "frontend-current"));
  } finally {
    rmSync(temporary, { force: true });
  }
}
