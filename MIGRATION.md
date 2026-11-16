# Moving from ompweb to key lime

key lime is an incompatible hard fork, not an in-place upgrade of ompweb. The
rename does not migrate existing installations, and moving data does not guarantee
that older formats or protocols will work. Before deploying, inventory the existing
installation, stop affected services, and keep a backup. Do not overwrite an
existing destination without checking its contents.

- Agent-directory data and settings previously named `omp-web` or `omp-web-*`, including host links, credentials-related secrets, registries, SQLite databases, archives, uploads, deployment state, and runner caches. Preserve ownership and permissions.
- Browser storage: localStorage, sessionStorage, IndexedDB, service-worker registrations and caches. Drafts, preferences, upload proofs and unsent outbox entries can otherwise remain under old names. Drain or preserve pending messages and uploads before cutover.
- Environment variables, trusted headers, scripts, shell aliases, executable paths, package names, service units and launchd labels. Update deployment automation and monitoring together.
- Host daemons and web servers must be upgraded together when renamed protocol identifiers or paths differ. Check each remote host's configuration and reconnect it before resuming work.
- Authentication cookies and trusted headers change names. Existing browser sessions will need to sign in again; coordinate the cutover with pending browser outbox entries.
- Build and release assets, runner binaries, checksums and download locations must match the names published for the target release. Upstream omp dependencies and genuinely upstream release sources remain separate from Keylime's own artifacts.
- Update reverse proxies, external integrations, bookmarks and API clients where they refer to renamed endpoints, headers or filenames. Verify authentication and file permissions after cutover.

This is an operational checklist, not an automatic migration or a complete inventory of a particular installation.
