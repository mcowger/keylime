import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hashPassword } from "../../lib/web-password-hash";
import { startOfflineModel } from "./offline-model";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string" },
    "offline-model": { type: "boolean" },
    "failed-bash": { type: "boolean" },
    "stream-delay-ms": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Usage: bun --no-env-file ios/tools/native-fixture.ts [--port <port>] [--offline-model [--stream-delay-ms <ms>] [--failed-bash]]\n" +
      "Build the real runner first: mise exec -- bun runner/scripts/build-binary.ts\n" +
      "--offline-model enables keylime-fixture/offline on loopback, with a deterministic slowly streamed response. Select it in a new chat and use Stop to abort. Default delay: 350 ms per fragment.\n" +
      "--failed-bash makes each turn run a harmless six-second Bash command that prints twice and exits 1 before the response. Requires --offline-model and the runner's bash tool.\n" +
      "Set KEYLIME_NATIVE_FIXTURE_PASSWORD to enable fixture-only password authentication. Leave it unset for an open fixture.",
  );
  process.exit(0);
}

const password = process.env.KEYLIME_NATIVE_FIXTURE_PASSWORD;
if (password === "")
  throw new Error("KEYLIME_NATIVE_FIXTURE_PASSWORD must be non-empty or unset");
if (values["stream-delay-ms"] !== undefined && !values["offline-model"])
  throw new Error("--stream-delay-ms requires --offline-model");
if (values["failed-bash"] && !values["offline-model"])
  throw new Error("--failed-bash requires --offline-model");
const delayMs =
  values["stream-delay-ms"] === undefined
    ? 350
    : Number(values["stream-delay-ms"]);
if (!Number.isInteger(delayMs) || delayMs < 25 || delayMs > 2000)
  throw new Error("--stream-delay-ms must be an integer from 25 to 2000");
const offlineModel = values["offline-model"]
  ? startOfflineModel(delayMs, values["failed-bash"])
  : undefined;
if (offlineModel)
  console.log(
    `[offline-model] keylime-fixture/offline at http://127.0.0.1:${offlineModel.port}/v1; ${delayMs} ms per fragment`,
  );

// Do not pass provider credentials, Git overrides, production configuration, or
// the plaintext fixture password to the dev launcher or either of its services.
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  ...(password === undefined
    ? {}
    : { KEYLIME_DEV_FIXTURE_PASSWORD_HASH: hashPassword(password) }),
  ...(offlineModel
    ? {
        KEYLIME_DEV_NATIVE_MODEL_URL: `http://127.0.0.1:${offlineModel.port}/v1`,
      }
    : {}),
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
try {
  const [exitCode] = await once(child, "exit");
  process.exitCode = typeof exitCode === "number" ? exitCode : 1;
} finally {
  offlineModel?.stop(true);
}
