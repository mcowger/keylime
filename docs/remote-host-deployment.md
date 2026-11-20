# Deploy a remote host

Run the installer from a Keylime checkout with the pinned Bun runtime:

```bash
mise exec -- bun run deploy:host you@worker.example.com
```

The installer uses your SSH config, detects the remote OS and CPU, and copies
only `keylime`, its matching `keylime-omp` runner, and their licenses to
`~/.local/share/keylime-host`. It prompts for the FE's HTTPS URL, whether to
enable user autostart, and the host token from **Settings → Hosts → Add host**.
Token input is hidden. The new host needs outbound HTTPS and WebSocket access
to the FE, but no Bun, source checkout, or inbound Keylime port.

On Linux, autostart uses a systemd user service. Boot startup and survival
after logout require linger; an administrator may need to enable it. On macOS,
autostart uses a launchd LaunchAgent. It starts immediately if the account is
logged in to the desktop, otherwise at its next desktop login. If you decline
autostart, the daemon runs in the foreground over SSH until you disconnect
or stop it with Ctrl-C.

The installer defaults to `~/.local/share/keylime/current` if it exists on the
same platform as the target, otherwise `release/keylime-<os>-<arch>` in the
checkout. If that default release directory is missing, it installs the pinned
runner dependencies (including cross-platform native packages), then builds the
target runner, web assets, binary and licenses locally before prompting for
enrollment. Build failures stop deployment before copying anything to the host.
Existing release directories are reused, not rebuilt. Use a checkout matching
the FE's build when building a missing release.

To pick a different unpacked release that includes its runner, pass `--release`.
An explicit directory is never built or replaced:

```bash
mise exec -- bun run deploy:host you@worker.example.com --release release/keylime-linux-arm64
```

The script is for first installs under an SSH user with the default agent
directory. It won't overwrite existing installs or host configuration. Verify
the result in **Settings → Hosts**: the host should show `online`. See the
manual steps below for token revocation, service logs, and troubleshooting.

Each daemon uses its own OMP settings, plugins, environment, and provider
logins for new and recovered sessions. Neither linking nor binary deployment
copies or shares them.

A daemon connects to one controller. One controller can manage several hosts.
For the host-independence upgrade, stop old writers and confirm no restores
are in progress. This release requires link protocol 14 on both sides; use
the host console to update daemons that can no longer connect. Do not replay
old outbox messages or clear filesystem restore claims during the upgrade.

Old `host.json` files with a `links` array are not loaded. On each stopped
daemon, back up that private file and retain only the `url` and `token` for
the controller you want, as a top-level pair. Do not print or share the
token. If its token is unavailable, enroll the host again.
See [host independence](specs/2026-11-20-host-independence.md) for the cutover.

## Deploy a release without SSH

In **Settings → Hosts**, choose **Deploy release** on the target host. The
picker shows each build's time in your browser's time zone and marks the newest.
Pick a build, review it, then choose **Deploy & restart**. The progress bar
tracks the bytes the host acknowledges for the daemon and runner together.
Once both binaries are staged, the dialog switches to **Installing and restarting…**.
Keylime checks both digests and runs preflight on the pair. It refuses a busy
host. Otherwise it keeps backups of both binaries, replaces them, and restarts
the service once.

The list comes from builds already on the web server. It includes matching
native builds from `~/.local/share/keylime/releases/` and the unpacked
`release/keylime-<os>-<arch>/` build under the server's package directory. A
build must contain both `keylime` and `keylime-omp` to appear. If the list is
empty, [build a matching release](release.md#building-binary-archives) on the
web server and reopen it.

For native builds, the catalog uses the timestamp assigned when the build
starts. For unpacked builds, it uses the newer of the two binaries' modification
times.

Deploy from Hosts requires a standalone remote daemon that already supports
release deployment. The web server and its own daemon aren't updated by this
action.

The picker checks OS, CPU, and whether both binaries are present. It doesn't
check whether a build can report deployment status. If you deploy a build
from before managed activation, the daemon can reconnect while the deployment
still shows as unconfirmed, and **Deploy release** may disappear for that host.
Check the installed build before retrying. Use the host console to upgrade
again if the button is gone.

## Stage an individual binary manually

Once the host has a live Keylime link, open **Settings → Hosts**. On the
target host's card, choose **Stage artifact**, select a local binary or runner
for that host's OS and CPU, then submit. The file travels over the managed
link. The daemon must support artifact staging, but the runner doesn't need
to be installed or running. The limit is 2 GiB per file.

On success, copy the path shown in the dialog. The daemon puts the file in
`<agent dir>/keylime/host-artifacts/<upload id>/` without execute permissions.
The upload doesn't replace a binary or restart the daemon. Delete staged copies
when you no longer need them; Keylime doesn't remove them automatically.

The browser waits up to 40 seconds for the final confirmation after upload.
If the dialog can't confirm staging, check the directory it shows on the host
before uploading again.

On a supported standalone remote host, the same dialog offers **Install &
restart** after staging. Select `keylime` or `keylime-omp`, enter the SHA-256
from a trusted copy of that exact binary, and confirm the host and target.
Keylime sends the file you picked, not an automatically selected release.
Before draining, Keylime gives the verified copy 40 seconds to pass `keylime
preflight` with the other installed binary. This catches wrong-platform files
and incompatible daemon/runner pairs without restarting the host.

A busy daemon refuses the install. After restart, the dialog waits for the
host to reconnect and confirm the outcome. Keep the reported backup until
you've verified the host. If the outcome can't be confirmed, don't send
another install until you've checked the host. The operation ID in the dialog
identifies the receipt in `<agent dir>/keylime/host-artifact-activation/`.
The service user must own `<agent dir>/keylime`, and group and other users
must not have write access there. If an older install left it group-writable,
fix its permissions on the host before retrying.

## Install from the host console

From a host console or other shell that isn't owned by the daemon, run this as
the service user (not root). This works with the standalone install in
`~/.local/share/keylime-host` and its systemd user unit or macOS LaunchAgent.

```sh
"$HOME/.local/share/keylime-host/keylime" host install-artifact "$staged_path" \
  --target keylime --sha256 "$expected_sha256"
```

Set `staged_path` to the path shown in Hosts. Get the expected SHA-256 from a
trusted copy of the exact binary, not from the staged file or its archive.
Use `--target keylime-omp` for the installed runner instead. The caller picks a
build for the host's OS and CPU. The command doesn't download artifacts or
change enrollment, and replaces only the selected executable.

The command checks the bytes, refuses a busy daemon, then saves the old binary
at the printed `.backup-…` path, atomically replaces it, and restarts the host
service. Close live sessions and workspace terminals before retrying a busy
refusal. On success, check **Settings → Hosts** for the reconnected host before
deleting the backup. To check runner compatibility, run `keylime preflight`
from the standalone install.

If restart or startup confirmation fails, check `journalctl --user -u
keylime-host.service` on Linux or `~/Library/Logs/keylime-host.log` on macOS.
The command doesn't roll back automatically: the new process might already be
serving work. Before restoring the printed backup over the target, make sure
the service is stopped and no work is running. Then start it again with the
same supervisor. If the command was interrupted before replacement, check
`keylime host status` and use `keylime host resume` if the old daemon is still
drained and no install is running.

If the installed binary doesn't know `install-artifact` yet, run the command
from a separate trusted copy of Keylime that supports it, or from a checkout
on that host with `mise exec -- bun bin/keylime-host.ts install-artifact …`.
Don't execute the staged file itself.

## Manual install

### Copy the binaries

Use the same Keylime build as the FE, compiled for the new host's OS and CPU
(glibc Linux or macOS, x64 or arm64). If your FE uses [local deployment](local-deployment.md)
and runs on the same platform, copy from `~/.local/share/keylime/current` on
that machine. Otherwise use an unpacked release with its bundled runner, or
[build the matching target](release.md#building-binary-archives) on a build machine.

From the machine with the binaries, as the SSH user that will run the daemon:

```bash
host=you@worker.example.com
release=release/keylime-linux-x64  # Set to the matching release directory.
ssh "$host" 'umask 077; mkdir -p "$HOME/.local/share/keylime-host"' &&
  scp -pr "$release/keylime" "$release/keylime-omp" "$release/LICENSE" \
    "$release/native-video-LICENSE.txt" "$release/licenses" \
    "$host":.local/share/keylime-host/
```

`dist/` and the other web assets stay on the FE. Install Git and any tools or
credentials your projects need separately on the new host.

### Link it to the FE

1. In the existing FE, go to **Settings → Hosts → Add host**, give it a name,
   and copy the host token (shown once). Use the FE's HTTPS URL as seen from
   the new host, not a loopback address. A reverse proxy must forward the
   WebSocket upgrade and `Authorization` header on `/api/hosts/link` without
   sending the daemon to a browser login page.
2. SSH in as the same user and run:

   ```bash
   cd "$HOME/.local/share/keylime-host" &&
     ./keylime preflight &&
     ./keylime host login --url https://keylime.example.com &&
     ./keylime host
   ```

   Replace the example URL. Paste the token when prompted, not into the shell
   command. `preflight` checks that the bundled runner starts. `host login`
   saves the token without connecting. The daemon uses it on every reconnect
   until you revoke it. If the token is exposed or you lose it before
   enrollment, use **Revoke** in **Settings → Hosts** and add the host again
   to get a new token.

3. Check that the host shows `online` in **Settings → Hosts**. Expand that
   host in the sidebar and click **+** next to **Repos** to register or clone a
   repo there, then start a chat in its workspace. Linking doesn't copy repos,
   sessions, or logins. Configure provider credentials on the host under the
   account that runs the daemon.

If the host stays `offline`, check the daemon output, the URL and TLS trust from
that host, and the proxy's WebSocket settings. For `omp not installed`, rerun
`./keylime preflight`. For `needs upgrade`, check that the FE and host builds
match. When updating, upgrade the FE first.

### Keep it running after SSH disconnects

The foreground command is for a first check. Stop it with Ctrl-C before starting
it under a supervisor; don't run both copies. Use the same user, home, and agent
directory as enrollment. Start only `keylime host`, not plain `keylime` or the
paired FE/daemon service installers.

On Linux with systemd, run this on the new host:

```bash
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/keylime-host.service" <<'EOF'
[Unit]
Description=Keylime host daemon

[Service]
ExecStart=%h/.local/share/keylime-host/keylime host
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
EOF
loginctl enable-linger "$USER"  # An administrator may need to enable this.
systemctl --user daemon-reload
systemctl --user enable --now keylime-host.service
```

Linger keeps the systemd user manager running after logout and starts it at boot.
Check logs with `journalctl --user -u keylime-host.service -f`. The installer's
macOS LaunchAgent logs to `~/Library/Logs/keylime-host.log`. Without a launchd
job, run `keylime host` in `tmux` to keep it running across SSH disconnects
(not across reboots).
