<div align="center">

<img src="public/icon.svg" alt="Keylime logo (inherited from ompweb)" width="150">

<h1>Keylime</h1>

<p>A personal, intentionally breaking OMP workspace.</p>

</div>

Keylime is Matt Cowger's independent, public continuation of [ompweb](https://github.com/ompweb-dev/ompweb), a browser workspace for the [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) coding agent. It supports chatting with agents, browsing sessions and projects, configuring OMP, and inspecting files.

## Hard fork

This repository, [mcowger/keylime](https://github.com/mcowger/keylime), is an intentionally breaking hard fork, not a compatible replacement for upstream ompweb. It is maintained independently and is not part of GitHub's fork network. Upstream compatibility is not a goal. Breaking changes are expected; no backward compatibility or migration paths are promised for data formats, APIs, configuration, CLI commands, or deployments.

Prefer a clean implementation over compatibility shims, deprecated aliases, fallbacks, or migration code. Upstream documentation below describes the inherited baseline; this fork's policy takes precedence where they conflict. This does not waive security, data-integrity, or license requirements.
This fork supports macOS and Linux only. Windows support is removed, with no compatibility or migration path.

### Fork status

- Bun is the only JavaScript/TypeScript runtime, pinned to 1.4.4 through mise. The web server and host daemon remain separate processes.
- Formatting uses `bun fmt`; typechecking uses `bun check`. ESLint and standalone TypeScript tooling are removed, with no lint gate.
- The repository has been fully reformatted. Local release checks enforce formatting and typechecking.
- All four GitHub Actions workflows are disabled, preserved as `.github/workflows/*.yml.disabled`. There are no automatic CI, builds, or releases.
- Internal package names, CLI commands, and release URLs below still identify upstream. They do not install or publish Keylime's changes. Build this checkout using [Development](#development). Repository publication does not rename the runtime package or redirect runner downloads.

![ompweb — live session demo](docs/demo.gif)

<details>
<summary>Screenshots (light / dark)</summary>

![ompweb — light theme](docs/screenshot-light.png)

![ompweb — dark theme](docs/screenshot-dark.png)

</details>

## Requirements

- Supported platforms are macOS and glibc Linux on x64 and arm64. ompweb downloads its matching `ompweb-omp` build from its GitHub release, verifies its SHA-256, and stores it beside the single binary or under `~/.omp/agent/omp-web/omp/<version>/`. Run `ompweb fetch-omp` to fetch it explicitly.
- [mise](https://mise.jdx.dev) manages the Bun runtime. Run `mise trust && mise install` in this checkout to install the pinned Bun version, then use `mise exec -- bun` if mise is not activated in your shell. The launcher, web server and host daemon all run on Bun; the native single binary embeds it.

The **Steer**, **Delete** and **Edit** actions on a queued message are commands of the `ompweb-omp` channel (`promote_queued_message`, `remove_queued_message`). Deletion is confirmed by omp before the chip disappears; editing recalls text only after cancellation succeeds. A message that is no longer pending leaves the queue unchanged and displays a notice; ompweb does not send a duplicate steering message.

The queue panel shows omp's own queue (`queuedMessages` in `get_state` and `queue_update` events), so every device viewing a session sees the same queued messages. **Stop** moves the text of messages still waiting in the queue back into the composer instead of letting the agent run them; a steer the model already picked up through live steering still runs.

## App installation behind authentication

To install the web app, sign in first and use your browser's installation menu.
The single manifest link requests `/api/manifest` with credentials; that endpoint
uses the existing web-password guard and private, revalidating caching. Its
192×192 and 512×512 PNG icons are embedded from the packaged assets because
Android's native installer fetches ordinary icon URLs without authentication
cookies. The app still launches at `/` with scope `/`. Its `theme_color` and
`background_color` come from the manifest link's `?theme=` parameter: Chrome
refreshes an installed app's manifest without cookies, so the server renders the
selected theme's color (remembered in the `omp-theme-color` cookie) into the
link. Chrome 153 and later color an installed app's Android navigation bar from
it after Chrome next checks the app for manifest updates.

Keep Cloudflare Access and application authentication enabled; no public
manifest exception or Access bypass rule is needed. This does not add offline
support. Local Chromium verification covered cookie-gated metadata with HTTP
icon URLs blocked (zero installability errors). The owner also confirmed that
installation on a physical phone works as expected behind Cloudflare Access.

## Notifications

Turn on notifications in **Settings → Notifications**. Each browser keeps its own
settings: which events notify (task finished, waiting for input, run failed,
model switched automatically) and what happens while you use omp-web in another
tab (an in-app toast, or always a system notification). Nothing is shown for the
session you are viewing. Clicking a notification opens its session.

- **Push** reaches the browser even when no omp-web tab is open. It needs a
  secure context (HTTPS through your reverse proxy, or `localhost`), and the
  omp-web server needs outbound HTTPS access to the browser vendors' push
  services. omp-web generates its push (VAPID) keys on first use and stores them,
  with the device list and the notification history, in its data directory
  (owner-only), so they survive restarts.
- On **iPhone and iPad** (iOS 16.4 or later), push works only in the app added
  to the Home Screen.
- In a secure context without push support, system notifications appear while
  an omp-web tab is open. Over plain HTTP on a non-localhost address, browsers
  allow no system notifications: only the in-app toasts shown while you use
  omp-web remain.
- Desktop browsers show notifications through the operating system's
  notification center. Push delivery needs the browser process running.

Completion notifications use the `ompweb-omp` channel's `prompt_result` and
`session_settled` frames.

## Quick Start

**Run directly without installing:**

```bash
bunx --bun @kahme247/ompweb@latest
```

**Or install globally:**

```bash
bun add -g @kahme247/ompweb
ompweb
```

**Or download the single binary** (no Bun installation): see [Single binary](#single-binary).

Open [http://127.0.0.1:30177](http://127.0.0.1:30177) in your browser.

### CLI Options

```bash
ompweb --port 8080                         # Custom port
ompweb --hostname 0.0.0.0                  # Listen on network
ompweb hash-password                       # Print the value for OMP_WEB_PASSWORD_HASH
ompweb fetch-omp                           # Download this version's ompweb-omp from its GitHub release (SHA-256-checked) if it is missing
ompweb preflight                           # Start the session omp once (as a new session would) and wait for its hello; exit 1 says why it failed
ompweb --no-open                           # Don't auto-open the browser
ompweb systemd install                     # Install Linux systemd user services (web + ompweb-host daemon)
ompweb launchd install                     # Install the macOS launchd agents (web + ompweb-host daemon)
ompweb --help                              # Show help
ompweb --version                           # Show version
```

### Password protection

omp-web **never passes a plaintext password to the server**, because every
`omp` session inherits the server's environment: an agent running `env` would
print the password into its session file and send it to the model provider.

Password protection is optional on every bind address, including `0.0.0.0`. Without `OMP_WEB_PASSWORD_HASH`, anyone who can reach the server can access its agent and file capabilities. Choose authentication and network access controls for your deployment.
`--password` stops `ompweb` at startup. An `OMP_WEB_PASSWORD` still works for
now: `ompweb` hashes it at startup, keeps it out of the server's environment,
and logs a warning with the hash to put in `OMP_WEB_PASSWORD_HASH` instead.
Switch soon: agents can still read the plaintext from the `ompweb` launcher
process, and each start makes a new hash, so every restart signs all browsers
out. Setting both variables stops `ompweb`; remove `OMP_WEB_PASSWORD`.

Generate a hash instead and give that to the server:

```bash
ompweb hash-password                       # asks twice, input hidden
echo "a-long-random-password" | ompweb hash-password   # or pipe it in

OMP_WEB_PASSWORD_HASH='scrypt$15$8$1$…' ompweb
```

`ompweb hash-password` reads the password from stdin — never from a command
line argument — so it stays out of your shell history and out of `ps` output.
The hash is scrypt (N = 2^15, r = 8, p = 1) with a fresh 16-byte salt, printed
in the self-describing form `scrypt$<ln>$<r>$<p>$<salt>$<digest>`. Anyone who
reads the hash cannot sign in with it, and it cannot be turned back into the
password.

Sessions are not signed with the password hash. A random signing key is created
on first start in `~/.omp/agent/omp-web/web-auth-secret.json` (mode `0600`) and
mixed with the hash, so changing the password still signs everyone out while the
stored hash alone is never enough to forge a session.

The service installers (`ompweb systemd install` and `ompweb launchd install`) accept `OMP_WEB_PASSWORD` at install time and store only its hash.

### Behind a reverse proxy

Forward WebSocket upgrades on `/api/events/link` (browsers) and `/api/hosts/link` (hosts); without the upgrade, a browser falls back to server-sent events after a few seconds. In nginx that means `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade;`, `proxy_set_header Connection "upgrade";`, and a `proxy_read_timeout` well above 30 s.

Hosts that [use the server's provider logins](#use-the-servers-provider-logins-on-a-host) also call `/api/hosts/broker/`, authenticated by their host token. That path must reach ompweb without the proxy's own authentication (a proxy login page or `auth_request` would block the daemon), without response buffering (it carries a long-lived event stream; in nginx, `proxy_buffering off;`) and without redirects.

Cluster members also fetch this machine's omp configuration from `/api/hosts/cluster-config/manifest` and `/api/hosts/cluster-config/file/<hash>` (exactly these two paths, `<hash>` being 64 hexadecimal digits), authenticated by their host token and answering members only. Unlike the broker's prefix, they must be reachable at exactly these paths, without the proxy's own authentication and without redirects.

### Two services: the web server and the local daemon

ompweb runs the web server and `ompweb host` as separate Bun processes. The daemon
runs this machine's `omp` sessions and links to the web server over loopback.
The service installers (`ompweb systemd install` and `ompweb launchd install`)
install both the web service and `ompweb-host`. Uninstall removes both.

**Running ompweb in the foreground** (`ompweb` in a terminal, or
`bunx --bun @kahme247/ompweb@latest`) installs no service, so keep
`ompweb host` (with bunx: `bunx --bun @kahme247/ompweb@latest host`) running in a
second terminal. Without it "This machine" stays offline. The web server writes
the daemon's link when it starts, so start the web server first.

- **Restarting or redeploying the web server does not interrupt runs.** The daemon
  keeps the omp processes running; the restarted web server takes them over, with
  no resume prompt, and dialogs or tool calls omp was waiting on reappear.
- **Restarting the daemon does end runs** (it owns the omp processes). With auto-resume
  on, sessions that were running resume once. `ompweb systemd restart` restarts the
  web service only; upgrades restart the daemon only when its link protocol version
  is outside the range the new release supports.
- **First start after an upgrade:** if no daemon has linked after about 90 seconds,
  ompweb shows a banner with the install command for your platform. It never installs
  services itself. Until the daemon runs, "This machine" shows offline and new
  sessions on it cannot start.
- **It is a host like any other.** Rename "This machine" in **Settings → Hosts**
  (clear the name to reset it); it cannot be revoked. The web server writes the
  daemon's link (`~/.omp/agent/omp-web/host.json`, mode `600`) at startup, only
  for a loopback bind address.
- **Development:** `bun run dev` does not take the daemon (see
  [Development](#development)).

### Hosts, projects, and workspaces

Projects are registered on a particular host, not placed across a pool. Each host daemon owns its project → workspace → session registrations and shares them with every linked web server. The hierarchy starts empty, even when older project or session data exists. Add a project to create its default workspace, then discover and selectively import existing worktrees and sessions. Non-Git projects have one workspace. Multiple agents may use the same workspace and files concurrently.

Unregistering a project or workspace forgets its children without deleting files or stopping processes. Re-adding it starts with fresh registrations. Missing resources remain visible as unavailable. Creating and deleting Git workspaces has separate setup and safety rules; see [Projects and workspaces](docs/worktrees.md).

Cluster membership still shares this machine's provider logins and omp configuration with member hosts. This includes secrets and executable configuration, so only join hosts you trust. Membership does not merge projects or select a host for a new session. Leaving restores the member's own configuration.

### Cluster members use this machine's omp configuration

Each member uses this machine's omp configuration: models, MCP servers, skills, task agents, rules and plugins. A change made here, in Settings or on disk, reaches members within about a minute and before a session starts on a member. A host outside the cluster keeps its own configuration, managed on that machine.

- **What is mirrored:** from this machine's omp agent directory (`~/.omp/agent`): `config.yml`
  (without the keys below), `models.yml`, `mcp.json`, `.mcp.json`, `AGENTS.md`, `RULES.md`,
  `SYSTEM.md`, `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, `secrets.yml`, `.env`, and the directories
  `skills/`, `agents/`, `rules/`, `instructions/`, `commands/`, `prompts/`, `hooks/`,
  `extensions/` and `tools/`. Also `~/.agents/skills/` (where Settings installs skills), the
  agent environment variables of **Settings → System**, and the set of installed plugins with
  whether each is enabled. A mirrored directory becomes equal to this machine's: a file that
  exists only on the member is removed from it. `node_modules` and `.git` directories are left
  out. The member's backup holds only what the host had when it joined; a file added or edited
  on the member afterwards is deleted at the next apply, not backed up.
- **What is not mirrored:** `lsp.json`, `ssh.json`, themes, key bindings, sessions, history,
  `agent.db`, caches and `secret-placeholder.key`; configuration inside a repository (`.omp/`
  travels with the checkout); named omp profiles (which use their own files on each host); and programs: an MCP server's command, a
  language server or a local model engine that exists only on this machine is not installed on
  members.
- **Settings that stay the member's own:** `shellPath`, `python.interpreter`, `browser.*`,
  `worktree.base`, `plan.autosaveDir`, `shellMinimizer.settingsPath`, `mnemopi.dbPath`,
  `workspace.additionalDirectories`, `skills.customDirectories`, `extensions`, `images.urls.*`,
  `providers.tinyModelDevice`, `providers.tinyModelDtype`, `tts.*`, `stt.*`, `tui.*`,
  `terminal.*`, `lsp.*` and `auth.broker.*`. A member keeps its own value for each of them as
  it was when the host joined, or none; a change made on the member afterwards is reset at the
  next apply.
- **Limits:** a file over 5 MiB, a configuration over 50 MiB in all, or a file list over 5 MiB is not mirrored. A session start on a member is refused (409 `cluster_config_invalid`), and **Settings → Hosts** names the file that is over or says there are too many files. A `config.yml` that is not a YAML map or a file that cannot be read does
  the same. Each download a member makes (the list of files, and each file) must finish within
  30 s, body included; a 5 MiB file needs roughly 1.4 Mbit/s, and a member on a slower link
  does not update.
- **When a member applies it:** after joining; when it is behind this machine's version
  (checked every 30 s and at each cluster session start on a member; a new version found
  either way is sent to every member at once); and before every session start on the member, which waits for it. The
  files are written whole or not at all: a failure leaves the previous version in place. Every
  session start carries this machine's version, and a start on that member is refused with the reason when the
  files cannot be applied. A session recovered after a daemon restart, or
  started by another ompweb server, runs on whatever is on the member's disk at that moment.
  Sessions already running are not restarted. The applied files are readable by the daemon's
  user only.
- **Plugins:** after the files, the member runs `omp plugin` itself to install what it lacks
  (this needs `bun` and network access on the member), uninstall what this machine does not
  have, and match each plugin's enabled state. npm plugins
  are pinned to this machine's version; a marketplace plugin has no version pin in omp, so one
  already installed counts as matching. A session start does not wait for its own version's
  plugins, but a start that needs a new version waits behind a plugin job that is still running
  (up to 5 minutes for each install). A new version with the same plugins keeps the member
  current while its plugins are checked again. A failed install
  leaves the member not current, so placement skips it; it is retried about every 30 s and
  Settings shows omp's message.
- **Joining:** needs link protocol 10 on the host. Before the first apply, the host's own
  version of every mirrored file and directory moves to `<agent dir>/omp-web/own-config/` on
  the host, with its plugin list and agent environment variables; the join dialog says the host
  receives this machine's configuration, API keys and environment values included, in place of
  its own until it leaves. A host holds one ompweb server's configuration at
  a time: a host already in another server's cluster cannot join (409 `host_in_other_cluster`)
  and must leave that cluster first. If the host also runs sessions for another ompweb server
  (as a standalone host there), they run on this server's configuration for as long as the host
  is a member here.
- **Changes made on a member** to a mirrored file are overwritten at the next apply; change the
  configuration here. An apply is refused when `~/.agents` is a symbolic link on the member:
  replace it with a real directory. The
  mirrored directories, the staging area and the backup must be on one filesystem.
- **Leaving:** the daemon removes the mirrored files, moves its backup into place, puts back
  its agent environment variables, and reinstalls its own plugins as far as omp allows. Its own
  `config.yml` is its own file again. If putting its configuration back fails, Settings says so
  and the restore is retried while the host is linked, also for a host that was offline when it
  left. A member that is revoked gets its own omp configuration back from its daemon: at once if
  the daemon is connected, otherwise the next time it reaches this machine (and is refused). A session start
  that races a leave is refused. This machine is the master: nothing is
  mirrored to it and nothing of it is backed up.
- **Settings:** each member's line in **Settings → Hosts** shows _same as the master_,
  _updating…_, _failed_ with the reason, _held by another ompweb server_, or that the host needs
  an update, and the MCP server commands in the mirrored files that are not installed there.
  When this machine's configuration cannot be mirrored, one message names the file, and no
  member line says _updating…_. For a session or project of the cluster, the Models, settings, MCP, Skills, Plugins and Agents
  screens say that changes apply to every member, and so does **Settings → System** next to the
  agent environment variables. For a session on another member they act on
  this machine's user-level configuration, which the member runs; that session's and project's
  own configuration is not shown there. MCP shows that session's live status, read from the
  process where it runs, and cannot change it; MCP toggles, reload and Skills diagnostics for
  the session are not available there.
- **API:** `GET /api/plugins`, `POST /api/plugins`, `GET /api/skills`, `POST /api/skills/check`
  and `POST /api/skills/update` accept a request without `cwd` and then act on the user level
  only (a project-scope change still needs a `cwd`). `GET /api/mcp?sessionId=…&attach=1` reads
  the live MCP status of a session that is already running and never starts one.
- **Security:** the configuration contains secrets: API keys in `models.yml` and `.env`, MCP
  server environments and headers, tokens in `config.yml` and the values in `secrets.yml`. They
  are written to every member's disk, readable by the daemon's user only; a member can already
  read this machine's provider logins, and this adds the rest. Hooks, extensions, custom tools
  and plugins are code: this machine's code runs on every member; this machine can already
  start omp with full tool access there. Nothing flows the other way:
  a member cannot change this machine's configuration, and the routes only serve members,
  checked on every request, and stop answering a host the moment it leaves or is revoked.
- **Differences that remain:** a provider in `models.yml` that points at this machine's own
  address (for example `http://127.0.0.1:11434`) points at the member's own address there, so a
  local engine has to run on each member or be given an address they can all reach. An API key
  written as an environment-variable name or as a `!command` resolves on the member: the
  variable or command must exist there (variables set in Settings → System or in the mirrored
  `.env` do). MCP servers started by a command need that command on each member.

### Local worker maintenance

`ompweb host status` prints daemon PID, native version/protocol, welcomed-link readiness,
executable/entrypoint identity and maintenance state without credentials.
`ompweb host drain` synchronously checks children (idle included), preparations,
uploads/controls, pending operations and reliable results, and closes new-work admission
only when idle. A busy refusal never kills work or changes admission.
`ompweb host resume` reopens the live daemon. Controls run inside the existing daemon, not
TCP or a separate service: a private Unix socket on Linux and macOS. A disconnected
deployer cannot release a live drain.
Disable central member admission before worker rollout; native drain is the final race-free guard.

Worker service cutovers can additionally start drained through `OMP_WEB_HOST_DRAINED=1`
in their protected temporary unit environment. Live resume does not remove that startup
setting. After a deployer crash or lost final resume reply, verify the selected release,
PID and welcomed-link health, and remove the known worker maintenance flag before explicit
resume. Never infer from a missing acknowledgement that admission stayed closed, and never
stop or roll back a candidate after its deployment commit point.

### Single binary

Each [release](https://github.com/ompweb-dev/ompweb/releases/latest) also ships
ompweb as one compiled program with the files it serves beside it:
`ompweb-linux-x64.tar.gz`, `ompweb-linux-arm64.tar.gz`, `ompweb-darwin-x64.tar.gz`,
`ompweb-darwin-arm64.tar.gz`. It needs no separate Bun installation or omp: on its first start it downloads its own omp build, `ompweb-omp`, from the same release
(SHA-256-checked) and keeps it beside itself (prerelease archives already carry it). The x64 builds use Bun's baseline runtime, so
they also run on CPUs without AVX2. Each archive carries the licenses of what it
bundles in `licenses/`. Every commit on `main` that passes CI is also published as a
[prerelease](https://github.com/ompweb-dev/ompweb/releases) named after the time it was
built (for example `2026-11-01T10:30:00Z`), with the same four archives.

```bash
tar -xzf ompweb-linux-x64.tar.gz -C ~/.local/share   # unpacks ompweb-linux-x64/
~/.local/share/ompweb-linux-x64/ompweb               # the web server: same options and environment variables as above
~/.local/share/ompweb-linux-x64/ompweb host          # the local daemon, in a second terminal
```

- **Keep `ompweb` in its directory.** It runs the `ompweb-omp` beside it and serves `dist/`, `public/` and the other
  files from the directory it is in (a symlink to it on your `PATH` works), or
  from `OMP_WEB_PACKAGE_DIR` when that is set.
- **macOS** quarantines downloads: run `xattr -dr com.apple.quarantine ompweb-darwin-arm64`
  once before the first start.
- **macOS 15 and later** ask before an app may reach your local network. If
  `ompweb host` on a Mac reports `ECONNREFUSED` for a server on your LAN while
  `curl` reaches it, allow your terminal (or `ompweb`) under System Settings →
  Privacy & Security → Local Network. A server reached over a VPN such as
  Tailscale, or a host started from an SSH session, is not affected.
- **No service installers or in-app update.** To update, stop `ompweb` and
  `ompweb host`, replace the directory with the new release, and start both again;
  **Settings → System** links the release page when a new version is out.
  Your sessions and settings live in `~/.omp`, not in that directory.
- **As systemd user services**, write the two units yourself (adjust the paths):

```ini
# ~/.config/systemd/user/ompweb.service
[Unit]
Description=ompweb web service

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb --no-open
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
# OMP_WEB_PASSWORD_HASH, PORT and OMP_WEB_HOSTNAME go here, as for ompweb-systemd.
EnvironmentFile=-%h/.omp/agent/web-service.env
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/ompweb-host.service
[Unit]
Description=ompweb host daemon
# It exits until the web server has written its link: keep restarting.
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb host
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.omp/agent/web-service.env
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ompweb ompweb-host
```

On macOS, two launchd agents (`ProgramArguments` `…/ompweb --no-open` and
`…/ompweb host`, with `RunAtLoad` and `KeepAlive`) do the same.

### Run as a macOS Service (launchd)

Install ompweb as a launchd user agent that starts at login and restarts on crash:

```bash
bunx --bun --package=@kahme247/ompweb@latest ompweb-launchd install
```

Manage it with:

```bash
bunx --bun --package=@kahme247/ompweb@latest ompweb-launchd status      # Show service state
bunx --bun --package=@kahme247/ompweb@latest ompweb-launchd uninstall   # Stop and remove
```

The service runs `bunx --bun @kahme247/ompweb@latest`; pass a package spec to pin a
version, e.g. `ompweb-launchd install @kahme247/ompweb@0.3.6`. All
[environment variables](#environment-variables) are read at install time and baked
into the plist, plus `OMP_WEB_PKG` (package spec, same as the positional argument).
As a service, the browser is **not** auto-opened by default — install with
`OMP_WEB_NO_OPEN=0` to restore that.

```bash
OMP_WEB_PASSWORD=secret bunx --bun --package=@kahme247/ompweb@latest ompweb-launchd install
```

`OMP_WEB_PASSWORD` is hashed at install time; the plist holds the hash, never
the password. Pass `OMP_WEB_PASSWORD_HASH` to install a hash you generated with
`ompweb hash-password`.

Authentication is your choice on every bind address. For remote access, a password, trusted reverse proxy, or VPN can limit who reaches the app. Use HTTPS when sending a password or session cookie over an untrusted network.

Logs go to `~/Library/Logs/ompweb/ompweb.log` (web) and
`~/Library/Logs/ompweb/ompweb-host.log` (the
[local daemon](#two-services-the-web-server-and-the-local-daemon)). The plists live at
`~/Library/LaunchAgents/com.kahme247.ompweb.plist` (mode 600; the password
hash — not the password — is stored there) and
`~/Library/LaunchAgents/com.kahme247.ompweb-host.plist`.

### Run as a Linux Service (systemd)

Install ompweb as a systemd **user** service that starts at login and restarts
on crash:

```bash
bunx --bun --package=@kahme247/ompweb@latest ompweb-systemd install
```

The installer creates `~/.omp/agent/web-service.env` automatically with mode
`600`; no manual file creation is required. The explicit `--package` form makes
`bunx` run the systemd executable from the selected package.

To bind the service to all IPv4 interfaces for LAN access, set a password while
installing:

```bash
OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_PASSWORD='change-me' \
  bunx --bun --package=@kahme247/ompweb@latest ompweb-systemd install
```

The password is hashed before it is written to `web-service.env`.

Manage it with:

```bash
bunx --bun --package=@kahme247/ompweb@latest ompweb-systemd status    # Show service state
bunx --bun --package=@kahme247/ompweb@latest ompweb-systemd restart   # start / stop / restart
bunx --bun --package=@kahme247/ompweb@latest ompweb-systemd uninstall # Stop and remove
```

The service runs the locally installed `ompweb` binary resolved at install time
(override with `OMP_WEB_SYSTEMD_BIN`). Runtime configuration lives in
`~/.omp/agent/web-service.env`. Edit the port, hostname, or password hash there
and restart the service; no reinstall needed.
Install-time [environment variables](#environment-variables) are baked into
that file. As a service, the browser is **not** auto-opened by default. The
units live at `~/.config/systemd/user/ompweb.service` and
`~/.config/systemd/user/ompweb-host.service` (the
[local daemon](#two-services-the-web-server-and-the-local-daemon)); logs go to
the journal:

```bash
journalctl --user -u ompweb -u ompweb-host -f
```

On a headless server, enable user lingering if the service must keep running
after the last login session ends:

```bash
loginctl enable-linger "$USER"
```

## Run sessions on another machine

One ompweb can start and watch omp sessions on other machines. Each machine keeps
its own ompweb (with its `ompweb-omp`), `~/.omp/agent` directory, sessions, and credentials (unless you
[share the server's provider logins](#use-the-servers-provider-logins-on-a-host));
ompweb only routes. The remote machine needs either Bun (for `bunx`) or
the [single binary](#single-binary), and must be able to reach the ompweb server over
HTTP(S). It dials out, so it can sit behind NAT.

1. On the ompweb server, open **Settings → Hosts → Add host**, enter a name, and copy
   the token. The token is shown once; only its hash is stored.
2. On the remote machine, save the link. The token is read from stdin, never from
   an argument, so it does not show up in `ps`:

   ```bash
   bunx --bun @kahme247/ompweb@latest host login --url https://your-ompweb.example.com
   ```

   Paste the token when prompted (or pipe it in). It is saved to
   `~/.omp/agent/omp-web/host.json` with mode `600`.

3. Start the link and leave it running:

   ```bash
   bunx --bun @kahme247/ompweb@latest host
   ```

   The host shows **online** in Settings → Hosts, the sidebar gets a group for it,
   and the new-session screen gets a host picker.

**Settings → Hosts** also shows each machine's ompweb daemon and omp versions,
available updates and update actions, including **This machine**.
Checks and installations run on the selected host, not on the web server. A host
update whose link protocol is incompatible with the current web app stays visible
but is blocked with a reason; update the web server first. An unverifiable target
protocol is blocked too. omp is part of each ompweb release and updates with it.
Before updating a daemon, close its session processes: the updater refuses to
interrupt sessions or subagents. **Settings → System** keeps the web server's
own application update and service settings.
Hosts need a daemon build that supports these update operations; older builds
show an unsupported message and need one manual update first. If the daemon
shares its installation with the web server, update the server first, then use
the host's restart-only update. Unsupported service wrappers and detected restart
scripts show a manual-update reason. Stop external restart loops before updating
a foreground daemon.

A daemon update is carried out by a separate updater process on the host. It
stops the daemon, swaps in the new release and starts it again, and on a failure
it restores the previous release. If that updater is itself killed after stopping
the daemon (a reboot, an out-of-memory kill), nothing restarts the host, which
stays offline. Recover on the host: in the folder containing the installation,
`.ompweb-backup-<id>` is the previous release. If it is there, move the
installation aside and rename the backup back to the installation's name; then
start `ompweb host` (or its service) again. Settings → Hosts reports the update
as interrupted.

`https://` is required. Plain `http://` is accepted only for loopback addresses, or
with `--allow-http` (for example on a tailnet):

```bash
bunx --bun @kahme247/ompweb@latest host login --url http://100.64.0.1:30177
bunx --bun @kahme247/ompweb@latest host --allow-http
```

If the connection drops, the daemon reconnects by itself (1 s backoff doubling to
60 s; 3 s at most for the web server on the same machine). After a failed dial it
re-reads its saved link, so a web server that came back on another port is found
without restarting the daemon. After a network drop, runs keep going on the remote machine; the chat shows
an offline banner and the runs reattach when the link returns. A laptop that goes
to sleep (closing the lid, usually) pauses the daemon and its omp runs along with
everything else on it: they resume when it wakes, and the link returns then. A
docked or no-sleep setup keeps running with the lid closed. Revoking a host in
Settings closes its link and the daemon stops its omp processes.

A reverse proxy must forward the upgrade on `/api/hosts/link`. For hosts that share the server's logins it must also pass `/api/hosts/broker/` without the proxy's own authentication and without response buffering; for cluster members, likewise `/api/hosts/cluster-config/manifest` and `/api/hosts/cluster-config/file/<hash>` without the proxy's own authentication. See [Behind a reverse proxy](#behind-a-reverse-proxy).

Update ompweb on the server before its hosts: a host from before this version shows **needs upgrade** until it is updated.

Notes:

- **Service helpers:** `ompweb systemd install` and `ompweb launchd install` set up
  this machine's own daemon next to its web server (see
  [Two services](#two-services-the-web-server-and-the-local-daemon)). On the other
  machine you only need the daemon, so use
  [Keep a host running as a service](#keep-a-host-running-as-a-service) instead.
  The daemon exits with code `1` when the server revokes its token or when its
  link protocol version is outside the range the server supports (older than the
  server's oldest supported version, or newer than the server: update ompweb on
  the older side), and `0` when a newer link for the same host replaces it.
  SIGTERM or SIGINT stops the daemon and its omp processes.
  A link is one-per-host, so never run two daemons with the same token.
- **The server's agent directory holds the host list** (`omp-web/hosts.json`).
  Starting the ompweb server with a different `PI_CODING_AGENT_DIR`, or losing
  that file, makes every host token unknown: each daemon is told it was revoked,
  stops its omp processes and exits.
- **Trust:** a linked host runs omp with full tool access on that machine for
  whoever controls the ompweb server or the token. Keep the token private and
  revoke it when a machine is retired.
- **Workspace files on every host:** Explorer, previews, downloads, file search,
  @-mentions and live file watching use the owning machine's daemon, including
  This machine. Explorer uploads accept up to 2 GiB per file with no 100 MiB batch
  cap; preview limits remain 256 KiB for text and 10 MiB for images/DOCX.
  File tabs retain their source session, host and workspace when you switch chats;
  paths from another conversation cannot be mentioned into the selected chat.
  An unavailable or older daemon reports offline or asks for an update; the web server never substitutes its own filesystem.
- **Git and worktrees on every host:** status, diffs, GitHub issue links, and
  worktree creation, selection and removal run on the owning daemon. Dirty
  worktrees still require explicit force confirmation. Switching a worktree
  changes where new sessions start, not an open conversation.
- **Directory browsing and cloning on every host:** the Add workspace picker
  navigates that host's directories and clones HTTPS/SSH repositories there.
  Cancelling waits for the clone process and safe cleanup; interrupted connections
  report an unknown outcome rather than pretending the clone was cancelled.
  If the destination changes during cleanup, captured data is preserved in a
  private quarantine and the error gives its location; inspect it before removing
  or restoring anything.
- **Not available on remote hosts yet:** the Skills,
  Plugins, Agents and MCP settings, for a host outside the cluster (a cluster member uses
  this machine's: see [above](#cluster-members-use-this-machines-omp-configuration)).
  Transcript search still scans this machine.
- **Agent-started sessions:** with agent tools enabled, an agent can pass a `host`
  to `new_session` (it defaults to the agent's own host). A remote host asks for
  confirmation each time unless **Agents can start sessions here without asking**
  is switched on for it in Settings → Hosts. An agent running on a remote host
  always asks before it starts or messages a session on this machine.

### Use the server's provider logins on a host

By default a host uses its own omp logins. Turn on **Use this server's provider logins** for a host in **Settings → Hosts** and the sessions started there use the logins stored on the ompweb server instead, so you log in to a provider once. The setting is per host and off by default; turning it on asks for confirmation. This machine does not have it, because it already uses the server's logins.

- **What is shared:** the provider logins stored on the server (OAuth logins and stored API keys). The server runs `omp auth-broker serve` for this and starts it on the first request; it stops after 5 minutes without one.
- **When a change reaches a host:** every omp process started after a login or logout on the server uses it. A running process picks it up the next time it is used, because omp stops listening for updates after 20 seconds without activity and resumes on its next use. A running process keeps the access tokens and API keys it has already loaded until it ends.
- **What is not shared:** custom providers in `models.yml`, API keys set through environment variables (a host's own environment keys still apply there), and omp settings. A cluster member does get these from this machine: see [Cluster members use this machine's omp configuration](#cluster-members-use-this-machines-omp-configuration).
- **Requirements:** the server's own `omp` must provide `omp auth-broker`. The host's daemon must speak link protocol 9 and its `omp` must be 15.13.1 or newer; otherwise starting a session on that host is refused with a message naming what to update. It never falls back to the host's own stored logins. Joining a session that is already running is not refused. The setting applies to omp processes started after you change it.
- **What the host can read:** the current access token of every OAuth login and every stored API key, in full. A process running as the daemon's user can do the same. OAuth refresh tokens never leave the server machine, and the host cannot add or replace a login. It can mark a login disabled or rate-limited for every machine.
- **Turning it off:** turning sharing off, or revoking the host, aborts the host's open requests to the server and refuses later ones. Access tokens the host already read stay valid until they expire, and API keys until you rotate them at the provider.
- **Dependence on the server:** a running session asks the server whenever an access token needs a refresh, so it fails to authenticate once its token expires while the server is unreachable. An `omp` you run yourself in the host's terminal is unaffected.
- **Troubleshooting:** when sessions on a sharing host fail at startup, check the server log for `[omp-web] broker` lines and that the reverse proxy lets `/api/hosts/broker/` through.

The host token is not put in an omp process's environment. The daemon listens on a loopback port with a secret it generates at each start, gives omp that address and secret, and forwards the requests to the server with the host token.

### Keep a host running as a service

These run the [single binary](#single-binary) in host mode. On Linux a service
keeps the link up across logouts and reboots; on macOS a script keeps it
running in a terminal (see below for why). Unpack the release for the machine first,
then save the link once with `ompweb host login --url …` as in step 2 (with the
binary's path in place of `bunx --bun @kahme247/ompweb@latest`). Each setup starts
`ompweb host` again 10 seconds after it fails, but not after exit 0: that means a
newer link with the same token replaced it, and restarting would take the link back
every 10 seconds. Add `--allow-http` after `host` if
the server URL is plain `http://`, and set `PI_CODING_AGENT_DIR` in the service too
if you saved the link with it set. A machine links to one server: do not also run an
ompweb web server on it, which writes the same link file for its own daemon. To
update, stop the service, replace the release directory, and start it again. After
revoking a host, stop and remove its service: it otherwise keeps retrying.

**Linux (systemd user service).** Create `~/.config/systemd/user/ompweb-host.service`
(adjust the release path):

```ini
[Unit]
Description=ompweb host
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb host
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
# Exit 0: a newer link for this host replaced it. Restarting would take the link back.
RestartPreventExitStatus=0
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ompweb-host
loginctl enable-linger "$USER"            # keep it running while you are logged out
journalctl --user -u ompweb-host -f       # logs
```

**macOS (from a terminal).** No launchd job can run a host that omp sessions can
fully use: a LaunchDaemon has no login keychain or SSH agent, which sessions need
for SSH keys and commit signing, and a LaunchAgent cannot reach LAN addresses. A
process started from a terminal inherits the terminal's keychain and SSH agent, so
run the host there, in tmux so it outlives the window.

tmux does not keep the terminal's Local Network permission, though: the tmux server
detaches from the terminal app, and macOS Local Network privacy then blocks the
ad-hoc signed `ompweb` binary from LAN addresses (`connect` fails with "No route to
host", which the daemon reports as `ECONNREFUSED`; Apple's own tools such as `curl`
are not blocked, so a `curl` test passes). Link the host to a URL that does not
resolve to a LAN address, for example the server's public URL, or its VPN or
tailnet name (a Tailscale MagicDNS name served by your reverse proxy with its own
certificate). Save this as `~/.local/bin/ompweb-host-run` (adjust `DIR`) and make
it executable with `chmod +x`:

```sh
#!/bin/sh
# Keeps `ompweb host` running in this terminal, which lends it its keychain and SSH agent.
# Restarts it 10 s after a crash; stops when the token is revoked or the link protocol is
# unsupported (exit 1), or on exit 0: a newer link replaced it, or it was stopped (Ctrl-C).
DIR=${OMPWEB_DIR:-$HOME/.local/share/ompweb-darwin-arm64}
# A tmux started over SSH sees the login keychain locked: unlock it while a terminal can ask.
security show-keychain-info login.keychain-db 2>/dev/null || security unlock-keychain login.keychain-db || exit 1
while :; do
	(cd "$DIR" && exec ./ompweb host)
	rc=$?
	case $rc in 0 | 1) exit "$rc" ;; esac
	echo "ompweb host exited $rc; restarting in 10 s" >&2
	sleep 10
done
```

Run `ompweb-host-run` in a tmux window; Ctrl-C stops the daemon and its sessions.
Start it again after a reboot or logout. If the login keychain locks itself after
inactivity or on sleep, SSH key passphrases and signing fail until you restart it.

## Features

- **Interactive Chat**: Real-time streaming conversation with your local `omp` agent — tool calls, thinking levels, token counts, cost, context gauge, queue controls, and interrupt & retry.
- **Message Copy**: Copy user messages and completed assistant replies as rendered plain text or original Markdown using the buttons below each message. Thinking, tool output, and message controls are excluded. Oversized messages that use the raw-text viewer copy their full source in either format.
- **Queue Deletion Confirmation**: Preview and confirm before cancelling queued follow-ups or steered messages in OMP. Requires native `remove_queued_message` support; already-delivered messages cannot be recalled.
- **Session Management**: Browse past conversations by project, fork sessions, branch within a session, archive/restore, import session files, and deep-link via URL.
- **Draft Recovery**: Unsent text stays scoped to its conversation or new-session workspace and is restored after Back/Forward navigation or reload in the same tab when browser storage is available (up to 50 drafts). Images and file attachments remain in memory only.
- **Live Plans & Subagents**: The right sidepanel's Activity tab tracks live todo phases and running subagents (status, tool, retries, tokens/cost, nested tasks), with transcript dialogs and history recovery on desktop and mobile.
- **Tool Preset Picker**: Choose the toolset for new sessions in the composer — `none` / `default` (`read,bash,edit,write`) / `full` (all tools including subagents). Persists to localStorage.
- **File Explorer & Previews**: Browse workspaces side-by-side with chat; preview code, markdown, Mermaid, images, audio, PDFs, and diffs with allow-listed access.
- **Git Worktree Support**: Create, import, and manage workspaces under host-bound projects; sessions are registered within each workspace.
- **Remote Hosts**: Link other machines (for example a MacBook) and run sessions there from one ompweb. The sidebar groups sessions by host. See [Run sessions on another machine](#run-sessions-on-another-machine).
- **Usage & Analytics**: Dashboard in **Settings → Usage** for tokens, costs, cache savings, and breakdowns by provider / model / day / project with SQLite persistence.
- **macOS launchd Service**: LaunchAgent that starts at login, restarts on crash, and logs under `~/Library/Logs/ompweb`.
- **Linux systemd Service**: User services that start at login and restart on crash.
- **Notifications**: Desktop and mobile (PWA) notifications for finished tasks, questions waiting for an answer, failed runs, and automatic model switches, with Web Push when served over HTTPS. See [Notifications](#notifications).
- **Web-based Settings** (11 tabs): Interface & Behavior, Safety & Approvals, AI Model Defaults, API Keys & Providers, Usage, Agent & Intelligence (advisor, memory, compaction), Agents, Extensions & Tools (MCP, skills, plugins), Hosts, Notifications, System.
- **Slash Commands & Shortcuts**: Quick prompts (`/plan`, `/review`, `/fix`, `/test`, etc.), `⌘K` / `Ctrl+K` palette, and model/reasoning cycling.
- **UI Themes**: Warm paper light/dark themes plus an omp.sh-inspired midnight (`omp`) theme, chat font size and interface scale.

## Environment Variables

| Variable                        | Description                                                                                                                                                                                                                                                                                                                                                                       | Default                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `PORT`                          | Server port                                                                                                                                                                                                                                                                                                                                                                       | `30177`                               |
| `OMP_WEB_HOSTNAME`              | Server bind host                                                                                                                                                                                                                                                                                                                                                                  | `127.0.0.1`                           |
| `OMP_WEB_PASSWORD_HASH`         | Optional scrypt hash of the web login password, from `ompweb hash-password`. Optional on every bind address, including `0.0.0.0`                                                                                                                                                                                                                                                  | _None (auth disabled)_                |
| `OMP_WEB_TRUSTED_HEADER_SHA256` | SHA-256 hex digest of the secret a trusted reverse proxy sends in `X-Omp-Web-Auth` to skip the password for that request; see [Skipping the password on trusted networks](#skipping-the-password-on-trusted-networks)                                                                                                                                                             | _None (disabled)_                     |
| `OMP_WEB_NO_OPEN`               | Set to `1` to prevent auto-opening browser                                                                                                                                                                                                                                                                                                                                        | `0`                                   |
| `OMP_WEB_DISABLE_AUTOUPDATE`    | Set to `1` to disable update checks and in-app updates; restart after changing                                                                                                                                                                                                                                                                                                    | `0`                                   |
| `OMP_WEB_NAME`                  | Name shown in browser tabs and installed-app names. `url`, `host` or `domain` (any case) uses the hostname the browser connected to, without port; localhost and IP addresses keep `omp web`. Any other value is used as-is. Restart after changing                                                                                                                               | `omp web`                             |
| `OMP_WEB_OMP_BIN`               | Path to an `ompweb-omp` build to use instead of the downloaded one: a copy of the release's `ompweb-omp-<os>-<arch>` on a machine that cannot reach GitHub, or `runner/release/ompweb-omp-<os>-<arch>` from a source checkout. A stock `omp` does not work: it does not speak ompweb's channel. The service installers write it into the service environment only when you set it | _the downloaded `ompweb-omp`_         |
| `PI_CODING_AGENT_DIR`           | Custom omp agent directory                                                                                                                                                                                                                                                                                                                                                        | `~/.omp/agent`                        |
| `OMP_WEB_STT_ENDPOINT`          | OpenAI-compatible transcription endpoint URL. Leave unset to transcribe with `OMP_WEB_STT_MODEL` through omp's own credentials                                                                                                                                                                                                                                                    | _None_                                |
| `OMP_WEB_STT_KEY`               | Optional API key for the STT endpoint                                                                                                                                                                                                                                                                                                                                             | _None_                                |
| `OMP_WEB_STT_MODEL`             | Model name for the STT endpoint. Without an endpoint: an omp speech-to-text model run with omp's logins, such as `openai-codex/codex-transcribe` (ChatGPT subscription; needs an omp version with that model)                                                                                                                                                                     | _None (disabled without an endpoint)_ |

**`OMP_WEB_NAME` and installed apps.** An installed app (PWA) is usually named after the page it was installed from. If you later change `OMP_WEB_NAME`, or reach omp-web through a different address while `OMP_WEB_NAME` is `url`, `host` or `domain`, your operating system may rename the installed app as well. Leave `OMP_WEB_NAME` empty, or set a name that identifies this omp-web server whatever domain name or address is used to reach it.

## Skipping the password on trusted networks

omp-web cannot see the client's address itself, so it leaves the decision to
your reverse proxy. The proxy sends a secret in the `X-Omp-Web-Auth` header,
and omp-web holds only that secret's SHA-256 digest in
`OMP_WEB_TRUSTED_HEADER_SHA256`. A request whose header hashes to that digest
is treated as signed in. Everyone else still signs in with the password whose
hash is in `OMP_WEB_PASSWORD_HASH`; without a password there is nothing to
skip, and the header is ignored. Keep omp-web bound to `127.0.0.1` so only the
proxy reaches it.

Generate the secret and its digest without typing the secret on a command line,
so it never lands in your shell history. This writes a random secret straight
into an nginx include file readable only by root and nginx, and prints only the
digest:

```bash
secret=$(openssl rand -hex 32)
printf 'map $ompweb_trusted $ompweb_auth {\n    1        "%s";\n    default  "";\n}\n' "$secret" \
  | sudo install -m 0640 -o root -g www-data /dev/stdin /etc/nginx/ompweb-auth.conf
printf %s "$secret" | sha256sum | cut -d' ' -f1
unset secret
```

Use your nginx group in place of `www-data` (`nginx` on some distributions).
Set the printed digest as `OMP_WEB_TRUSTED_HEADER_SHA256`. The command history
holds only the commands, never the secret.

Always generate the secret this way; do not reuse a password or another chosen
value. omp-web stores only a fast, unsalted SHA-256 digest, which is safe only
for a long random secret: anyone who reads the digest could recover a short or
guessable one with a dictionary attack.

With nginx, send the secret only to the address ranges you trust:

```nginx
# http {} context
geo $ompweb_trusted {
    default       0;
    10.0.0.0/16   1;
}
include /etc/nginx/ompweb-auth.conf;  # the map written above

# the location that proxies to omp-web
proxy_set_header X-Omp-Web-Auth $ompweb_auth;
```

Always set the header, as above: the empty value for other clients replaces any
`X-Omp-Web-Auth` a client sends itself. nginx only inherits `proxy_set_header`
from outer blocks when a block sets none of its own, so put this line next to
the location's other `proxy_set_header` lines.

Serve omp-web only for its own hostname: give its `server` block an explicit
`server_name`, and add a `default_server` block that answers every other
hostname with `return 444;`. Otherwise a web page that a trusted browser visits
can point its own domain name at your nginx (DNS rebinding) and have nginx add
the secret to its requests.

`geo` checks `$remote_addr`, the address that connected to nginx. When clients
reach nginx through another proxy, use the
[`realip` module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) to
replace it with the real client address. It does so only for connections from
addresses you list in `set_real_ip_from`:

- **Cloudflare (proxied DNS):** trust `CF-Connecting-IP`, and only from
  Cloudflare. List every range from <https://www.cloudflare.com/ips-v4/> and
  <https://www.cloudflare.com/ips-v6/>, and keep them up to date. Use this only
  when Cloudflare is really in front.

  ```nginx
  set_real_ip_from 173.245.48.0/20;  # ...one line per Cloudflare range
  real_ip_header   CF-Connecting-IP;
  ```

  Also refuse connections that come neither from Cloudflare nor from your
  trusted ranges. `$realip_remote_addr` is the address that actually
  connected, before `realip` replaced it:

  ```nginx
  geo $realip_remote_addr $ompweb_peer_allowed {
      default          0;
      173.245.48.0/20  1;  # ...every Cloudflare range
      10.0.0.0/16      1;
  }
  # in the server block
  if ($ompweb_peer_allowed = 0) { return 403; }
  ```

- **Cloudflare Tunnel (`cloudflared`):** the tunnel connects to nginx from
  `cloudflared`'s address (`127.0.0.1` when it runs on the same machine), so
  trust `CF-Connecting-IP` from there: `set_real_ip_from 127.0.0.1;` and
  `real_ip_header CF-Connecting-IP;`. Any local process can then send its own
  `CF-Connecting-IP` to nginx and claim a trusted address, and a local
  connection without that header keeps `127.0.0.1`, so listing `127.0.0.1` in
  `$ompweb_trusted` trusts every local process that connects to nginx.
- **Any other proxy or load balancer:**

  ```nginx
  set_real_ip_from  <proxy address or range>;
  real_ip_header    X-Forwarded-For;
  real_ip_recursive on;
  ```

  `real_ip_recursive on` reads `X-Forwarded-For` from the right and skips the
  hops listed in `set_real_ip_from`. Addresses a client adds itself are
  ignored.

## Development

```bash
# From this fork's checkout:
mise trust
mise install
bun install --frozen-lockfile
bun runner/scripts/use-omp-build.ts && (cd runner && bun install --frozen-lockfile)
bun runner/scripts/build-binary.ts   # ompweb's omp build for this machine: runner/release/ompweb-omp-<os>-<arch>
bun run dev
```

The dev server runs at [http://127.0.0.1:30178](http://127.0.0.1:30178). It finds the runner in
`runner/release/` by itself; `bun run test` and `bun run build:binary` need the runner set up too.

A dev server does not take over the local daemon: only the production web
server writes the daemon's `host.json`, so "This machine" shows offline in dev
and the daemon stays linked to your installed ompweb.

`bun run dev` runs the server with Bun hot reload. `bun run build` bundles the browser app into `dist/`, and `bun run start` serves it on port 30177 (`bun run smoke` checks the result). `bun run dev:lan` binds the dev server to all interfaces. `bun run build:binary` builds the [single binary](#single-binary) for this machine into `release/` (`-- --target bun-linux-arm64` and the like for another platform; `bun run smoke -- --binary release/ompweb-linux-x64/ompweb` checks it).

### Checks

```bash
bun run format:check # bun fmt --check
bun run typecheck    # bun check for the root project and runner
bun run test         # bun test --parallel
bun run release:check # formatting, types, tests, build, and live-session smoke
```

Run `bun fmt` to format files. Linting is intentionally removed: pinned Bun 1.4.4 has no built-in linter, and this project uses neither ESLint nor standalone `tsc`. GitHub Actions are disabled, so run checks locally. The workflow definitions remain in `.github/workflows/` with `.disabled` extensions; renaming them back to `.yml` would reactivate them after pushing.

## License & Credits

- Keylime is derived from [ompweb-dev/ompweb](https://github.com/ompweb-dev/ompweb), which originated from [agegr/pi-web](https://github.com/agegr/pi-web), and integrates [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).
- Thanks to the upstream authors and contributors. Original Git history and the copyright notice in [LICENSE](./LICENSE) are retained.
- Keylime remains [MIT-licensed](./LICENSE). It is an independent project, not an upstream release or an endorsement by its predecessors.
