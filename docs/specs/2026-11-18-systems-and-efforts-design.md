# Systems and Efforts

A System describes which repos and services make up an application. An Effort is one feature or fix in that System. An Effort has its own branch in every member repo, working directory, chats, and service terminals.

## Systems

A System lives on one Keylime daemon. Its paths are on that host whether it's this machine or a linked host. No cluster placement or cross-host assembly.

Select existing Git checkouts from Repos or browse that host's filesystem. A checkout has one canonical Repo record on its daemon and can belong to several Systems. A System-only Repo is not shown under standalone Repos. Removing a standalone row hides the Repo while it is referenced instead of unregistering it. A System stores named service commands and the text for `AGENTS.md`. Archive and restore the System without affecting its Efforts; an archived System cannot create new Efforts.

## Create an Effort

Preview the paths, branch, and starting ref for each member repo. Use each repo's detected default base unless the user selects another. Capture the resolved starting commits before creating anything. Derive stable, validated slugs from the names; names can change later without moving directories or renaming branches. Reject existing targets or branches; don't reuse them. The daemon's configurable worktrees root defaults to `~/workspace/keylime-worktrees`. Root changes apply only to new Efforts.

```text
~/workspace/keylime-worktrees/sigma/fix-login/
  AGENTS.md
  repomap.md
  repo-a/
  repo-b/
  repo-c/
```

Each member gets a `sigma/fix-login` branch. Keylime uses built-in Git worktree creation for the required paths, even if the Repo has a custom create command. Warn before skipping such a command. Retain the other configured setup hooks and Paseo setup. Register members with their canonical Repo, and register the Effort root for terminal, chat, and file access without adding a standalone Repo row.

Capture the membership, service definitions, and instructions at creation. Subsequent System changes don't alter existing Efforts. Write `AGENTS.md` at the root, preserving the user-written body and adding a reference to `repomap.md`. The generated map lists each Repo, its relative path, branch, and selected base. It does not scan code or include remote URLs. Never regenerate files over the user's edits.

Creation is a durable daemon job, not a cross-repo transaction. Show progress and errors per member. Preserve worktrees that were already created. Retry incomplete setup explicitly; inspect existing work before retrying, and don't automatically repeat confirmed successful commands. If an interruption leaves a command's outcome unknown, display that uncertainty before rerunning it. Do not auto-start services until every member's blocking setup has succeeded.

## Work in an Effort

Systems appears alongside Repos in the sidebar. Select a System and then an Effort to see its member checkouts, chats, setup status, and services. Start Effort chats at the non-Git root and let OMP discover context. Keylime does not pick one repo's Git target or OMP launch profile for a root chat.

Run each named service command in its own PTY at the Effort root. Commands run as the daemon user, from the saved configuration; no model-facing command runner is added. Pass `KEYLIME_SYSTEM_ID`, `KEYLIME_SYSTEM_NAME`, `KEYLIME_EFFORT_ID`, `KEYLIME_EFFORT_NAME`, `KEYLIME_EFFORT_ROOT`, `KEYLIME_SERVICE_ID`, and `KEYLIME_SERVICE_NAME`. Each service has separate output and Start, Stop, and Restart controls. A running process is not a readiness check. The command owns dependencies, ports, and foreground process lifetime. Browser and web-server disconnects don't stop services. A daemon restart leaves them stopped until explicitly started.

## Cleanup and Ship

Preview running processes, dirty files, branch publication status, and open PRs before cleanup. Stop-only leaves worktrees and chats intact. A force confirmation may discard dirty, staged, and untracked files in the identified member worktrees. It never removes branches, pushes anything, closes PRs, or recursively removes unexpected files from the Effort root. Clean removal also keeps branches and PRs. Fence new starts and archive chats before deleting their checkout. If cleanup fails midway, show what remains and let the user resume cleanup.

The daemon refuses standalone deletion and standalone Ship of member worktrees, including local land and manual/automatic PR finish. Only Effort cleanup may remove them. Both member Ship and the planned coordinated PR batch are out of scope for this release. Standalone Repos retain their existing Ship behavior.

## Implementation and verification

1. Define shared schemas and wire the authenticated browser API through the existing host link. Store Systems, Effort plans and progress on the daemon. Keep Repo visibility separate from canonical identity.
2. Reuse daemon workspace setup, hierarchy, archive, PTY, and process-fencing code for creation, service controls, and cleanup. Publish only root and member paths the daemon has checked. Preserve recorded paths across restart and refuse to adopt unrelated or replaced checkouts.
3. Add the sidebar and Effort workspace controls: System settings, host-scoped Repo picker, base preview, setup status/retry, root chat, independent service tabs, and explicit cleanup. Keep the standalone Repo views unchanged.
4. Exercise creation against multiple Git repos and two simultaneous Efforts, setup and cleanup failure, commands and terminal lifecycle, hidden Repo records, the Ship/deletion fence, and desktop/mobile navigation in the seeded app. Regenerate the API descriptions from the canonical contracts.
