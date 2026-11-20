import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { promptPassword } from "../bin/keylime-hash-password";
import {
  STANDALONE_HOST_INSTALL as INSTALL,
  STANDALONE_HOST_LAUNCH_AGENT as MAC_LABEL,
  STANDALONE_HOST_UNIT as LINUX_SERVICE,
} from "../lib/hosts/standalone-service";

const USAGE =
  "Usage: bun run deploy:host <[user@]ssh-host> [--release <directory>]";
const BIN = `"$HOME/${INSTALL}/keylime"`;
const FILES = [
  "keylime",
  "keylime-omp",
  "LICENSE",
  "native-video-LICENSE.txt",
  "licenses",
];
const shellQuote = (arg: string) => `'${arg.replaceAll("'", `'"'"'`)}'`;

const SYSTEMD = `
set -eu
umask 077
unit="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${LINUX_SERVICE}"
mkdir -p "$(dirname "$unit")"
(set -C; cat > "$unit") <<'UNIT'
[Unit]
Description=Keylime host daemon

[Service]
ExecStart="%h/${INSTALL}/keylime" host
WorkingDirectory=%h
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
UNIT
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if ! loginctl --no-ask-password enable-linger "$(id -un)"; then
  printf '%s\n' 'Linger was not enabled. Ask an administrator to run loginctl enable-linger for this user so the daemon survives logout and starts at boot.' >&2
fi
systemctl --user daemon-reload
systemctl --user enable --now ${LINUX_SERVICE}
printf '%s\n' 'Logs: journalctl --user -u ${LINUX_SERVICE}'
`;

const LAUNCHD = `
set -eu
umask 077
plist="$HOME/Library/LaunchAgents/${MAC_LABEL}.plist"
log="$HOME/Library/Logs/keylime-host.log"
mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
xml_escape() { printf '%s' "$1" | sed 's/&/\\&amp;/g; s/</\\&lt;/g; s/>/\\&gt;/g'; }
(set -C; cat > "$plist") <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key><array><string>$(xml_escape ${BIN})</string><string>host</string></array>
  <key>WorkingDirectory</key><string>$(xml_escape "$HOME")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$log")</string>
</dict></plist>
PLIST
plutil -lint "$plist"
domain="gui/$(id -u)"
if launchctl print "$domain" >/dev/null 2>&1; then
  launchctl bootstrap "$domain" "$plist"
else
  printf '%s\n' 'LaunchAgent installed but not started. It will start at the next macOS desktop login for this user.'
fi
printf 'Logs: %s\n' "$log"
`;

function ssh(host: string, script: string, args: string[] = [], tty = false) {
  return [
    "ssh",
    tty ? "-t" : "-T",
    "--",
    host,
    `sh -c ${[script, "sh", ...args].map(shellQuote).join(" ")}`,
  ];
}

async function runSsh(
  host: string,
  script: string,
  args: string[] = [],
  input?: string,
) {
  const proc = Bun.spawn(ssh(host, script, args), {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

async function targetOf(host: string) {
  const probe = Bun.spawn(
    ssh(host, 'set -e; printf "%s %s\\n" "$(uname -s)" "$(uname -m)"'),
    { stdin: "ignore", stderr: "inherit", stdout: "pipe" },
  );
  const [code, output] = await Promise.all([
    probe.exited,
    new Response(probe.stdout).text(),
  ]);
  if (code !== 0) throw new Error(`Could not detect the platform on ${host}.`);
  const [os, cpu] = output.trim().split(/\s+/);
  const platform = os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : null;
  const arch =
    cpu === "x86_64"
      ? "x64"
      : cpu === "aarch64" || cpu === "arm64"
        ? "arm64"
        : null;
  if (!platform || !arch)
    throw new Error(`Unsupported SSH host: ${output.trim()}`);
  return { platform, arch };
}

async function install(host: string, release: string) {
  const tar = Bun.spawn(["tar", "-cf", "-", "-C", release, ...FILES], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const copy = Bun.spawn(
    ssh(
      host,
      `
set -eu
umask 077
if [ -n "\${PI_CODING_AGENT_DIR:-}\${PI_CONFIG_DIR:-}\${KEYLIME_OMP_BIN:-}\${KEYLIME_PACKAGE_DIR:-}" ]; then
  printf '%s\n' 'This installer requires the default agent directory and runner on the SSH host.' >&2
  exit 1
fi
config="$HOME/.omp/agent/keylime/host.json"
if [ -e "$config" ] || [ -L "$config" ]; then
  printf '%s\n' 'This user already has Keylime host configuration. Use its existing daemon.' >&2
  exit 1
fi
dir="$HOME/${INSTALL}"
mkdir -p "$(dirname "$dir")"
if ! mkdir "$dir"; then
  printf 'Not replacing %s. This installer is for new hosts.\n' "$dir" >&2
  exit 1
fi
trap 'rm -rf "$dir"' EXIT
trap 'exit 1' HUP INT TERM
tar -xf - -C "$dir"
${BIN} preflight
trap - EXIT
`,
    ),
    { stdin: tar.stdout, stdout: "inherit", stderr: "inherit" },
  );
  const [copyExit, tarExit] = await Promise.all([copy.exited, tar.exited]);
  if (copyExit !== 0 || tarExit !== 0)
    throw new Error(`Install failed on ${host}.`);
}

async function buildRelease(platform: string, arch: string) {
  const root = resolve(import.meta.dir, "..");
  const target = `${platform}-${arch}`;
  const compileTarget = `bun-${target}${arch === "x64" ? "-baseline" : ""}`;
  console.log(`Building missing ${target} release from this checkout...`);
  const commands = [
    ["--no-env-file", "runner/scripts/use-omp-build.ts"],
    ["install", "--cwd=runner", "--frozen-lockfile", "--os=*", "--cpu=*"],
    ["--no-env-file", "runner/scripts/build-binary.ts", target],
    ["--no-env-file", "scripts/build-client.ts"],
    [
      "--no-env-file",
      "scripts/build-binary.ts",
      "--target",
      compileTarget,
      "--no-archive",
    ],
  ];
  for (const args of commands) {
    const code = await Bun.spawn([process.execPath, ...args], {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).exited;
    if (code !== 0)
      throw new Error(`Release build failed (${code}): bun ${args.join(" ")}`);
  }
}

async function main(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      release: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [host] = positionals;
  if (
    positionals.length !== 1 ||
    !host ||
    host.startsWith("-") ||
    /\s/.test(host)
  )
    throw new Error(USAGE);
  if (!process.stdin.isTTY)
    throw new Error("Run this installer from an interactive terminal.");

  const { platform, arch } = await targetOf(host);
  const active = join(homedir(), ".local/share/keylime/current");
  const defaultRelease =
    platform === process.platform && arch === process.arch && existsSync(active)
      ? active
      : `release/keylime-${platform}-${arch}`;
  const candidate = resolve(values.release ?? defaultRelease);
  if (values.release === undefined && !existsSync(candidate))
    await buildRelease(platform, arch);
  if (!existsSync(candidate)) {
    throw new Error(
      `Release directory not found: ${candidate}. Pass --release with the unpacked ${platform}-${arch} build.`,
    );
  }
  // Pin the active release before waiting at the prompts.
  const release = realpathSync(candidate);
  for (const name of FILES) {
    const file = join(release, name);
    try {
      if (name.startsWith("keylime")) accessSync(file, constants.X_OK);
      const info = lstatSync(file);
      if (name === "licenses" ? !info.isDirectory() : !info.isFile())
        throw new Error();
    } catch {
      throw new Error(
        `Missing or unusable ${file}. Pass --release with an unpacked ${platform}-${arch} release that includes the runner.`,
      );
    }
  }
  console.log(
    `Installing ${platform}-${arch} from ${release} on ${host}. Use the same build as your FE.`,
  );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let url: URL | null;
  let autostart: boolean;
  try {
    url = URL.parse((await terminal.question("FE HTTPS URL: ")).trim());
    if (
      !url ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Enter the FE's HTTPS origin, e.g. https://keylime.example.com",
      );
    }
    const manager =
      platform === "linux"
        ? "systemd user service (start at boot)"
        : "launchd LaunchAgent (start at desktop login)";
    const answer = (
      await terminal.question(`Enable autostart with a ${manager}? [y/N] `)
    ).trim();
    if (!/^(?:y(?:es)?|n(?:o)?)?$/i.test(answer))
      throw new Error("Answer yes or no to the autostart prompt.");
    autostart = /^y/i.test(answer);
  } finally {
    terminal.close();
  }
  console.log(
    "In the FE, go to Settings → Hosts → Add host and copy the host token.",
  );
  const token = (
    await promptPassword({ label: "Host token (input hidden)" })
  )?.trim();
  if (!token) return 130;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("Expected the 43-character host token shown in the FE.");
  await install(host, release);
  if (
    await runSsh(
      host,
      `umask 077; exec ${BIN} host login --add --url "$1"`,
      [url.origin],
      `${token}\n`,
    )
  ) {
    throw new Error(
      `Binaries installed on ${host}, but enrollment failed. See "Link it to the FE" in docs/remote-host-deployment.md.`,
    );
  }
  console.log("Check Settings → Hosts for online status.");
  if (autostart) {
    if (await runSsh(host, platform === "linux" ? SYSTEMD : LAUNCHD)) {
      throw new Error(
        `Enrollment saved on ${host}, but autostart setup failed. Check the service error above before starting another daemon.`,
      );
    }
    return 0;
  }
  console.log(
    "Autostart skipped. Running the host in the foreground; Ctrl-C stops it.",
  );
  return Bun.spawn(ssh(host, `exec ${BIN} host`, [], true), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
}

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (error) {
  console.error(
    `deploy:host: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
