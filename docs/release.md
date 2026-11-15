# Release Checklist

Keylime is an independent hard fork. The inherited package name
`@kahme247/ompweb` and upstream release URLs do not publish this fork's changes.
All GitHub Actions workflows are disabled; pushing a tag does not start a build
or publish a release. Do not re-enable them as part of local verification.

## Local release verification

From the checkout containing the intended release changes, install the pinned
Bun runtime and dependencies and set up the runner as described in
[CONTRIBUTING.md](../CONTRIBUTING.md). Update API source schemas, semantics and
annotations when behavior changes, regenerate and commit the API documents, and
run the local release checks before delivery:

```bash
bun install --frozen-lockfile
bun run api:check
bun run release:check
```

`release:check` includes API freshness, formatting, typechecking, tests, the
production build and smoke checks. `bun run smoke` builds the runner first.
Standalone builds and runner/binary generation
also regenerate the API documents and fail if generation fails. Source deployment
preparation does likewise before service cutover, including cached and frontend-only
candidates; activation and recovery of prebuilt releases and installed runtime use
do not require compiler tools. Development generates at startup and after watched
API source changes, and generation failures block the dev cycle.

Release publication is not automated by this repository. Verify any publication
procedure and destination separately; inherited upstream release settings are not
instructions for publishing Keylime.

### Build identity in the UI

Click or tap the ompweb logo to reveal the package version. If the build's
Git `HEAD` has no tag, the reveal also shows the full commit hash and the
committer date in `YYYY-MM-DD` format. Any tag pointing exactly at `HEAD`
keeps the version-only display; a tag on an ancestor does not.

Both the production build and development server resolve this metadata from
the source checkout, ignoring inherited repository-location overrides. Explicit
`safe.directory` trust from Git's configured files or `GIT_CONFIG_COUNT` is preserved.
The metadata is bundled into the client, including in npm packages and binary
releases; no Git command runs when a user clicks the logo.
Source archives without Git metadata keep the version-only display.

The development bootstrap initializes missing browser constants once. Empty
commit fields are valid, and later hot reloads keep the existing listener.
