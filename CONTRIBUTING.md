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

Worktrees created with the repository's Paseo setup copy ignored `runner/vendor/` packages from the source checkout before setup. If those packages are missing or do not match the worktree's pin, run `bun runner/scripts/use-omp-build.ts` and then install the runner dependencies. The runner binary is not built during worktree setup; `bun run smoke` builds it before running the smoke checks.

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

API documents are generated before development services start and regenerated when
watched API source changes. A generation failure blocks startup or stops the dev
cycle rather than allowing it to continue with stale contracts.

`paseo.json` installs the pinned runtime, dependencies and runner for new Paseo
worktrees. Its `dev` service starts the same seeded environment on Paseo's
allocated port; `test` and `typecheck` are available as named scripts.

## Checks (must pass before submitting)

```bash
bun run format:check # bun fmt --check
bun run typecheck   # bun check for the root project and runner
bun run test        # unit tests (bun test --parallel)
```

Use `bun fmt` to format files. Local release checks enforce `bun fmt --check`. Linting has been removed: pinned Bun 1.4.4 has no built-in linter, and the project uses neither ESLint nor `tsc`.

`bun run build` bundles the browser app into `dist/` and `bun run smoke`
starts the built server and checks it; the dev server never reads `dist/`.

### Generated API contracts

The shared TypeBox schemas in `lib/api-contracts` and their inferred types are the
canonical source for API boundary shapes. Consumers must import those types rather
than duplicate inline response, command, or event DTOs. Derive local projections
with `Static`, `Pick`, `Omit`, or schema composition. Implementation-only types and
narrowing of untrusted headers may remain local. Production parsers retain their
existing behavior; do not add request validation merely to generate documentation.

```bash
bun run api:generate  # validate and write docs/api/*.json
bun run api:check     # validate documents, handler bindings and checked-in freshness
bun run api:bootstrap -- lib/example.ts ExampleType AnotherType
```

The bootstrap command uses TypeBox Codegen on selected TypeScript declarations and
writes a proposed conversion to stdout. Review imported dependencies, optional vs
nullable properties, binary payloads and parser-specific constraints. Its output
becomes maintained TypeBox source, not a regenerated copy of an old type definition.
Remove the old structural declaration and infer its type from the schema. Use LSP
references when migrating exported types. The compiler API is used in-process for
source analysis; `bun check` remains the project's typechecker.

When API behavior changes, update the source schemas, semantics, and annotations,
regenerate and commit the generated documents, and run `bun run api:check` before
delivery. Generation also runs automatically for standalone builds and runner/binary
generation; failures block those builds. Source deployment preparation generates
contracts even for cached runner and frontend-only candidates, before live cutover.
Activation and recovery of prebuilt releases and installed runtime use do not need
compiler tools.

Maintain shapes, field descriptions, examples and constraints inline in the canonical
TypeBox declarations. Every exported `*Schema` needs an intended-use description;
document important property units, ownership scope, omission/null meaning and
cross-field or lifecycle constraints. Do not put schema documentation in a later
metadata mutation block: a composed schema may already have copied the old metadata.

Each exported HTTP handler's own JSDoc must contain `@apiContract <operationId>`
and all five semantic sections: `@apiUsage`, `@apiInputs`, `@apiInvariants`,
`@apiEffects`, `@apiRecovery`. The generator extracts multiline section text into
OpenAPI descriptions and `x-client-semantics`; neighboring handlers never inherit
each other's comments. `HttpOperation.description` adds endpoint-specific details,
not a replacement for the source usage contract. Generation checks bindings against
registered routes and handler methods without evaluating the route modules.

Host, runner and browser operation descriptions require the same five sections as
`Usage:`, `Inputs:`, `Invariants:`, `Effects:` and `Recovery:`. Describe actual client
obligations: admission versus completion, whether reads spawn a process, path/ID
ownership, snapshot validity, destructive effects and what to do after uncertainty.
Never recommend blind retries of possibly delivered mutations. Shared wording must
reflect a genuinely shared implementation guarantee, not generic filler. Transport
descriptions additionally explain framing, sequencing, replay and authentication.
Never hand-edit the generated OpenAPI/AsyncAPI documents. `release:check` includes
`api:check`; GitHub Actions remain disabled.

Generated client-facing artifacts:

- `docs/api/web-http.openapi.json`: every registered HTTP handler, including JSON,
  form-data, binary, range, HTML, NDJSON and SSE responses. Handlers are bound to
  source operation metadata by method-specific `@apiContract` annotations.
- `docs/api/host-http.openapi.json`: the daemon-facing HTTP subset, including
  authenticated upgrades, cluster files and allow-listed credential forwarding.
- `docs/api/host-link.asyncapi.json`: all host operation request/reply exchanges,
  daemon events, multiplexed child channels, upload and result binary framing.
- `docs/api/browser-link.asyncapi.json`: accepted browser/native commands and
  replies, every subscription selector and event family, uploads and resume.
- `docs/api/runner-channel.asyncapi.json`: local runner commands, replies, UI/tool
  callbacks and events over NDJSON stdio or the private Unix socket. Directions
  here are from the host's perspective; WebSocket documents use the web server's.
- `docs/api/contracts.schema.json`: reusable language-neutral schemas and logical
  operation arguments/results for non-TypeScript tooling.

Generation rejects missing route/method annotations, missing or duplicate host and
runner command contracts, drift in host argument names, and documented browser
commands that disagree with dispatch. Statically emitted runner frames and
`@apiEvent` names must have a schema. `@apiCommand`/`@apiEvent` annotations belong
at command handlers and event producers; keep semantic descriptions on their
canonical TypeBox schemas. Document-level checks resolve references and validate
OpenAPI, AsyncAPI and JSON Schema. These checks cannot infer arbitrary runtime
business rules from implementation code; review descriptions when behavior changes.

The generator rebases recursive resources and local definitions, and translates
TypeScript `undefined` into JSON omission (object properties) or `null` (tuple
positions). Native runner messages retain `id`/`name`/`arguments` tool-call fields;
parsed HTTP conversation models use normalized `toolCallId`/`toolName`/`input`.
Do not accidentally use a display DTO to describe the runner wire.

Open shapes remain only where data is genuinely extensible: provider/tool/plugin
JSON, future message compatibility and external auth-broker payloads forwarded
without interpretation. A native app normally uses the web HTTP and browser-link
contracts, not the daemon link. Generated models do not implement sequencing,
replay, ownership fences or reconciliation; those semantics are emitted from
source descriptions and must be implemented by the client.

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
