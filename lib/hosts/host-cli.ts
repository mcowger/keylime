import { createHostControlServer, requestHostControl } from "./host-control";
import type { HostDaemon } from "./daemon";
import { runInstallArtifact } from "./install-artifact";
import { ACTIVATION_WORKER, runManagedArtifactWorker } from "./managed-artifact-activation";

// `keylime host`: link this machine to web servers through ./daemon.
// Loaded by Bun's native TypeScript runtime and the compiled binary: no `@/` imports.
// Tokens are read from stdin, never from argv.
import {
  addHostLink,
  loginHost,
  readHostLinks,
  removeHostLink,
} from "./host-login";

const USAGE =
  "Usage: keylime host login [--add] --url <server url>   (the host token is read from stdin)\n       keylime host logout --url <server url>\n       keylime host [--allow-http]\n       keylime host status|drain|drain-idle|drain-force|resume\n       keylime host install-artifact --help";

/** A host token is 43 characters; anything this long is not one. */
const MAX_TOKEN_LINE_BYTES = 4096;

/** The first line on stdin: the token never appears in argv, where `ps` would show it. */
function readTokenLine(): Promise<string> {
  if (process.stdin.isTTY)
    process.stderr.write("Paste the host token, then press Enter: ");
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    data += chunk;
    const newline = data.indexOf("\n");
    const line = newline === -1 ? data : data.slice(0, newline);
    if (Buffer.byteLength(line) > MAX_TOKEN_LINE_BYTES) {
      process.stdin.pause();
      reject(
        new Error(
          `the host token line is longer than ${MAX_TOKEN_LINE_BYTES} bytes`,
        ),
      );
    } else if (newline !== -1) {
      process.stdin.pause();
      resolve(line);
    }
  });
  process.stdin.on("end", () => resolve(data));
  return promise;
}

async function main(argv: string[], signal?: AbortSignal): Promise<number> {
  if (argv[0] === "install-artifact") return runInstallArtifact(argv.slice(1));
  if (argv[0] === ACTIVATION_WORKER) return runManagedArtifactWorker(argv.slice(1));
  if (argv[0] === "login" || argv[0] === "logout") {
    const add = argv[0] === "login" && argv.includes("--add");
    const args = add ? argv.filter((arg) => arg !== "--add") : argv;
    if (
      args.length !== 3 ||
      args[1] !== "--url" ||
      !args[2] ||
      args[2].startsWith("--") ||
      argv.length !== (add ? 4 : 3)
    ) {
      console.error(USAGE);
      return 2;
    }
    const url = args[2];
    if (argv[0] === "logout") {
      await removeHostLink(url);
      console.log(`Removed the link to ${url}.`);
    } else {
      const link = { url, token: (await readTokenLine()).trim() };
      if (add) await addHostLink(link);
      else await loginHost(link);
      console.log(`Saved. Run \`keylime host\` to link this machine to ${url}.`);
    }
    return 0;
  }
  if (
    argv.length === 1 &&
    (argv[0] === "status" ||
      argv[0] === "drain" ||
      argv[0] === "drain-idle" ||
      argv[0] === "drain-force" ||
      argv[0] === "resume")
  ) {
    // Local controls never load or start a second daemon.
    console.log(JSON.stringify(await requestHostControl(argv[0])));
    return 0;
  }

  if (argv.some((arg) => arg !== "--allow-http")) {
    console.error(USAGE);
    return 2;
  }
  if (readHostLinks().length === 0) {
    console.error(
      "This machine is not linked yet. Start keylime on this machine (it writes the link), or run `keylime host login --url <server url>`.",
    );
    return 1;
  }
  // Login/logout need none of the daemon, which Bun would otherwise transpile on every run.
  const [{ runHostDaemon }, { hostSocketPath }, { ensureOmpRunner }] =
    await Promise.all([
      import("./daemon"),
      import("./omp-socket"),
      import("../omp/runner-fetch"),
    ]);
  if (signal?.aborted) return 0;
  // Sessions need the runner; until it is here they fail with OMP_NOT_FOUND and the next start retries.
  void ensureOmpRunner().catch((error: unknown) =>
    console.error(
      `keylime host: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  let daemon: HostDaemon | undefined;
  const endpoint = await createHostControlServer((command) => {
    if (!daemon) throw new Error("The host daemon is starting");
    return daemon.control(command);
  });
  try {
    if (signal?.aborted) return 0;
    daemon = runHostDaemon({
      allowHttp: argv.includes("--allow-http"),
      hostSocket: hostSocketPath(),
      standaloneControl: !!endpoint && !signal,
    });
    // Worker cutover starts fail-closed; ordinary hosts have no maintenance environment.
    if (process.env.KEYLIME_HOST_DRAINED === "1") daemon.control("drain");
    const stop = () => void daemon!.stop();
    if (signal) signal.addEventListener("abort", stop, { once: true });
    else
      for (const name of ["SIGINT", "SIGTERM"] as const)
        process.once(name, stop);
    try {
      return await daemon.done;
    } finally {
      if (signal) signal.removeEventListener("abort", stop);
      else
        for (const name of ["SIGINT", "SIGTERM"] as const)
          process.removeListener(name, stop);
    }
  } finally {
    await daemon?.stop();
    await endpoint?.close();
  }
}

/** `keylime host <argv>`: errors are printed and return 1. A supplied signal owns shutdown instead of process listeners. */
export function runHostCli(
  argv: string[],
  signal?: AbortSignal,
): Promise<number> {
  return main(argv, signal).catch((error: unknown) => {
    console.error(
      `keylime host: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  });
}
