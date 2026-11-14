# Local production deployment

This Mac uses Pitchfork's `global/ompweb` and `global/ompweb-host`, port 8080,
existing password authentication, and `~/.omp/agent`. Both services use
`~/.local/share/keylime/current/ompweb`. Mise's `keylime-local` tool points at
that same stable directory. In-app updates are disabled for both services.

## Deploy a new version

Commit the source you want to deploy, then run from this checkout:

```bash
mise exec -- bun run deploy:local
```

On this Mac, `keylime-deploy` runs that command from the checkout from any directory.
Use `keylime-deploy --activate <release-directory> --wait` for a staged release.

The command exports committed HEAD into a private build directory, installs the
pinned dependencies, builds the runner and production binary, then smoke-tests
that installed candidate with isolated data. It never serves this working tree.
Verified releases stay in `~/.local/share/keylime/releases/`.

Activation requires the production host to own no session processes. An idle but
still-open agent process counts as occupied too. If occupied, the command prints
an activation command and exits 2 without stopping services. Close idle sessions
or let their processes expire, then run the printed command. Add `--wait` to
wait for the host to become empty. Run a waiting activation in a separate terminal,
not inside a session it is waiting to end.

Before switching, it stops web admission, checks the host again, stops the empty
host, and saves the agent directory plus service/tool config under
`~/.local/share/keylime/backups/`. The directory symlink switches atomically;
web and host restart as separate production processes. Other host daemons using
the same agent directory must be stopped separately before cutover.

Build failures never change the active version. Activation failures before
admission reopens restore the previous selection. Once admission reopens there
is no automatic rollback: new writes may already exist.

## Rollback

Use the prior verified release path printed by deployment:

```bash
mise exec -- bun run deploy:local --activate /absolute/path/to/previous-release --wait
```

Rollback to earlier builds is not a data-compatibility promise. Inspect the saved
backup before attempting it. Never restore a backup over a running agent.
The initial upstream installation is retained at
`~/.local/share/mise/installs/github-ompweb-dev-ompweb/0.7.0/`; original service
and mise config are in the directory named by
`~/.local/share/keylime/initial-backup`. Returning to upstream requires manually
restoring those selections during a quiet window, not bypassing the verified
release check.

Inspect services with `pitchfork status global/ompweb --json` and
`pitchfork status global/ompweb-host --json`; inspect logs with `pitchfork logs`.
An interrupted deploy may leave `~/.local/share/keylime/deploy.lock`. Verify no
deploy is still running before removing that directory. Builds and backups are
retained deliberately; review disk use and remove old ones manually.
