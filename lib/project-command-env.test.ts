import assert from "node:assert/strict";
import test from "node:test";

const {
  createChildProcessEnvironment,
  isHostRuntimeVariable,
  isKeylimeSecretVariable,
  sanitizeProjectCommandEnvironment,
  KEYLIME_SECRET_ENV_VARS,
} = await import("./project-command-env.ts");

test("strips the host runtime variables", () => {
  assert.equal(isHostRuntimeVariable("PORT"), true);
  assert.equal(isHostRuntimeVariable("port"), false);
  assert.equal(isHostRuntimeVariable("NODE_ENV"), true);
  // A user's own NEXT_* settings are meant for the project's tools, not the keylime server.
  assert.equal(isHostRuntimeVariable("NEXT_PUBLIC_FOO"), false);
  assert.equal(isHostRuntimeVariable("PATH"), false);
  assert.equal(isHostRuntimeVariable("NEXTTLS"), false);

  const env = sanitizeProjectCommandEnvironment({
    PATH: "/usr/bin",
    PORT: "30178",
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    PROJECT: "keep-me",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    NEXT_TELEMETRY_DISABLED: "1",
    PROJECT: "keep-me",
  });
});

test("strips keylime's own secrets from a child environment", () => {
  // The whole point of issue #239: an agent running `env` inside a session
  // must not be able to print anything that grants access to this server.
  for (const name of KEYLIME_SECRET_ENV_VARS) {
    assert.equal(isKeylimeSecretVariable(name), true, name);
  }
  // Configuration, not a secret: the launcher and update plumbing rely on it.
  for (const name of [
    "KEYLIME_OMP_BIN",
    "KEYLIME_PORT",
    "KEYLIME_HOSTNAME",
    "KEYLIME_PACKAGE_DIR",
    "KEYLIME_LAUNCHER_PID",
    "KEYLIME_NAME",
  ]) {
    assert.equal(isKeylimeSecretVariable(name), false, name);
  }

  const env = sanitizeProjectCommandEnvironment({
    PATH: "/usr/bin",
    KEYLIME_PASSWORD: "hunter2",
    KEYLIME_PASSWORD_HASH: "scrypt$15$8$1$aaaa$bbbb",
    KEYLIME_TRUSTED_HEADER_SECRET: "proxy-secret",
    KEYLIME_TRUSTED_HEADER_SHA256: "a".repeat(64),
    KEYLIME_OMP_BIN: "/usr/local/bin/omp",
    KEYLIME_PORT: "30177",
    HOME: "/home/u",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    KEYLIME_OMP_BIN: "/usr/local/bin/omp",
    KEYLIME_PORT: "30177",
    HOME: "/home/u",
  });
});

test("builds a fresh environment that never mutates the parent", () => {
  const base = {
    PATH: "/usr/bin",
    KEYLIME_PASSWORD_HASH: "scrypt$hash",
    KEYLIME_PORT: "30177",
  };
  const env = createChildProcessEnvironment(
    { FORCE_COLOR: "0", LC_ALL: "C" },
    base,
  );
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    KEYLIME_PORT: "30177",
    FORCE_COLOR: "0",
    LC_ALL: "C",
  });
  // The parent object is untouched, and the child cannot re-add a secret
  // through the additions either.
  assert.deepEqual(base, {
    PATH: "/usr/bin",
    KEYLIME_PASSWORD_HASH: "scrypt$hash",
    KEYLIME_PORT: "30177",
  });
  const readded = createChildProcessEnvironment(
    { KEYLIME_PASSWORD_HASH: "scrypt$again" },
    base,
  );
  assert.equal(readded.KEYLIME_PASSWORD_HASH, undefined);
});

test("defaults to the current process environment and platform", () => {
  const previous = process.env.KEYLIME_PASSWORD_HASH;
  const previousPort = process.env.KEYLIME_PORT;
  process.env.KEYLIME_PASSWORD_HASH = "scrypt$live";
  process.env.KEYLIME_PORT = "30178";
  try {
    const env = createChildProcessEnvironment({ MARKER: "1" });
    assert.equal(env.MARKER, "1");
    assert.equal(env.KEYLIME_PASSWORD_HASH, undefined);
    assert.equal(env.KEYLIME_PORT, "30178");
  } finally {
    if (previous === undefined) delete process.env.KEYLIME_PASSWORD_HASH;
    else process.env.KEYLIME_PASSWORD_HASH = previous;
    if (previousPort === undefined) delete process.env.KEYLIME_PORT;
    else process.env.KEYLIME_PORT = previousPort;
  }
});
