# Release Checklist

Each release publishes two artifacts:

- npm package: `@kahme247/ompweb`
- GitHub Release: [ompweb-dev/ompweb](https://github.com/ompweb-dev/ompweb)

After the initial bootstrap release, publishing is performed by GitHub Actions
with npm trusted publishing. No npm access token is stored in this repository
or in GitHub secrets.

## Bootstrap history

The initial bootstrap required a one-time publication before npm trusted
publishing could be configured. Subsequent releases use the workflow below.

## One-time trusted-publisher setup

1. In npm, open the `@kahme247/ompweb` package settings and add a **GitHub Actions**
   trusted publisher with:
   - Owner: `ompweb-dev`
   - Repository: `ompweb`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
2. In GitHub, create the `npm` environment for this repository. Add required
   reviewers if releases need approval.
3. Confirm Actions are enabled for the repository.

The workflow at `.github/workflows/publish.yml` requests `contents: write` to
create the GitHub Release and `id-token: write` for trusted publishing. The OIDC
permission lets npm verify the GitHub Actions identity and generate provenance
for the published package.

## Release later versions
Run these from a clean `main` checkout after the release changes are merged.
First update `package.json` and the lockfile for the release version, commit the
change, and review the commit. Set up the runner as described in CONTRIBUTING.md.

```bash
bun install --frozen-lockfile
bun run test
bun run build
git tag vX.Y.Z
git push origin main --follow-tags
```

Pushing the tag starts the `Publish npm package` workflow. It checks out that
immutable tag, verifies the tag matches `package.json`, installs from the
lockfile, runs tests and the production build, and publishes the GitHub Release
and npm package. A rerun can safely finish if the registry already accepted
that version.

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

## Verify

```bash
gh run list --repo ompweb-dev/ompweb --workflow publish.yml --limit 1
curl -fsSL 'https://registry.npmjs.org/@kahme247%2fompweb/X.Y.Z'
```

Confirm the workflow succeeded, the exact package version resolves, and npm
shows the expected provenance link.
