import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostControlServer } from "./host-control";
import { STANDALONE_HOST_INSTALL } from "./standalone-service";

test("a matching checksum is not enough to replace or restart the host", async (t) => {
  if (!process.getuid?.()) return t.skip("Requires an unprivileged service user");
  const home = mkdtempSync(join(tmpdir(), "kl-preflight-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const install = join(home, STANDALONE_HOST_INSTALL);
  const agent = join(home, "agent");
  const staged = join(agent, "keylime", "host-artifacts", randomUUID());
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  mkdirSync(install, { recursive: true, mode: 0o700 });
  const daemon = join(install, "keylime");
  const previous = "#!/bin/sh\nexit 44\n";
  writeFileSync(daemon, previous, { mode: 0o700 });
  const inode = statSync(daemon).ino;
  const entered = join(home, "host-control-called");
  const control = await createHostControlServer(() => {
    writeFileSync(entered, "called");
    throw new Error("Preflight must not touch the running daemon");
  }, agent);
  try {
    const artifact = join(staged, "wrong-program");
    // A runnable binary returning zero still isn't a daemon that passed preflight.
    const bytes = "#!/bin/sh\nexit 0\n";
    writeFileSync(artifact, bytes, { mode: 0o600 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../../bin/keylime-host.ts"),
        "install-artifact",
        artifact,
        "--target",
        "keylime",
        "--sha256",
        sha256,
      ],
      {
        env: { HOME: home, PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: agent },
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 1);
    assert.match(
      stderr,
      /Preflight failed for keylime; the installed binary was not changed/,
    );
    assert.equal(readFileSync(daemon, "utf8"), previous);
    assert.equal(statSync(daemon).ino, inode);
    assert.equal(existsSync(entered), false);
    assert.ok(
      !readdirSync(install).some((name) => name.startsWith("keylime.backup-")),
    );
  } finally {
    await control.close();
  }
});