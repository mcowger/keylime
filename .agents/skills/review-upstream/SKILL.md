---
name: review-upstream
description: Manually review new ompweb upstream changes against Keylime and offer to cherry-pick useful changes. Use when asked to check upstream releases, fixes, or commits for changes worth bringing into Keylime.
---

# Review ompweb upstream

Review changes from `https://github.com/ompweb-dev/ompweb` against this checkout of Keylime. This is a manual, evidence-based review, not an automatic sync. Keylime is an independent, intentionally breaking hard fork: upstream compatibility, Windows, active GitHub Actions, and other features excluded by the repository's current instructions are not goals.

## Discover changes

1. Read the repository instructions and check the current branch and working-tree state. Do not overwrite, stash, or otherwise disturb existing work.
2. Fetch upstream's current default branch and tags without changing `origin`, adding a permanent remote, checking out a branch, or merging. For example, discover the default branch with `git ls-remote --symref https://github.com/ompweb-dev/ompweb.git HEAD`, then fetch that branch with `git fetch --no-tags https://github.com/ompweb-dev/ompweb.git <branch>` and record the resulting `FETCH_HEAD` SHA immediately. Fetch tags only when needed for release comparison; avoid overwriting local tags. If the network or history is incomplete, report the limitation instead of presenting a partial review as complete.
3. Find the merge base with the recorded upstream SHA. If none exists or history is shallow, explain that the baseline is uncertain; do not assume all upstream commits are new. Enumerate commits since the common base and use `git cherry -v HEAD <upstream-sha> <merge-base>` to identify patch-equivalent commits. Inspect upstream release notes or tags as useful context, but review commits after the latest release too. State the compared SHAs and range.
4. Patch equivalence is only a filter: a fix may have been adapted, squashed, partially applied, or independently implemented in Keylime. Inspect the relevant upstream diffs, surrounding code, Keylime history and tests before deciding whether a behavior is missing. Group related commits into coherent changes, including prerequisites and follow-up fixes. Do not classify a commit solely from its title or release notes.

## Assess and present

For each substantive candidate, identify the upstream commit SHA and link, the behavior and affected Keylime code, evidence it is missing or already covered, user benefit, dependencies, and risks or conflicts with Keylime's architecture and hard-fork policy. Distinguish clean cherry-pick candidates from changes requiring adaptation. Note relevant security, data-integrity and license implications. Explain uncertain findings and any review limits.

Present a concise prioritized list with **recommend**, **optional**, and **skip/already covered** decisions as applicable. Link commits as `https://github.com/ompweb-dev/ompweb/commit/<sha>`. Explicitly offer to cherry-pick or adapt the recommended changes, identifying each selectable candidate. Do not cherry-pick, merge, alter files, or create a branch during the review without the user's explicit selection and approval.

## Apply only selected changes

After approval, inspect the working tree and relevant diffs again. Apply only the selected commits and required dependencies, preserving attribution and license notices. Use `git cherry-pick -x <sha>` where appropriate; if a direct pick would undo fork decisions or is unsuitable, adapt the change instead and record upstream provenance in the commit message. Never rewrite published history or silently include unrelated upstream changes. Resolve conflicts against Keylime's current contracts, not upstream compatibility assumptions. If a conflict or dirty working tree makes safe application unclear, stop and report it without discarding user work. Run the narrowest relevant checks, update applicable documentation, and report what was applied, adapted, skipped, and verified.
