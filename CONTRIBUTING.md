# Contributing to omp-web

Thanks for your interest in contributing!

## Setup

- [mise](https://mise.jdx.dev) manages the Bun version pinned in `mise.toml`. No Node or Nix setup is required.

```bash
mise trust
mise install
bun install
bun runner/scripts/use-omp-build.ts && (cd runner && bun install --frozen-lockfile)   # ompweb's omp build; bun run test needs it too
bun run dev   # seeded development server; prints its URL
```

For live sessions, build the runner for this machine with `bun runner/scripts/build-binary.ts`: ompweb finds
`runner/release/ompweb-omp-<os>-<arch>` by itself (`OMP_WEB_OMP_BIN` overrides it). A stock `omp` does not
speak ompweb's channel.

### Development and browser testing

```bash
bun run dev                 # seeded, random free loopback port
bun run dev --port 30278    # seeded, fixed loopback port
```

Each invocation creates a randomly named temporary directory with its own home,
agent configuration, XDG directories, and host socket. The launcher prints its
directory and URL, starts the web server with HMR and a separate hot-reloading
host daemon, and stops both on Ctrl-C or if either exits. Files stay in the
temporary directory after shutdown for inspection; remove it manually when done.

The checkout stays in place so source edits reload normally. Existing projects,
sessions, and stored logins aren't copied. Inherited `OMP_*`, `OMPWEB_*`, `PI_*`,
and XDG settings are cleared, and subprocesses don't load `.env` files. Other
environment variables, including provider API keys, remain available. The runner
uses this checkout's normal discovery; build it as described above for live sessions.

Each run creates two sample projects, including a Git worktree with an untracked
file, three saved conversations, and sample web settings in the temporary home.
It never seeds the normal installation. Git is required; fixture changes are
disposable and retained in the printed directory.

`paseo.json` installs the pinned runtime, dependencies and runner for new Paseo
worktrees. Its `dev` service starts the same seeded environment on Paseo's
allocated port; `test` and `typecheck` are available as named scripts.

## Checks (must pass before submitting)

```bash
bun run format:check # bun fmt --check
bun run typecheck   # bun check for the root project and runner
bun run test        # unit tests (bun test --parallel)
```

Use `bun fmt` to format files. CI and release checks enforce `bun fmt --check`. Linting has been removed: pinned Bun 1.4.4 has no built-in linter, and the project uses neither ESLint nor `tsc`.

`bun run build` bundles the browser app into `dist/` and `bun run smoke`
starts the built server and checks it; the dev server never reads `dist/`.

### React tests

Tests use `bun test` with `node:test`-style `test()` calls; no Jest or Vitest configuration is required.
Mock a Node builtin with `mockBuiltin` (`tests/mock-builtin.ts`, built on `mock.module`) and import the module under test afterwards with a fresh `?fresh=N` query.
For interactive components and hooks, import `tests/setup-dom.ts` before
`@testing-library/react/pure.js` (both imported dynamically, in that order), and register `cleanup` with `afterEach`.
Use DOM queries and `@testing-library/user-event` for component interactions,
and `renderHook` for hook state and lifecycle tests. Keep the real jsdom
`window` and `document`; mock only the browser or network APIs a scenario needs.

Static HTML tests can continue using `react-dom/server`. Layout, scrolling,
and native browser navigation still require real-browser verification.
The jsdom dependency stays on 29.x for now; moving to a newer major is a separate change.

## Conventions

- **Styling**: use the design tokens in `app/globals.css` (colors, radius,
  shadow, motion) — no hardcoded colors. Shared primitives live in
  `components/ui/` (Dialog/Tooltip/Collapsible/field/toast, built on Base UI);
  icons come from `lucide-react`.
- **UI copy**: add user-facing strings in English to `lib/i18n/locales/en.json`.
- **Architecture**: the ompweb server and daemon never import `@oh-my-pi/*` or `@earendil-works/*`
  packages (Bun-only). Live agent features go through the `ompweb-omp` child process
  (`runner/`) over ompweb's channel; see `DESIGN.md` and `AGENTS.md` for the full contract.

## Pull requests

- Keep PRs focused; describe the user-visible change and how you verified it.
- For UI changes, include before/after screenshots in both light and dark
  themes when practical.

## Reporting issues

Please use the issue templates and include your OS, Bun version, omp version,
and browser.
