# ompweb fork memory

## User intent

This is Matt Cowger's hard fork. Upstream compatibility and migration paths are not goals; prefer clean cutovers while preserving security, data integrity, and license obligations. Bun is the sole runtime for package installs and development; native compiled releases remain supported.

Runtime management is exclusively mise. `mise.toml` pins Bun; use `mise trust && mise install` and `mise exec -- bun <args>` without shell activation. Nix packaging/support is removed; do not reintroduce it.

Windows is permanently out of scope. Support only macOS and Linux; do not reintroduce Windows services, build targets, path/UNC/drive handling, or platform test accommodations. Keep native OMP profile validation restrictions, which OMP enforces on every platform.

System tray integration is removed on all platforms. Do not reintroduce tray processes, icons, desktop autostart, or desktop bus integration. Keep Linux systemd and macOS launchd service registration, with separate web and host processes.

Password protection is optional on every bind address, including `0.0.0.0`. Do not require authentication to expose a server or force loopback when clearing a password. Users own network access policy; retain configured password validation, origin checks, and secret isolation.

Use `bun run typecheck` for native Bun checks of both the root project and runner. Use `bun fmt` to format and `bun fmt --check` to check formatting. The user approved a full-repository reformat; CI and release checks enforce formatting. Linting is removed by explicit user choice: pinned Bun 1.4.4 has no built-in linter, and ESLint and `tsc` are not used.

Bun-only conversion verification: Bun 1.4.4 selected through mise; typecheck passed; 106 focused tests passed (10 skipped); client production build succeeded. Lint reported seven unrelated React-hook warnings and one unused fixture import; the import was removed and that file's lint passed. Live-session smoke requires building `runner/scripts/build-binary.ts` first, not only fetching runner dependencies.

After building the runner, the full smoke scenario passed with PATH restricted to Bun plus system directories (excluding the installed Node runtime): launcher, SPA/assets, host link, session discovery, live runner get_state, SSE, and shutdown.

## Architecture to preserve

- React SPA (`app/client.tsx`, `components/`, `hooks/`) served by Bun (`server/`). The launcher and host daemon also run on Bun. The web server and daemon remain separate processes.
- Live work follows browser → Bun web server → linked `ompweb host` daemon → `ompweb-omp --headless`. The daemon owns session processes. A web restart does not end runs; a daemon restart does. Even `local` uses the host link, not a direct web-server spawn/filesystem fallback.
- `runner/` is the only OMP SDK integration boundary. Server/daemon code must not import `@oh-my-pi/*` or `@earendil-works/*`. A stock installed `omp` cannot replace `ompweb-omp`: there is no RPC fallback.
- OMP owns sessions, native queues, agent behavior, provider credentials, and persisted history. Read JSONL through the existing readers; route live mutations through the runner. Never access OMP's auth database directly.
- The browser worker multiplexes tabs/channels over one WebSocket, with SSE fallback. Add channels, not EventSources. Browser-link and host-link acknowledgements prove transport delivery, not native prompt acceptance.
- Existing-session sends use the implemented durable outbox: browser IndexedDB, server SQLite, FIFO dispatch. Unknown delivery stays visibly uncertain; do not blindly retry. OMP's queue chips are separate from held outbox bubbles.
- Workspace files, Git/worktrees, watches, and uploads belong to the owning daemon. Keep host/cwd/source-session identity on tabs and caches. Remote paths mean nothing on the web server's disk.
- Cluster UI uses the first pool, with `local` as master. Remote membership implies master credential sharing and mirrored configuration, including executable hooks/plugins and secrets. Joining is a trust decision, not just scheduling. Standalone remote-host configuration support remains limited.
- File authorization, credential exclusions, canonical-path confinement, origin checks, and upload ownership/proofs are security boundaries. The app is not an unrestricted file browser or an internet multi-user service.

## Customization map

- Palette, typography, shape, spacing, motion: `app/globals.css`; shared controls: `components/ui/`. Existing semantic design tokens, Base UI, and lucide icons are the convention. Preserve light/dark contrast, keyboard focus, mobile touch targets, and reduced motion.
- Layout/navigation/tabs and preference plumbing: `components/AppShell.tsx`; project/session tree: `components/SessionSidebar.tsx`; file tree/viewer: `components/FileExplorer.tsx`, `components/FileViewer.tsx`.
- Composer and controls: `components/ChatInput.tsx`; chat layout/transcript: `components/ChatWindow.tsx`, `components/MessageView.tsx`; lifecycle/reconciliation: `hooks/useAgentSession*`.
- Composer-attached todo/subagent/side-question panels: `components/ComposerPanels.tsx`. Keep them separate from the scrolling transcript unless deliberately changing that contract.
- User-facing strings belong in the English dictionary: `lib/i18n/locales/en.json`.
- Web preferences and native OMP settings are distinct. Reuse current storage conventions rather than introducing a second settings system.
- Edit, fork, and historical branch viewing are different operations. Preserve drafts, attachments, pending transcription ownership, and native history identity when changing chat UX.

## Development workflow

- `bun install`; fetch runner dependencies with `bun runner/scripts/use-omp-build.ts`, then `(cd runner && bun install --frozen-lockfile)`.
- Build the local runner with `bun runner/scripts/build-binary.ts` for live sessions. `OMP_WEB_OMP_BIN` can point at a compatible runner, not stock omp.
- `bun run dev`: port 30178, Bun HMR. Dev deliberately does not bootstrap/take over the production local daemon. Missing local live sessions in dev can be expected, not a reason to change production host registration.
- `bun run build` builds the SPA into `dist/`; `bun run start` serves production on 30177; `bun run smoke` exercises a built server plus daemon using a throwaway home.
- Tests require `bun test --parallel`, including multi-file subsets, for module/global isolation. Use narrow checks for changes; real-browser verification is needed for layout/scroll/navigation. No install, build, tests, or runtime verification was performed during this documentation review.
- CONTRIBUTING.md describes an optional graphify pre-commit setup. Its rebuild reads the whole working tree, so partial commits require care.

## Fork distribution risks

- Review baseline: `package.json` says `@kahme247/ompweb` version `0.7.0`, repository `ompweb-dev/ompweb`, MIT. Preserve required license/attribution, including historical `agegr/pi-web` provenance.
- `lib/release-repo.ts` derives the runner/binary release repository from `package.json.repository`. Renaming that field also changes where runner assets are fetched; it is not merely cosmetic metadata. Each install expects matching-version runner assets and checksums.
- The OMP integration source is a separate pin: `runner/omp-build.json`. At review it names `ompweb-dev/oh-my-pi`, tag `v18.20.0-int.202611131515.g11d9dc7`. This is newer than the example current-state pin in the build design.
- Release workflows may re-pin to the newest integration build without committing the bump. A fork must deliberately choose its runner source, release assets, update channels, package identity, and trusted-publishing configuration before shipping. Do not assume upstream publishing permissions.
- OMP updates with ompweb; it is not a separate in-app updater. Web-server updates and per-host daemon updates are separate operations.
- Shared `~/.omp` state, daemon registration, service names, and ports need deliberate isolation if fork and upstream will run side by side. This review did not establish a side-by-side deployment plan.

## Reading map and documentation drift

Read/reviewed: English README; translated README coverage; CONTRIBUTING.md; DESIGN.md; current changelog; docs/worktrees.md and docs/release.md; specs covering runner/integration build, daemon/remote hosts, Bun migration, browser/host links, uploads, remote workspaces, outbox, multi-server hosts, credentials, cluster/configuration, warm UI, notifications/history. Several focused reviews were delegated and synthesized. Implementation plans are historical task lists, not proof of current runtime behavior.

Use current source and newer specs to resolve contradictions:

- `docs/specs/2026-11-12-omp-runner-design.md` supersedes stock OMP RPC designs. Link protocol is 11 in current project guidance, not the versions in older specs. `rpc-*` filenames do not imply RPC mode still runs.
- The outbox spec still labels itself proposed, but `lib/message-outbox.ts` implements server storage/dispatch, with startup and command handlers. Do not classify the feature as absent from that stale status label.
- Multi-server daemon channels are implemented: `lib/hosts/daemon-channels.ts` has per-link members, reply ownership, shared requests/lifecycle, and history-edit ownership. Older prospective wording is not evidence of absence.
- Next.js/next-font guidance in the warm-UI design is historical. Current UI conventions are the React SPA, self-hosted fonts, Base UI, cmdk, and semantic CSS tokens.
- The retired browser experiment's `ws-*` modes are superseded by `ws`/`sse`, default `ws`.
- Notification JSON storage is superseded by SQLite. Current project guidance gives notifications their own multiplexed channel, not the old proposal to piggyback on running-session events.
- The changelog labels v0.7.0 with a future-relative date of 2026-11-14 at this review. Treat that as documentation metadata, not proof a release is published.

Review date: 2026-11-13. Recheck changing versions and shipping behavior before relying on these notes for implementation.
