import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { readDeployState } from "./deploy-state";
import { detachDeployWorker } from "./deploy-detach";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    activate: { type: "string" },
    frontend: { type: "boolean" },
    wait: { type: "boolean" },
    status: { type: "boolean" },
    recover: { type: "boolean" },
    timeout: { type: "string" },
    help: { type: "boolean" },
  },
});
const base = path.join(homedir(), ".local/share/keylime");
if (values.help) {
  console.log(
    "keylime-deploy [--frontend] [--activate <release>] [--timeout <seconds>] [--wait]\n  Submit an independent deployment; --frontend builds and switches compatible frontend assets without restarting services.\n  Full deployments give active work 60 seconds by default before forced cutover.\nkeylime-deploy --status\n  Show durable phase/result and log path.\nkeylime-deploy --recover\n  Restart services at the currently selected release after an interrupted worker.\n--wait observes completion but disconnecting never cancels deployment.",
  );
  process.exit(0);
}
if (
  values.timeout !== undefined &&
  (!/^\d+$/.test(values.timeout) ||
    !Number.isSafeInteger(Number(values.timeout) * 1000) ||
    Number(values.timeout) <= 0)
)
  throw new Error("--timeout must be a positive whole number of seconds");
if (values.frontend && (values.activate || values.recover || values.timeout !== undefined))
  throw new Error("--frontend cannot be combined with --activate, --recover, or --timeout");
mkdirSync(base, { recursive: true, mode: 0o700 });
if (values.status) {
  console.log(JSON.stringify(readDeployState(base), null, 2));
  process.exit(0);
}
const id = crypto.randomUUID();
const workerDir = path.join(base, "workers", id);
mkdirSync(workerDir, { recursive: true, mode: 0o700 });
const script = path.join(workerDir, "worker.js");
// Snapshot the complete module graph before handoff: edits or a checkout change cannot alter activation.
await Bun.build({
  entrypoints: [path.join(import.meta.dir, "deploy-worker.ts")],
  target: "bun",
  outdir: workerDir,
  naming: "worker.js",
  throw: true,
});
const logPath = path.join(base, `deploy-${id}.log`);
const child = detachDeployWorker(
  [
    process.execPath,
    "--no-env-file",
    script,
    "--id",
    id,
    "--root",
    path.resolve(import.meta.dir, ".."),
    ...(values.activate ? ["--activate", path.resolve(values.activate)] : []),
    ...(values.recover ? ["--recover"] : []),
    ...(values.frontend ? ["--frontend"] : []),
    ...(values.timeout !== undefined ? ["--timeout", values.timeout] : []),
  ],
  logPath,
  homedir(),
);
// Submission acknowledgement comes from the worker only after it owns the exclusive lock.
const acknowledgementDeadline = performance.now() + 15_000;
let accepted = false;
while (performance.now() < acknowledgementDeadline) {
  const state = readDeployState(base);
  if (state?.id === id) {
    accepted = true;
    console.log(
      `Deployment ${id}: ${state.phase}\nLog: ${logPath}\nStatus: keylime-deploy --status`,
    );
    break;
  }
  if (child.exitCode !== null)
    throw new Error(`Deployment not accepted; inspect ${logPath}`);
  await Bun.sleep(50);
}
if (!accepted)
  throw new Error(
    `Worker did not acknowledge submission; inspect ${logPath} and --status before retrying`,
  );
if (values.wait) {
  for (;;) {
    const state = readDeployState(base);
    if (!state || state.id !== id)
      throw new Error("Deployment status was replaced");
    if (["complete", "failed", "recovered"].includes(state.phase)) {
      console.log(JSON.stringify(state, null, 2));
      process.exitCode = state.phase === "failed" ? 1 : 0;
      break;
    }
    await Bun.sleep(500);
  }
}
