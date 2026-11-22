import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hashPassword } from "../../lib/web-password-hash";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Usage: bun --no-env-file ios/tools/native-fixture.ts [--port <port>]\nSet KEYLIME_NATIVE_FIXTURE_PASSWORD to enable fixture-only password authentication. Leave it unset for an open fixture.",
  );
  process.exit(0);
}

const password = process.env.KEYLIME_NATIVE_FIXTURE_PASSWORD;
if (password === "")
  throw new Error("KEYLIME_NATIVE_FIXTURE_PASSWORD must be non-empty or unset");

// Do not pass provider credentials, Git overrides, production configuration, or
// the plaintext fixture password to the dev launcher or either of its services.
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  ...(password === undefined
    ? {}
    : { KEYLIME_DEV_FIXTURE_PASSWORD_HASH: hashPassword(password) }),
};
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const child = spawn(
  process.execPath,
  [
    "--no-env-file",
    "scripts/dev.ts",
    "--native-fixture",
    ...(values.port === undefined ? [] : ["--port", values.port]),
  ],
  { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] },
);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => child.kill(signal));
const [exitCode] = await once(child, "exit");
process.exitCode = typeof exitCode === "number" ? exitCode : 1;
