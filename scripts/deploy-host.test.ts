import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("deploys with a dash-leading host token passed using equals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keylime-deploy-host-"));
  const bin = join(dir, "bin");
  const release = join(dir, "release");
  const capture = join(dir, "token");
  const argsLog = join(dir, "ssh-args");
  const token = `-${"A".repeat(42)}`;
  mkdirSync(bin);
  mkdirSync(join(release, "licenses"), { recursive: true });
  for (const name of [
    "keylime",
    "keylime-omp",
    "LICENSE",
    "native-video-LICENSE.txt",
  ]) {
    writeFileSync(join(release, name), "fixture", { mode: 0o755 });
  }
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh
printf '%s\n' "$@" >> "$SSH_ARGS"
case "$*" in
  *'uname -s'*) printf 'Linux x86_64\n' ;;
  *'host login --url'*) cat > "$SSH_TOKEN" ;;
  *'tar -xf'*) cat > /dev/null ;;
esac
`,
    { mode: 0o755 },
  );
  let output = "";
  let urlAnswered = false;
  let autostartAnswered = false;
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "deploy-host.ts"),
      "host",
      "--release",
      release,
      `--host-token=${token}`,
    ],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SSH_ARGS: argsLog,
        SSH_TOKEN: capture,
      },
      terminal: {
        cols: 120,
        rows: 24,
        data: (terminal, bytes) => {
          output += new TextDecoder().decode(bytes);
          if (!urlAnswered && output.includes("FE HTTPS URL:")) {
            urlAnswered = true;
            terminal.write("https://keylime.example.com\n");
          }
          if (!autostartAnswered && output.includes("[y/N]")) {
            autostartAnswered = true;
            terminal.write("y\n");
          }
        },
      },
    },
  );
  try {
    expect(await child.exited).toBe(0);
    expect(readFileSync(capture, "utf8")).toBe(`${token}\n`);
    expect(readFileSync(argsLog, "utf8")).not.toContain(token);
    expect(output).not.toContain("Host token (input hidden)");
  } finally {
    child.kill();
    child.terminal?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
