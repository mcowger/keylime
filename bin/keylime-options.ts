import { parseArgs } from "node:util";
import { hashPassword, isPasswordHash } from "./keylime-password-hash";
import { isLoopbackHost } from "./network-addresses";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export interface LaunchOptions {
  port: string;
  hostname: string;
  passwordHash?: string;
  legacyPassword?: string;
  legacyPasswordSource?: "env" | "flag";
  openBrowser: boolean;
  help?: boolean;
  version?: boolean;
  error?: string;
}

function isEnabled(value: unknown) {
  return (
    typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase())
  );
}

/** Legacy plaintext credential: detected so `keylime` can migrate (env) or refuse (flag) it. */
function legacyPassword(
  args: string[],
  env: NodeJS.ProcessEnv,
): { value: string; source: "flag" | "env" } | undefined {
  const flagIndex = args.findIndex(
    (arg) => arg === "--password" || arg.startsWith("--password="),
  );
  if (flagIndex !== -1) {
    const arg = args[flagIndex];
    const inline = arg.startsWith("--password=")
      ? arg.slice("--password=".length)
      : undefined;
    const value = inline !== undefined ? inline : (args[flagIndex + 1] ?? "");
    return { value, source: "flag" };
  }
  const fromEnv = env.KEYLIME_PASSWORD;
  if (typeof fromEnv === "string" && fromEnv.length > 0)
    return { value: fromEnv, source: "env" };
  return undefined;
}

export function printHelp() {
  console.log(`Usage: keylime [options]

Options:
  -p, --port <port>        Server port (default 30177, env PORT)
  -H, --hostname <host>    Bind hostname (default 127.0.0.1, env KEYLIME_HOSTNAME)
      --no-open            Do not open the browser automatically
  -h, --help               Show this help
      --version            Show version

Commands:
  hash-password            Read a password from stdin and print the value for
                           KEYLIME_PASSWORD_HASH

Password:
  keylime hash-password                       # prompts, input hidden
  echo "a-long-random-password" | keylime hash-password
  KEYLIME_PASSWORD_HASH='scrypt$15$8$1$...' keylime

  keylime never passes a plaintext password on: --password is rejected, and an
  KEYLIME_PASSWORD is hashed at startup with a warning that prints its hash
  (set alongside KEYLIME_PASSWORD_HASH, it is rejected), because every omp
  session inherits the environment and an agent could print the password
  into its transcript.

Security: use HTTPS via a trusted reverse proxy or VPN when binding to a
non-loopback hostname, so the password and session cookie stay private.`);
}

/**
 * Resolve launch options from argv and the environment. A legacy plaintext
 * password (env or `--password`) is reported instead of parsed: the caller
 * migrates or refuses it rather than passing it to the server. A bad port is
 * reported in `error`, which the caller prints before exiting with 2.
 * @returns {{ port: string, hostname: string, passwordHash?: string, legacyPassword?: string, legacyPasswordSource?: "env" | "flag", openBrowser: boolean, help?: boolean, version?: boolean, error?: string }}
 */
export function parseLaunchOptions(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): LaunchOptions {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port: { type: "string", short: "p" },
      hostname: { type: "string", short: "H" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      "no-open": { type: "boolean" },
    },
    strict: false,
  });

  const passwordHash =
    typeof env.KEYLIME_PASSWORD_HASH === "string"
      ? env.KEYLIME_PASSWORD_HASH.trim()
      : undefined;
  const legacy = legacyPassword(args, env);

  const port = String(cliArgs.port ?? env.PORT ?? "30177");
  const shared = {
    port,
    hostname:
      (cliArgs.hostname as string | undefined) ??
      env.KEYLIME_HOSTNAME ??
      "127.0.0.1",
    passwordHash,
    legacyPassword: legacy?.value,
    legacyPasswordSource: legacy?.source,
    openBrowser: !cliArgs["no-open"] && !isEnabled(env.KEYLIME_NO_OPEN),
    ...(/^\d{1,5}$/.test(port) && Number(port) <= 65535
      ? {}
      : { error: `Invalid port: ${port}. Use an integer from 0 to 65535.` }),
  };

  if (cliArgs.version) {
    try {
      const pkg = require("../package.json");
      console.log(pkg.version ?? "0.0.0");
    } catch {
      console.log("0.0.0");
    }
    return { ...shared, version: true };
  }
  // Expose help flag without exiting here — caller (bin/keylime.ts) decides
  // whether to exit, keeping parseLaunchOptions testable. Print here so
  // --help works even when the caller is a test.
  if (cliArgs.help) {
    printHelp();
    return { ...shared, help: true };
  }
  return shared;
}

/**
 * Password validation before a server starts (bin/keylime.ts, server/binary.ts). Only a password hash reaches
 * the server: a plaintext KEYLIME_PASSWORD alone is hashed into KEYLIME_PASSWORD_HASH and removed from process.env.
 * The removed --password flag, a plaintext set next to a hash, or an invalid hash print why and exit 1.
 * Authentication is optional on every bind address.
 * @returns {string | undefined} the password hash, if any
 */
export function checkLaunchSecurity(launchOptions: LaunchOptions) {
  let passwordHash = launchOptions.passwordHash;
  if (launchOptions.legacyPasswordSource === "env" && !passwordHash) {
    passwordHash = hashPassword(process.env.KEYLIME_PASSWORD!);
    process.env.KEYLIME_PASSWORD_HASH = passwordHash;
    delete process.env.KEYLIME_PASSWORD;
    console.warn(
      [
        "Warning: KEYLIME_PASSWORD holds a plaintext password. This option has been deprecated and is marked for removal.",
        "",
        "Every omp session inherits key lime's environment, so an agent could print",
        "the password into its transcript. key lime hashed it and kept it out of the",
        "server's environment, but agents can still read it from this launcher",
        "process, and a new hash is made on every start, which signs every browser",
        "out on each restart.",
        "",
        "Remove KEYLIME_PASSWORD and set this instead:",
        "",
        `  KEYLIME_PASSWORD_HASH='${passwordHash}'`,
      ].join("\n"),
    );
  } else if (launchOptions.legacyPasswordSource === "env") {
    console.error(
      "KEYLIME_PASSWORD_HASH and the plaintext KEYLIME_PASSWORD are both set. Remove KEYLIME_PASSWORD.",
    );
    process.exit(1);
  } else if (launchOptions.legacyPassword !== undefined) {
    console.error(
      [
        "keylime no longer accepts a plaintext password: the --password flag was removed.",
        "Every omp session inherits this process's environment, so an agent could",
        "print the password into its transcript.",
        "",
        "Create a hash and use that instead:",
        "",
        "  keylime hash-password",
        "  KEYLIME_PASSWORD_HASH='scrypt$...' keylime",
      ].join("\n"),
    );
    process.exit(1);
  }
  if (passwordHash !== undefined && !isPasswordHash(passwordHash)) {
    console.error(
      `KEYLIME_PASSWORD_HASH is not a valid password hash.\n\nGenerate one with: keylime hash-password`,
    );
    process.exit(1);
  }
  const { hostname } = launchOptions;
  if (!isLoopbackHost(hostname)) {
    console.warn(
      passwordHash === undefined
        ? `Warning: keylime is listening on ${hostname} without authentication. Anyone who can reach it can access its agent and file capabilities.`
        : `Warning: keylime is listening on ${hostname} over HTTP. Use HTTPS or a trusted VPN to protect the password and session cookie in transit.`,
    );
  }
  return passwordHash;
}
