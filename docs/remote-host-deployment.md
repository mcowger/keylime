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
checkout. Use the same Keylime build as the FE. To pick a different unpacked
release that includes its runner, pass `--release`:

```bash
mise exec -- bun run deploy:host you@worker.example.com --release release/keylime-linux-arm64
```

The script is for first installs under an SSH user with the default agent
directory. It won't overwrite existing installs or host configuration. Verify
the result in **Settings → Hosts**: the host should show `online`. See the
manual steps below for token revocation, service logs, and troubleshooting.

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
   sessions, or logins. Configure provider credentials on the host, or enable
   **Use this server's provider logins** only if you trust the host with those
   credentials. For shared logins, the proxy must also pass
   `/api/hosts/broker/v1/` requests with the host's `Authorization` header and
   without browser authentication, redirects, or response buffering.

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
