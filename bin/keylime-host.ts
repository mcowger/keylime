#!/usr/bin/env bun
"use strict";

// `keylime host`: link this machine to a main keylime so sessions can run here (lib/hosts/host-cli.ts).
//   keylime host login --url <url>   reads the host token from stdin
//   keylime host [--allow-http]      dials the saved server and keeps the link up (http:// is accepted without the flag for loopback)

// The daemon finds its runner from here (lib/omp/omp-cli.ts), not from whatever cwd it was started in.
import { join } from "node:path";

process.env.KEYLIME_PACKAGE_DIR ??= join(__dirname, "..");
// Load the CLI only after setting its package root; hot replacements also wait for the old CLI to release its endpoint.
type HostLifecycle = {
  generation: number;
  pending: Promise<void>;
  active?: AbortController;
  stopping: boolean;
};

declare global {
  var __keylimeHostLifecycle: HostLifecycle | undefined;
}

function failed(error: unknown): never {
  console.error(
    `keylime host: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.some((arg) => arg !== "--allow-http")) {
  // One-shot commands don't own a daemon or participate in hot replacement.
  import("../lib/hosts/host-cli.ts").then(
    ({ runHostCli }) => runHostCli(argv).then((code) => process.exit(code)),
    failed,
  );
} else {
  // Bun --hot preserves this owner while re-evaluating the implementation.
  const lifecycle: HostLifecycle = (globalThis.__keylimeHostLifecycle ??= {
    generation: 0,
    pending: Promise.resolve(),
    stopping: false,
  });
  if (lifecycle.generation === 0) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.on(signal, () => {
        if (lifecycle.stopping) return;
        lifecycle.stopping = true;
        lifecycle.generation++;
        lifecycle.active?.abort();
        void lifecycle.pending.then(() => process.exit(0), failed);
      });
  }
  const generation = ++lifecycle.generation;
  lifecycle.active?.abort();
  lifecycle.pending = lifecycle.pending.then(async () => {
    // A newer save supersedes starts still waiting for the previous cleanup.
    if (lifecycle.stopping || generation !== lifecycle.generation) return;
    const active = new AbortController();
    lifecycle.active = active;
    const { runHostCli } = await import("../lib/hosts/host-cli.ts");
    if (active.signal.aborted) return;
    const code = await runHostCli(argv, active.signal);
    // Only replacement/shutdown may settle an invocation without exiting.
    if (code !== 0 || !active.signal.aborted) process.exit(code);
  });
  void lifecycle.pending.catch(failed);
}
