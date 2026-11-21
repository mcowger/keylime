# Projects and workspaces

Projects belong to a host. The sidebar shows explicitly registered projects and their workspaces. Workspace menus provide selective import and unregister actions. The hierarchy starts empty, even if older projects or session files exist. Add a project to register its default workspace, then selectively discover and import existing worktrees and sessions. A non-Git project has exactly one workspace.

Click **+** beside a Git project to open a blank chat for a new workspace. The branch button opens a searchable picker with the local default preselected. It offers the default from `origin` separately only when it contains commits missing locally. Expand **Pull requests** for open GitHub PRs, including drafts, when `gh` is authenticated on the project's host. Expand **Other branches** for local and remote-tracking branches without a local worktree. Search looks in all sections, even when they're collapsed.

Send the first prompt to create a worktree on a new branch from your selection. For a pull request, the host fetches the PR head, not GitHub's test merge commit. key lime asks the configured `smol` model to name the workspace and its branch. If naming fails, it uses `Workspace` and a randomly suffixed `workspace` branch. The agent starts after post-blocking commands finish. Post-non-blocking commands can modify files alongside the agent; check **Manage workspaces → View logs** for output and errors. If creation or blocking setup fails, the prompt stays available. For non-Git projects, **+** opens a session in the existing workspace.

Importing sessions finds sessions whose working directory is inside the selected workspace, excluding other workspace roots. App-created sessions and forks register with their workspace. Multiple agents can use the same workspace and files at once; they are not isolated from one another. A missing project or workspace remains registered and visible as unavailable.

Unregistering a project forgets its child registrations without stopping processes or deleting files. Unregistering a linked workspace removes its worktree as described below. The default workspace cannot be unregistered separately from its project. Duplicate imports of the same canonical resource are idempotent, and each resource has one parent.

## Notes and Tasks

Open **Notes & Tasks** from a Repo or System's sidebar menu. The board opens in the workspace area, not a dialog. Keylime keeps the Markdown notebook and four-column task board on the owning daemon, outside Git. Other browsers and web servers linked to the same daemon see the same saved board; it's unavailable while that host is offline.

Enter a one-liner in **Brief**. Select **Improve** to replace it with a fuller prompt, then edit the same field if needed. The planning model receives the Brief, target name, and current task attachments when it supports vision. It doesn't receive checkout contents.

**Launch** saves the current Brief and sends it verbatim as the first message in the Workspace or Effort root chat. Use **Save task** if you want to keep it on the board without launching. Keylime uses the current defaults unless setup needs review. The task links to the resulting work. Merging, deleting, or successfully shipping its Workspace moves the task to **Done**. An Effort task moves to **Done** after all its member workspaces are removed. You can also set the status yourself. Resume failed setup from the task. If Keylime can't confirm whether the first message was sent, open the linked chat to check.

Launch treats the Brief as text, even if it starts with a slash command such as `/rename`. Keylime marks it sent only after the runner confirms the first user message was saved.

Attach PNG, JPEG, GIF, or WebP images to **Notes** or to an individual task. Keylime never sends Notes text or Notes images to models or agents. Launch includes only the task's own attachments, up to 10 images and 5 MiB total.

If an Effort’s base commit or System setup changes before creation, **Resume** shows the updated plan and starting commits for confirmation. It keeps the same launch and saved prompt. Once the daemon has admitted the Effort, **Resume** uses its original setup plan instead.

Use **Delete** on a task card to remove it from the board. Deleting the task doesn't remove any linked Workspace, Effort, or chat. Wait for an active launch to finish before deleting its task.

## Systems and Efforts

Use **Systems → New System** under a host to group existing Git checkouts. Pick registered Repos or browse for a checkout on that host. A System-only checkout doesn't appear under standalone **Repos**. Add named foreground service commands and the content for `AGENTS.md` in System settings.

Use **New Effort** to preview the member paths, bases, and branch. Each member gets a worktree under `~/workspace/keylime-worktrees/<system>/<effort>/<repo>` on that host, with branch `<system>/<effort>`. The **Configure Effort worktrees root** control changes the root for new Efforts. Keylime uses Git for fixed-path creation and keeps the other configured setup hooks. A setup failure leaves the existing worktrees in place; open **Manage** to inspect each member and retry incomplete setup.

The root contains `AGENTS.md` and a generated `repomap.md` with relative checkout paths. Start a chat at the root to work across repos, or open a member in Explorer. System edits apply to new Efforts only. Once blocking setup passes, each service starts in its own terminal. Open, stop, or restart it from the Effort details. Running means the command is still active, not that the app is ready. Start services manually after a daemon restart.

Use **Dismiss output** in Effort details to close an exited service's terminal and free its slot, even if setup failed. This doesn't stop any running service.

Use **Preview cleanup** to review running processes, changed and local files (including Git-ignored files or directories), and available branch and PR information. Stop-only keeps the worktrees and chats. Removing worktrees archives chats and keeps branches and PRs. Worktrees with changed, untracked, or ignored files require **Force remove worktrees**; that action deletes those files. Edited root documents and unexpected root files are kept. Ship is not available on Effort members; standalone Repos keep their existing Ship behavior.

The generated `AGENTS.md` and `repomap.md` at the Effort root don't block cleanup. Keylime removes copies it can verify are unchanged and lists edited or unreadable copies under files left at the Effort root.

See the [Systems and Efforts design](specs/2026-11-18-systems-and-efforts-design.md) for details.

## Chat tabs

Each workspace can have multiple chat tabs alongside its terminals. Desktop shows open tabs and a **Chats** picker for saved conversations. Mobile uses a compact workspace/tab-count button in the header; tap it for open chats and terminals, creation actions and searchable saved chats. Selecting a saved conversation opens its existing tab or adds one. Unsent chats keep separate drafts, including when several belong to the same workspace.

Open saved chats appear as workspace tabs in other clients connected to the same web server and are excluded from their saved-chat picker. Selecting one joins it locally. Closing a tab removes only that client's membership; it does not archive the conversation or clear its draft. A remotely opened tab may be dismissed locally. Open tabs are retained across reloads in the same browser tab; disconnecting removes its memberships once the event connection closes. Resumable WebSocket connections may retain them until their resume window expires. Membership is held by the web-server process, not the host daemon, so clients connected to different web servers do not share it. Terminal processes remain owned by the host daemon.

When a live chat opens a Chromium/CDP browser, its workspace shows a Browser tab. Select it to view the agent's page; multiple pages appear in a selector. Images are captured only while the tab and browser window are visible. Take control enables navigation and input; Return control disables it. Control also releases when the view is hidden, disconnected, or switched to another target. The agent and other viewers can still interact at the same time. Address-bar navigation accepts HTTP and HTTPS URLs; clipboard synchronization and file transfers are not supported. Switching tabs or closing the chat does not close the agent's browser. WebKit, Tern and cmux pages are not shown.

## Held messages

Submitted prompts, follow-ups and steers appear as dimmed messages while key lime holds them for delivery. Their status shows whether they are sending, waiting, waiting for the host, delivering, or not sent. Images and uploaded files remain attached to the held message.

The browser stores a submitted message before clearing its draft. The web server then holds it until the host accepts it, so a host outage does not require leaving the composer open. Messages still waiting on the browser are visible only there; messages held by the web server appear to other clients viewing the session. Once omp has a message, its own queue controls delivery.

Waiting or failed messages can be deleted. Failed messages can also be retried. If delivery is uncertain, the interface asks for confirmation: the original may already have reached omp or may still arrive. Deleting its tracking record does not cancel work already sent to omp.

## Creating a workspace

In **Manage workspaces**, create a workspace from an existing local branch, a remote branch, or a new branch based on a selected ref. Listing branches fetches remote refs. The default base follows the advertised default (preferring `origin`). Without a remote default, key lime checks the configured `init.defaultBranch`, then `main`, `master`, and the current branch. Checkout paths are derived from the branch under the project's sibling worktrees directory; the display name is editable.

New branch names, including local branches created from remote refs, are normalized before creation. For example, `option to Expand only latest thinking` becomes `option-to-Expand-only-latest-thinking`. The panel previews the Git branch and checkout directory; case and valid slash namespaces are preserved. Existing local branches and base refs are used unchanged. Empty normalized names are rejected, and Git validates the resulting branch name.

Open a repo's sidebar actions menu and choose **Repo settings**, or go to **Settings → Repos**, to edit its display name and workspace configuration source. Changes save automatically. The dialog is available on desktop and mobile. Configure manual host creation defaults in **Settings → Hosts**. These settings live on the owning daemon and are shared with other linked web servers; the workspace creation panel creates workspaces and displays job output.

Repo settings also controls the sidebar icon. Upload an image (center-cropped to a square), choose a detected repository icon, or clear the selection to use the repo's initial and a deterministic color. The selection is stored on the repo's host. Discovery looks for icon, favicon, logo and apple-touch-icon files up to five directories below the root, skipping hidden directories, symlinks, Git-ignored paths, `node_modules`, `vendor`, `dist` and `release`. It supports PNG, JPEG, GIF, WebP, ICO and SVG files up to 256 KiB. SVG icons are rendered as images, not inline markup.

### Manual configuration

Manual is the default. Projects inherit the host pipeline unless they have a whole-project override. Custom create commands can delegate to Worktrunk or another worktree manager. Switching to Follow Paseo preserves the saved manual pipeline; switching back restores its use.

If stored creation commands are invalid, the settings editor shows replacement fields instead of loading the old commands. Enter the desired commands and choose **Replace invalid commands**; this replaces the stored pipeline without running it. Repair invalid host defaults in **Settings → Hosts** before replacing an invalid repo override in **Repo settings**. Existing invalid commands are not migrated automatically.

Each pipeline has ordered pre, create, post-blocking and post-non-blocking stages. Commands have no interactive stdin or automatic retries. With no create command, Git creates the worktree. Pre and create commands run in the project directory; both post stages run in the actual worktree. Post-blocking commands finish successfully before the new chat's agent starts; post-non-blocking commands run in the background.

Commands receive `OMP_PROJECT_PATH`, `OMP_WORKSPACE_PATH`, `OMP_BRANCH`, `OMP_BASE_REF`, `OMP_BRANCH_MODE`, and `OMP_CREATE_RESULT`. A create command may write JSON such as `{"path":"/absolute/path"}` to `OMP_CREATE_RESULT`; otherwise the requested path is used. The result must resolve to a linked worktree of the project. The host registers it before post commands run.

The daemon records the captured pipeline, status, and command output. A browser or web server restart does not stop a job; a daemon restart marks it interrupted. A failed pre or create stage leaves any files in place without importing them. A failed or interrupted post-blocking stage leaves the workspace registered and the initial prompt unsent; inspect the logs and repair the workspace before manually starting another chat there. New starts from any linked server are refused while blocking setup is running. A failed post-non-blocking stage leaves the workspace usable, with its failure and logs available; there is no automatic retry.

### Follow Paseo workspace setup

For a Git project, select **Follow Paseo workspace setup**. The canonical recipe is the project's current on-disk root `paseo.json`, including uncommitted or untracked changes. key lime does not import its commands into settings, read a committed Git version, or substitute the target branch's file. Each creation or deletion reads a fresh snapshot from the project checkout on its owning host. A running operation keeps its captured snapshot; subsequent operations see edits without resaving project settings. The preview can be refreshed independently, and saving settings does not run commands.

```json
{
  "worktree": {
    "setup": ["bun install", "bun run build"],
    "teardown": "./scripts/cleanup-workspace.sh"
  }
}
```

Setup accepts a multiline string of individual shell commands or an array of nonempty shell command strings; teardown accepts a multiline shell script or an array. Each nonempty setup line in a multiline string is executed separately, so use one array entry for a compound shell script. Setup commands default to post-non-blocking; project settings can mark individual entries post-blocking. Blocking entries run first in their recipe order, followed by non-blocking entries in their recipe order. If a selected blocking entry changes or moves, creation is refused until its selection is reviewed in project settings. An omitted hook is empty. Missing, unreadable or invalid `paseo.json` blocks the operation rather than falling back to manual commands. Paseo mode bypasses all manual project and host stages and uses built-in Git worktree creation. Keylime does not start Paseo terminals automatically.

Setup receives `OMP_PROJECT_PATH`, `OMP_WORKSPACE_PATH`, `OMP_BRANCH`, `OMP_BASE_REF`, `OMP_BRANCH_MODE`, and `OMP_CREATE_RESULT` and their corresponding `PASEO_PROJECT_PATH`, `PASEO_WORKSPACE_PATH`, `PASEO_BRANCH`, `PASEO_BASE_REF`, `PASEO_BRANCH_MODE`, and `PASEO_CREATE_RESULT` aliases. Teardown receives only the project path, workspace path and branch pairs. Both hooks also receive the native Paseo names `PASEO_SOURCE_CHECKOUT_PATH` (project checkout), `PASEO_WORKTREE_PATH` (linked workspace), and `PASEO_BRANCH_NAME`. Commands are not rewritten; other inherited environment variables remain available. Setup job logs record the recipe path and a SHA-256 fingerprint of the recipe and include manifest. This fingerprint identifies the captured on-disk content, not a Git commit.

An optional `.worktreeinclude` in the project checkout uses gitignore pattern syntax, including `!` exclusions, to select existing Git-ignored local files. Copies happen before setup, use the same relative paths, skip existing destination files, and do not synchronize afterward. Tracked and non-ignored files are not copied. Unsafe paths, symlinks and unsupported selected entries fail setup. A copy or setup failure leaves the registered workspace available for inspection with its failure and job logs; nothing is automatically removed or retried.

Enabling Follow Paseo authorizes setup, teardown, and any scripts or services you explicitly start to run as the daemon's user. This includes uncommitted recipe edits. Commands are not sandboxed, and included files can contain local secrets. Only enable it for Repos you trust.

#### Scripts and services

With Follow Paseo enabled, open the right sidebar and select **Scripts** in a registered Git workspace. On mobile, tap **Show file panel** to open the sidebar. Keylime reads `scripts` from the Repo checkout's current `paseo.json` on the owning host each time you list or launch a command. It does not use the linked worktree's copy or inherit commands into Efforts.

Choose **Run** for a one-shot or **Start** for an entry with `"type": "service"`. Commands must stay in the foreground. **Stop** ends the run and keeps its output. **View output** opens the retained terminal, even after a browser reload. Closing that terminal stops the process and discards the screen. Changing the recipe or switching to Manual does not stop or hide retained runs. A host-daemon restart clears them.

Commands run in the selected workspace using the host account's interactive login shell, like a workspace terminal. Write commands in that shell's syntax; for example, fish does not accept all POSIX shell syntax. They receive `PASEO_SOURCE_CHECKOUT_PATH`, `PASEO_WORKTREE_PATH`, and `PASEO_BRANCH_NAME` (empty on detached HEAD), plus the `PASEO_PROJECT_PATH`, `PASEO_WORKSPACE_PATH`, and `PASEO_BRANCH` aliases and their `OMP_` equivalents.

Services get `PASEO_PORT` on the owning host. Set `port` to an integer from 1 to 65535 for a fixed port, or omit it for an automatically assigned port. An occupied fixed port is refused. If the recipe sets `worktree.servicePorts`, specify an explicit port for each service you start; Keylime does not use the custom allocator.

Services also receive `PASEO_SERVICE_<NAME>_PORT` for themselves and services already running in the same workspace. Names are uppercased and characters outside ASCII letters and digits become `_`; service names must map to distinct variables. Start dependencies first (for Paseo's own recipe, start `daemon` before `app`). Restarting a peer does not change an existing child's environment. One-shots receive no port variables.

**Running** means the command's process is alive, not that the service is ready. Keylime does not proxy traffic, set service URLs, or reserve the port at the OS level after probing. If another program binds it before your service does, check the terminal for the bind error.

## Deleting a workspace

The default workspace cannot be deleted as a worktree. Deleting another workspace is blocked while setup runs. The daemon fences new session starts and finds all daemon-managed processes in that directory or its descendants, including unregistered sessions and processes shared with other servers. Confirm stopping them first; the daemon waits for exit and refuses deletion if a stop fails.

If the worktree is dirty, a separate confirmation asks whether to discard its changes. Declining at this point leaves the processes stopped. A branch merged into the default workspace's HEAD is deleted. A squash-integrated branch is also deleted when merging it into that HEAD would add no changes and produce no conflicts. For other branches, choose whether to keep or delete them. Detection uses the local default workspace's HEAD; update it first if it is behind the merge. After Git removes the worktree, the host unregisters it and its sessions for all linked servers. Session transcripts and artifacts are preserved.

Deleting a worktree or removing it through Ship discards retained terminal screens after Git removes the worktree, even if no processes were running. Cancelling before Git removal keeps Paseo output, including output from runs stopped during deletion.

In Follow Paseo mode, actual workspace removal (including Ship cleanup) runs the current project checkout's `worktree.teardown` after the existing process, dirty-file and branch decisions, but before session archival callbacks or Git removal. Closing a chat, archiving one session, and unregistering a project do not run teardown. The command sequence has a 60-second deadline; failure or timeout preserves the workspace and registration and reports captured output. Teardown logs are persisted with the daemon's workspace job records. Processes and dirtiness are checked again after teardown. There are no automatic retries; cleanup scripts should tolerate an explicit retry. An accepted daemon-owned deletion may continue after a browser or host-link disconnect, so a transport error alone does not prove cancellation.

Teardown must not change the linked workspace's HEAD or branch identity, or the default checkout's HEAD or branch identity used for merge safety. If it does, key lime refuses removal before session archival or Git deletion and preserves the workspace and branches, even if the working tree is clean or an earlier branch-deletion decision was explicit. Inspect the new history and adjust the teardown recipe before retrying; the earlier safety decision is no longer authoritative.

Changing configuration source affects subsequent operations only and never reruns setup automatically. Returning to Manual also disables Paseo teardown for subsequent removals.

## Shipping a workspace

Ship is available from a linked workspace's chat. It checks for Git problems before generating a commit plan, which can stage workspace changes. Review and edit the proposed commit messages and any PR title and description before shipping. The base is the default workspace's current branch; rebase uses that local branch without fetching it first.

Choose **Land locally**, **Open PR**, or **PR + auto-merge**. Rebase is selected by default when the workspace is behind the base. For an existing open PR, auto-merge adopts it without changing its title or body. Auto-merge defaults to squash, with merge and rebase also available. The host watches the pushed commit and merges only when the PR is mergeable and at least one check has passed, with no failing or pending checks. A PR without checks stays open; rerun Ship after pushing a new commit. The host daemon must remain running. If a preflight check or rebase finds a conflict, **Ask agent to resolve** sends the issue to the session.

**Clean up when done** is selected by default. Local shipping cleans up after landing; PR shipping waits for the PR to merge. Cleanup archives registered sessions and removes the workspace and branch, subject to the workspace deletion checks above. The host watches PRs and can also offer cleanup after a merge.

PR tracking and cleanup are bound to the workspace that shipped the PR, not just its path. Records created before workspace IDs were saved are not used for monitoring or automatic cleanup; review and clean up those workspaces manually.

Ship opens over the workspace content, not the whole application. Use the sidebar to switch workspaces while the commit plan, PR description or Ship job runs. Returning to that workspace restores the same edits and progress, even if you open a different chat there. Each workspace and host has its own Ship flow, using the session that opened it.

Background cleanup removes the shipped workspace's chat tabs and refreshes the hierarchy without switching you away from another workspace. Ship preparation and form state survive in-app navigation only, not a full-page reload. Closing Ship discards its browser state and stops progress tracking; it does not cancel runner commands or an already-started host job.

## Interactive terminals

Open terminals from a workspace. Each terminal has its own application tab and shell, starting in that workspace's directory on its owning host. Local and linked hosts use the same daemon-backed terminal path. Terminals share workspace files with its sessions and other terminals.

Switching tabs, closing the browser, or restarting the web server leaves shells running. Reopening the workspace discovers its terminals and restores their retained display. Explicitly closing a terminal ends its shell; stopping the host daemon ends all its terminals. Terminal state is in daemon memory, not durable across daemon restarts.

Terminal queries are answered by the host, including when no browser is connected. Color reports use a daemon-owned palette rather than the browser theme; character-size reports use the PTY dimensions. Pixel-size queries are not enabled. Focus reports reflect whether any connected viewer is focused; a disconnected viewer's focus expires after a short lease.

The browser suppresses generated color and focus replies using xterm 6's internal input service, because its public input event does not distinguish replies from typed or pasted bytes. When upgrading xterm, verify that boundary and test queries with zero, one and multiple viewers.

Workspace deletion includes terminals in its process confirmation and stops them before removing the worktree.

Each daemon allows 32 terminals and retains 2,000 scrollback lines per terminal. Screens resize up to 500 columns by 300 rows. A pathological output burst that leaves more than 16 MiB awaiting terminal parsing stops that terminal to bound daemon memory; ordinary browser or host-link backpressure instead reconnects the display without stopping its shell.
