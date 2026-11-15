import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { hashPassword, verifyPassword } from "./omp-web-password-hash";
const binDir = fileURLToPath(new URL(".", import.meta.url));

/** Run the launcher against a stub `server/main.ts` that records the environment it was started with. */
async function launch(env: NodeJS.ProcessEnv, args: string[] = []) {
  const pkg = await mkdtemp(join(tmpdir(), "ompweb-launch-"));
  try {
    await mkdir(join(pkg, "bin"));
    for (const name of await readdir(binDir)) {
      if (
        name.endsWith(".js") ||
        (name.endsWith(".ts") && !name.endsWith(".test.ts"))
      )
        await copyFile(join(binDir, name), join(pkg, "bin", name));
    }
    await mkdir(join(pkg, "dist"));
    await writeFile(join(pkg, "dist", "index.html"), "<!doctype html>");
    await mkdir(join(pkg, "server"));
    const dump = join(pkg, "server-env.json");
    await writeFile(
      join(pkg, "server", "main.ts"),
      `require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));`,
    );
    const result = spawnSync(
      process.execPath,
      [join(pkg, "bin", "omp-web.js"), "--no-open", "-p", "0", ...args],
      {
        env: {
          ...process.env,
          HOME: pkg,
          OMP_WEB_PASSWORD: undefined,
          OMP_WEB_PASSWORD_HASH: undefined,
          ...env,
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    const serverEnv: NodeJS.ProcessEnv | null = await readFile(
      dump,
      "utf8",
    ).then(JSON.parse, () => null);
    return { status: result.status, stderr: result.stderr, serverEnv };
  } finally {
    await rm(pkg, { recursive: true, force: true });
  }
}

test("launcher permits unauthenticated non-loopback binds", async () => {
  const { status, serverEnv } = await launch({}, ["-H", "0.0.0.0"]);
  assert.equal(status, 0);
  assert.ok(serverEnv);
  assert.equal(serverEnv.OMP_WEB_HOSTNAME, "0.0.0.0");
  assert.equal(serverEnv.OMP_WEB_PASSWORD_HASH, undefined);
});

test("launcher hands the server a hash of a plaintext OMP_WEB_PASSWORD, never the plaintext", async () => {
  const { stderr, serverEnv } = await launch({ OMP_WEB_PASSWORD: "s3cret pw" });
  assert.ok(serverEnv, stderr);
  assert.equal(serverEnv.OMP_WEB_PASSWORD, undefined);
  const hash = serverEnv.OMP_WEB_PASSWORD_HASH;
  assert.ok(hash);
  assert.equal(verifyPassword("s3cret pw", hash), true);
  assert.ok(stderr.includes(`OMP_WEB_PASSWORD_HASH='${hash}'`), stderr);
  assert.ok(!stderr.includes("s3cret pw"), stderr);
});

test("launcher refuses a plaintext OMP_WEB_PASSWORD next to a hash", async () => {
  const { status, serverEnv } = await launch({
    OMP_WEB_PASSWORD: "s3cret pw",
    OMP_WEB_PASSWORD_HASH: hashPassword("other"),
  });
  assert.equal(status, 1);
  assert.equal(serverEnv, null);
});
