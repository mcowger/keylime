#!/bin/sh
# The four binaries every release and prerelease ships (after `bun run build`), into release/:
# release/keylime-<os>-<arch>.tar.gz, and the four omp runners, runner/release/keylime-omp-<os>-<arch>.
# A prerelease archive holds its runner as keylime-omp beside keylime; with --no-runner (releases) it does not, and
# keylime fetches it from the release instead, which attaches each runner (lib/omp/runner-fetch.ts). Bun
# cross-compiles all of them from one machine.
# The x64 targets name -baseline (no AVX2 needed): in Bun 1.4.4 that is the default x64 runtime too (the
# same bytes), and naming it keeps a later Bun from shipping a -modern one. They keep the plain
# keylime-<os>-x64 names.
set -eu
# The pinned omp packages, then every platform's native addon package, which the runner embeds per target.
(cd runner && bun scripts/use-omp-build.ts && bun install --frozen-lockfile --os='*' --cpu='*' && bun scripts/build-binary.ts linux-x64 linux-arm64 darwin-x64 darwin-arm64)
for target in bun-linux-x64-baseline bun-linux-arm64 bun-darwin-x64-baseline bun-darwin-arm64; do
	bun scripts/build-binary.ts --target "$target" "$@"
done
