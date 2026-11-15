# Ship: commit, land or open a PR, clean up

Status: building. Contract: `lib/workspace-ship-types.ts`.

## Flow

A **Ship** button on a linked (non-default) workspace's chat opens one sheet:

1. On open, the sheet requests `shipPreview` (host op) first. Only when preflight reports no blocking Git issues
   does it request `commit_plan` (runner command), which can stage changes.
2. The sheet shows the changed files, the editable commit message(s) (a split plan shows one per commit), the changelog
   files omp will touch, and "N behind <base>" with **Rebase first** (checked when behind).
3. Path: **Land locally** (rebase, fast-forward local base, clean up), **Open PR** (rebase, push, create PR),
   **PR + auto-merge** (same, then `gh pr merge --auto`, squash by default). The PR title and body come from
   `generate_pr_description` and can be edited. **Clean up when done** is checked by default.
4. Ship: `commit_apply` with the edited plan, then host op `startShip`, polled through `shipStatus` with per-step
   progress. Preflight reports unmerged files, in-progress Git operations and potential conflicts with the base,
   including uncommitted changes, using a temporary index without changing the workspace or its index. This merge
   preview cannot predict every conflict in a multi-commit rebase. A rebase conflict aborts the rebase (`conflict`,
   with `conflictFiles`). Both cases offer **Ask agent to resolve**, which submits a prompt directly to the session
   and closes the sheet only when submission succeeds.

## Generation runs in the session (runner commands)

`runner/src/commands/git.ts`, sent through the existing command path (`POST /api/agent/[id]`):

- `commit_plan { context?, changelog? }`: refuses while the session is not settled. Stages everything when nothing is
  staged, then runs omp's commit agent (`runCommitAgentSession`) on the session's own model registry, settings and
  auth storage, with omp's trivial-change and fallback paths. Returns the plan, never commits.
- `commit_apply { plan }`: applies the plan's changelog edits (`applyChangelogProposals`), then creates the commits:
  one commit with the staged tree, or each split group in dependency order with its hunks staged, as omp's own split
  commit does. Messages are used verbatim.
- `generate_pr_description { base, context? }`: one stateless completion on the `commit` role model (the same
  resolution as `omp commit`: `commit`, then `smol`, then chat roles) over the commits, diff stat and diff (60 KB cap)
  of `base..HEAD`, plus the session's first user-attributed prompt on the active branch (4 KB cap) as the reason for
  the change. The rest of the conversation is deliberately not sent: the description is about the outcome, not the
  path that produced it, and the diff wins where it and the request differ. Returns `{ title, body }`; unparseable
  output falls back to the commit log.

Main gives these three commands a long timeout; a timeout never recycles the child.

## Git mechanics run in the host daemon (workspace ops)

`shipPreview`, `startShip`, `shipStatus`, `shipFinish` (`lib/hosts/workspace-ship.ts`). Older daemons answer 501
`workspace_unsupported` through the existing capability list.

- **Base** is the project's default workspace and its current branch (local main). No fetch before a rebase.
- **rebase**: `git rebase <base>` in the workspace; on conflict, `git rebase --abort` and `conflict`.
- **fastForward**: in the default workspace, refused when dirty or not on the base branch; `git merge --ff-only`.
- **push**: `git push -u origin HEAD`, `--force-with-lease` when the branch already has an upstream.
- **createPr / autoMerge**: `gh pr create --base --head --title --body-file -`; `gh pr merge <n> --<method> --auto`.
- **pullBase**: in the default workspace, `git pull --ff-only` when clean and on the base branch.
- **archiveSessions / removeWorkspace**: stop the workspace's processes, archive its registered sessions (children
  first), then `removeRegisteredWorktree` (merged branches are deleted; a squash-merged PR's branch is deleted because
  GitHub reported it merged).

Local: rebase → commit check → fastForward → archiveSessions → removeWorkspace.
PR: rebase → push → createPr → autoMerge (pr-auto). Finish (merged PR): pullBase → archiveSessions → removeWorkspace.

Jobs persist under `<agent dir>/omp-web/ship/jobs/`; a daemon restart marks running jobs `interrupted`.

## Merge watcher

The daemon records each PR it opened (`<agent dir>/omp-web/ship/prs.json`, by workspace path) and checks open ones
with `gh pr view` every 60 s. `HierarchyWorkspace.ship` carries the PR and any running job, so the sidebar pill
(`PR #N · checks`, `Merged · Clean up`) follows the hierarchy refresh. When a PR merges and `cleanup` is set, the
daemon runs `shipFinish` itself; otherwise the pill's **Clean up** does.

## Decisions

- Split commits allowed (omp decides; the user edits each message).
- Changelog updates allowed (omp's proposal, applied by `commit_apply`).
- Squash merge by default; merge and rebase selectable.
- Generation uses the session channel, never a separate omp process.
