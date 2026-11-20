import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
  if (!process.getuid?.())
    return t.skip("Requires an unprivileged service user");
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

for (const outcome of [
  "restarted",
  "runner appeared",
  "restart failed",
] as const) {
  test(`paired activation with a missing runner: ${outcome}`, async (t) => {
    if (!process.getuid?.())
      return t.skip("Requires an unprivileged service user");
    const home = mkdtempSync(
      join(realpathSync(tmpdir()), "kl-missing-runner-"),
    );
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const install = join(home, STANDALONE_HOST_INSTALL);
    const agent = join(home, "agent");
    const daemon = join(install, "keylime");
    const runner = join(install, "keylime-omp");
    const supervisorDir = join(home, "bin");
    mkdirSync(install, { recursive: true, mode: 0o700 });
    mkdirSync(supervisorDir, { mode: 0o700 });

    const previous = "#!/bin/sh\nexit 44\n";
    const replacement = `#!/bin/sh
[ "$1" = preflight ] && [ "$("$KEYLIME_OMP_BIN")" = runner ] || exit 1
printf 'preflight ok: matched pair\n'`;
    const replacementRunner = "#!/bin/sh\necho runner\n";
    writeFileSync(daemon, previous, { mode: 0o700 });
    const oldInode = statSync(daemon).ino;
    const stage = (name: string, bytes: string) => {
      const dir = join(agent, "keylime", "host-artifacts", randomUUID());
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stagedPath = join(dir, name);
      writeFileSync(stagedPath, bytes, { mode: 0o600 });
      return {
        stagedPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };

    const pidFile = join(home, "supervised-pid");
    const restartLog = join(home, "restart-log");
    writeFileSync(pidFile, "100\n");
    const supervisor = `#!/bin/sh
case "$*" in
  "--user show "*) cat "$HOME/supervised-pid" ;;
  "print "*) printf 'pid = %s\n' "$(cat "$HOME/supervised-pid")" ;;
  "--user restart "*|"kickstart -k "*)
    echo restart >> "$HOME/restart-log"
    ${outcome === "restart failed" ? "exit 1" : 'printf "101\\n" > "$HOME/supervised-pid"'} ;;
  *) exit 99 ;;
esac`;
    for (const name of ["systemctl", "launchctl"])
      writeFileSync(join(supervisorDir, name), supervisor, { mode: 0o700 });

    let drained = false;
    const control = await createHostControlServer((command) => {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (command === "drain") {
        drained = true;
        if (outcome === "runner appeared")
          writeFileSync(runner, "operator's runner", { mode: 0o700 });
      } else if (command === "resume") {
        drained = false;
      }
      return {
        pid,
        version: "test",
        protocol: 14,
        linked: true,
        drained: pid === 100 && drained,
        executable: daemon,
        entrypoint: daemon,
      };
    }, agent);

    try {
      const input = {
        ...stage("keylime", replacement),
        target: "keylime",
        runner: stage("keylime-omp", replacementRunner),
        agentDir: agent,
      };
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `import { installArtifact } from ${JSON.stringify(join(import.meta.dir, "install-artifact.ts"))}; await installArtifact(${JSON.stringify(input)});`,
        ],
        {
          env: {
            HOME: home,
            PATH: `${supervisorDir}:/usr/bin:/bin`,
            PI_CODING_AGENT_DIR: agent,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      const names = readdirSync(install);
      const backup = names.find((name) => name.startsWith("keylime.backup-"));
      assert.ok(backup, stderr);
      assert.equal(readFileSync(join(install, backup), "utf8"), previous);
      assert.ok(!names.some((name) => name.startsWith("keylime-omp.backup-")));

      if (outcome === "runner appeared") {
        assert.notEqual(code, 0);
        assert.match(
          stderr,
          /Could not install keylime-omp; keylime was restored/,
        );
        assert.equal(statSync(daemon).ino, oldInode);
        assert.equal(readFileSync(runner, "utf8"), "operator's runner");
        assert.equal(existsSync(restartLog), false);
        assert.equal(drained, false);
      } else {
        assert.equal(readFileSync(daemon, "utf8"), replacement);
        assert.equal(readFileSync(runner, "utf8"), replacementRunner);
        assert.equal(statSync(runner).mode & 0o777, 0o700);
        assert.equal(readFileSync(restartLog, "utf8"), "restart\n");
        if (outcome === "restarted") {
          assert.equal(code, 0, stderr);
          assert.match(stdout, /Host service restarted \(PID 101\)/);
        } else {
          assert.notEqual(code, 0);
          assert.match(stderr, /no automatic rollback/);
          assert.match(stderr, /remove the newly installed runner/);
        }
      }
    } finally {
      await control.close();
    }
  });
}
