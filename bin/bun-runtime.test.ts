import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { resolveBunBinary } = require("./bun-runtime.js");

test("resolves the running Bun independently of package directory and PATH", () => {
  assert.equal(resolveBunBinary("/missing", { PATH: "" }), process.execPath);
  const version = execFileSync(resolveBunBinary(), ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  }).trim();
  assert.equal(version, process.versions.bun);
});
