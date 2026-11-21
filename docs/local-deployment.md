# Local production deployment

Local deployment uses Pitchfork on macOS and glibc Linux. Run it as the user
that owns the `global/keylime` and `global/keylime-host` services. Both services
run `~/.local/share/keylime/current/keylime`, with web on port 8080 and the
host using `~/.omp/agent` by default. Deployment keeps existing authentication
and service configuration.

`current` must be a symlink to the active release so deployment can switch it
atomically. If `current` is a directory, stop both services during a maintenance
window (stopping the host ends active runs), move the directory to an unused
path under `~/.local/share/keylime/releases/`, and create `current` as a symlink
to that path. Start both services again before deploying.

## Deploy a new version

Commit the source you want to deploy, then run from this checkout:

```bash
mise exec -- bun run deploy:local
```

On this Mac, `keylime-deploy` runs that command from the checkout from any directory.
Use `keylime-deploy --activate <release-directory> --wait` for a staged release.

`keylime-deploy` returns after the independent worker accepts the job. Check
`keylime-deploy --status` for the durable phase, result, candidate, and log path.
The launcher bundles a private snapshot of the worker before submission, so
editing or updating the checkout cannot change an in-flight transaction.

The command exports committed HEAD into a private build directory, installs the
pinned dependencies, and builds the runner and production binary. It never
serves this working tree. Releases stay in `~/.local/share/keylime/releases/`.
After a successful full or frontend-only deployment, the worker keeps the three
newest deploy-generated directories in each of `releases/` and
`frontend-releases/`, plus the active and immediately previous selections. Older
generated directories are deleted. Manually named release directories are left
alone. Cleanup failures are logged without failing the deployment; failed and
recovery deployments do not prune releases.
If the active release has the same committed runner tree and pinned runtime, its
runner binary is reused; otherwise the runner is built from the pinned packages.
Local builds skip the unused release tarball and smoke suite. Preflight still
checks the candidate runner before activation, and activation verifies service
readiness. Run `bun run smoke` separately when needed; deployment no longer checks
the SPA, APIs, or event stream before switching.

Deployment does not generate or validate API documentation. Binary releases include
the checked-in documents, which may be stale; use `bun run api` explicitly when
maintaining them.

Activation gives active runs and protected host work up to 60 seconds to finish.
Use `keylime-deploy --timeout 10` or `mise exec -- bun run deploy:local:fast`
to shorten that grace period to 10 seconds. `mise exec -- bun run deploy:local:fast:follow`
uses the same deadline, streams the deployment log and waits for the worker to exit.
`--timeout` takes positive whole seconds and applies to staged-release activation too.
Confirmed-idle session processes close automatically. At the deadline deployment
continues forcibly: remaining active runs and host operations are terminated.
Deployment runs in a detached worker with file-backed logs, outside the agent's
process group. Closing the terminal or terminating the submitting session cannot
interrupt it. `--wait` observes completion; `--follow` also displays the log. Disconnecting either observer does not cancel deployment.

Older daemons without maintenance controls use the full configured grace period,
then the web service and host process group are stopped for the initial upgrade.

Before switching, the command stops web admission and the host. The directory
symlink switches atomically; web and host restart as separate production processes.
Other host daemons using the same agent directory must be stopped separately before
cutover. Deployment does not back up agent data or service configuration.

Build failures never change the active version. Activation failures before
admission reopens restore the previous selection. Once admission reopens there
is no automatic rollback: new writes may already exist.

## Frontend-only deployment

A frontend-only deployment switches the browser assets without restarting the
web server or host daemon. Open tabs continue running their loaded code; reload
to use the new frontend. The running backend must support the frontend-only
deployment mechanism first, so activate this change once with a normal deployment.

```bash
mise exec -- bun run deploy:local:frontend
```

Frontend-only deployment accepts changes limited to browser components, hooks,
and app files outside `app/api`. Changes to shared code, dependencies, or the
backend require a normal deployment. Existing hashed assets and worker versions
are copied into the new frontend so tabs opened before a switch can still load
them. Those assets can continue to grow even when old release directories are pruned.

## Rollback

Use the prior release path printed by deployment:

```bash
mise exec -- bun run deploy:local --activate /absolute/path/to/previous-release --wait
```

Rollback to earlier builds is not a data-compatibility promise. Maintain an
independent backup before deploying if recovery of agent data is needed. Never
restore a backup over a running agent.
On the original macOS install, upstream is retained at
`~/.local/share/mise/installs/github-ompweb-dev-ompweb/0.7.0/`; original service
and mise config are in the directory named by
`~/.local/share/keylime/initial-backup`. Returning to upstream requires manually
restoring those selections during a quiet window, not bypassing the release check.

Inspect services with `pitchfork status global/keylime --json` and
`pitchfork status global/keylime-host --json`; inspect logs with `pitchfork logs`.
The worker holds a kernel-owned SQLite writer lock; concurrent deployments are
refused and process death releases ownership without stale PID/time expiry.
Each phase is recorded atomically with fsync before its service mutation.
If a worker itself crashes, inspect `--status` and its log, then run
`mise exec -- bun run deploy:local --recover --wait` to start both services at the selected release.
New deployments refuse an unfinished transaction until explicit recovery.
This is a recoverable service transaction, not zero-downtime or a power-loss
atomicity guarantee. Build directories remain for manual disk management.
