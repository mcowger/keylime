#!/usr/bin/env bun
"use strict";

// `ompweb host`: link this machine to a main omp-web so sessions can run here (lib/hosts/host-cli.ts).
//   ompweb host login --url <url>   reads the host token from stdin
//   ompweb host [--allow-http]      dials the saved server and keeps the link up (http:// is accepted without the flag for loopback)

// The daemon finds its runner from here (lib/omp/omp-cli.ts), not from whatever cwd it was started in.
import { join } from "node:path";

process.env.OMP_WEB_PACKAGE_DIR ??= join(__dirname, "..");
import("../lib/hosts/host-cli.ts").then(
  ({ runHostCli }) =>
    runHostCli(process.argv.slice(2)).then((code) => process.exit(code)),
  (error) => {
    console.error(
      `ompweb host: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
