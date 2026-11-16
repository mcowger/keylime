import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseLaunchOptions } from "../bin/keylime-options";

test("opens the browser by default", () => {
  const parsed = parseLaunchOptions([], {});
  assert.equal(parsed.port, "30177");
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.openBrowser, true);
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy KEYLIME_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(
      parseLaunchOptions([], { KEYLIME_NO_OPEN: value }).openBrowser,
      false,
    );
  }
});

test("does not disable browser opening for false KEYLIME_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(
      parseLaunchOptions([], { KEYLIME_NO_OPEN: value }).openBrowser,
      true,
    );
  }
});

test("preserves port and hostname options", () => {
  const parsed = parseLaunchOptions(["-p", "8080", "-H", "0.0.0.0"], {});
  assert.equal(parsed.port, "8080");
  assert.equal(parsed.hostname, "0.0.0.0");
  assert.equal(parsed.openBrowser, true);
});

test("a port that is not an integer from 0 to 65535 is an error, from the flag or PORT", () => {
  for (const port of ["abc", "80x", "1.5", "-1", "65536", ""]) {
    assert.equal(
      parseLaunchOptions(["-p", port], {}).error,
      `Invalid port: ${port}. Use an integer from 0 to 65535.`,
      port,
    );
    assert.equal(
      parseLaunchOptions([], { PORT: port }).error,
      `Invalid port: ${port}. Use an integer from 0 to 65535.`,
      `PORT=${port}`,
    );
  }
  for (const port of ["0", "30177", "65535"])
    assert.equal(parseLaunchOptions(["-p", port], {}).error, undefined, port);
});

test("keylime with a bad port says so in one line and exits 2", () => {
  const launcher = fileURLToPath(new URL("../bin/keylime.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [launcher, "-p", "abc", "--no-open"],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(
    result.stderr.trim(),
    "Invalid port: abc. Use an integer from 0 to 65535.",
  );
  assert.equal(result.status, 2);
});

test("supports KEYLIME_HOSTNAME without trusting the ambient system HOSTNAME", () => {
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.equal(
    parseLaunchOptions([], { KEYLIME_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
});

test("accepts a password hash from KEYLIME_PASSWORD_HASH", () => {
  const hash =
    "scrypt$15$8$1$WlVEVcJQz1dJIPZ4AlRrFQ$8CFi0lDZHh1Gr6gAWOi0yBVJXxbFCL0-w5u_5zADk1E";
  assert.equal(parseLaunchOptions([], {}).passwordHash, undefined);
  assert.equal(
    parseLaunchOptions([], { KEYLIME_PASSWORD_HASH: hash }).passwordHash,
    hash,
  );
  // Values arrive through .env files and service units, where a trailing
  // newline or quote is an easy mistake; trimming keeps `keylime` starting.
  assert.equal(
    parseLaunchOptions([], { KEYLIME_PASSWORD_HASH: `  ${hash}\n` })
      .passwordHash,
    hash,
  );
});

test("flags a legacy plaintext password instead of accepting it", () => {
  assert.equal(parseLaunchOptions([], {}).legacyPassword, undefined);
  assert.deepEqual(
    (({
      legacyPassword,
      legacyPasswordSource,
    }: {
      legacyPassword?: string;
      legacyPasswordSource?: string;
    }) => ({
      legacyPassword,
      legacyPasswordSource,
    }))(parseLaunchOptions([], { KEYLIME_PASSWORD: "secret" })),
    { legacyPassword: "secret", legacyPasswordSource: "env" },
  );
  assert.deepEqual(
    (({
      legacyPassword,
      legacyPasswordSource,
    }: {
      legacyPassword?: string;
      legacyPasswordSource?: string;
    }) => ({
      legacyPassword,
      legacyPasswordSource,
    }))(
      parseLaunchOptions(["--password", "from-cli"], {
        KEYLIME_PASSWORD: "from-env",
      }),
    ),
    { legacyPassword: "from-cli", legacyPasswordSource: "flag" },
  );
  assert.deepEqual(
    (({
      legacyPassword,
      legacyPasswordSource,
    }: {
      legacyPassword?: string;
      legacyPasswordSource?: string;
    }) => ({
      legacyPassword,
      legacyPasswordSource,
    }))(parseLaunchOptions(["--password=inline"], {})),
    { legacyPassword: "inline", legacyPasswordSource: "flag" },
  );
  // An empty value is not a configured password.
  assert.equal(
    parseLaunchOptions([], { KEYLIME_PASSWORD: "" }).legacyPassword,
    undefined,
  );
});

test("--password is no longer a declared option", () => {
  // The parser must not swallow a following argument as the password value.
  const parsed = parseLaunchOptions(["--password", "secret"], {});
  assert.equal(parsed.passwordHash, undefined);
  assert.equal(parsed.port, "30177");
});
