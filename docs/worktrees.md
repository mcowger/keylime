# Projects and workspaces

Projects belong to a host. The sidebar shows explicitly registered projects and their workspaces. Workspace menus provide selective import and unregister actions. The hierarchy starts empty, even if older projects or session files exist. Add a project to register its default workspace, then selectively discover and import existing worktrees and sessions. A non-Git project has exactly one workspace.

Click **+** beside a Git project to open a blank chat for a new workspace. Write the first prompt and send it; Keylime asks the configured `smol` task model for a display name and branch name, creates the worktree using the project's setup pipeline, then starts the agent there. The first chat uses the workspace name; later unnamed chats generate their own titles after their first run. The branch gets a random suffix to avoid collisions. No worktree or agent starts before Send. Naming/setup failures keep the prompt available; inspect setup logs through **Manage workspaces**. For non-Git projects, **+** opens a new session in the project's existing workspace.

Importing sessions finds sessions whose working directory is inside the selected workspace, excluding other workspace roots. App-created sessions and forks register with their workspace. Multiple agents can use the same workspace and files at once; they are not isolated from one another. A missing project or workspace remains registered and visible as unavailable.

Unregistering a project forgets its child registrations without stopping processes or deleting files. Unregistering a linked workspace removes its worktree as described below. The default workspace cannot be unregistered separately from its project. Duplicate imports of the same canonical resource are idempotent, and each resource has one parent.

## Chat tabs

Each workspace can have multiple chat tabs alongside its terminals. Desktop shows open tabs and a **Chats** picker for saved conversations. Mobile uses a compact workspace/tab-count button in the header; tap it for open chats and terminals, creation actions and searchable saved chats. Selecting a saved conversation opens its existing tab or adds one. Unsent chats keep separate drafts, including when several belong to the same workspace.

The X archives a saved chat, then removes its tab. Find it under **Archived Sessions** to restore it. If archiving fails, the tab stays open and an error is shown. Unsaved new-chat tabs simply close. Open chat tabs are retained across reloads in the same browser tab; terminal processes remain owned by the host daemon.

## Creating a workspace

For a Git project, create a workspace from an existing local branch, a remote branch, or a new branch based on a selected ref. Listing branches fetches remote refs. Base ref initially selects the repository's advertised default branch (preferring origin), not the currently checked-out feature branch. Without a remote default, it uses main, master, then the current branch. Checkout paths are derived from the branch under the project's sibling worktrees directory; the display name is editable.

New branch names, including local branches created from remote refs, are normalized before creation. For example, `option to Expand only latest thinking` becomes `option-to-Expand-only-latest-thinking`. The panel previews the Git branch and checkout directory; case and valid slash namespaces are preserved. Existing local branches and base refs are used unchanged. Empty normalized names are rejected, and Git validates the resulting branch name.

Open a project's sidebar actions menu and choose **Project settings**, or use **Settings → Projects**, to edit its display name and workspace configuration source. Changes save automatically. The project dialog is available on desktop and mobile. Configure manual host creation defaults in **Settings → Hosts**. These settings live on the owning daemon and are shared with other linked web servers; the workspace creation panel creates workspaces and displays job output.

### Manual configuration

Manual is the default. Projects inherit the host pipeline unless they have a whole-project override. Custom create commands can delegate to Worktrunk or another worktree manager. Switching to Follow Paseo preserves the saved manual pipeline; switching back restores its use.

Each pipeline has ordered pre, create, and post stages. Commands have no interactive stdin or automatic retries. With no create command, Git creates the worktree. Pre and create commands run in the project directory; post commands run in the actual worktree.

Commands receive `OMP_PROJECT_PATH`, `OMP_WORKSPACE_PATH`, `OMP_BRANCH`, `OMP_BASE_REF`, `OMP_BRANCH_MODE`, and `OMP_CREATE_RESULT`. A create command may write JSON such as `{"path":"/absolute/path"}` to `OMP_CREATE_RESULT`; otherwise the requested path is used. The result must resolve to a linked worktree of the project. The host registers it before post commands run, so sessions can start while post setup is running.

The daemon records the captured pipeline, status, and command output. A browser or web server restart does not stop a job; a daemon restart marks it interrupted. A failed pre or create stage leaves any files in place without importing them. A failed post stage leaves the workspace registered and usable, with its failure and logs available; there is no automatic retry.

### Follow Paseo workspace setup

For a Git project, select **Follow Paseo workspace setup**. The canonical recipe is the project's current on-disk root `paseo.json`, including uncommitted or untracked changes. Keylime does not import its commands into settings, read a committed Git version, or substitute the target branch's file. Each creation or deletion reads a fresh snapshot from the project checkout on its owning host. A running operation keeps its captured snapshot; subsequent operations see edits without resaving project settings. The preview can be refreshed independently, and saving settings does not run commands.

```json
{
  "worktree": {
    "setup": ["bun install", "bun run build"],
    "teardown": "./scripts/cleanup-workspace.sh"
  }
}
```

Setup and teardown accept a multiline shell script or an array of nonempty command strings. Commands execute sequentially in the linked workspace. An omitted hook is empty. Missing, unreadable or invalid `paseo.json` blocks the operation rather than falling back to manual commands. Paseo mode bypasses all manual project and host stages and uses built-in Git worktree creation. It supports workspace setup, teardown and `.worktreeinclude`, not Paseo's named scripts, services, port allocation or automatic terminals; the project dialog makes that boundary explicit.

Setup receives `OMP_PROJECT_PATH`, `OMP_WORKSPACE_PATH`, `OMP_BRANCH`, `OMP_BASE_REF`, `OMP_BRANCH_MODE`, and `OMP_CREATE_RESULT` and their corresponding `PASEO_PROJECT_PATH`, `PASEO_WORKSPACE_PATH`, `PASEO_BRANCH`, `PASEO_BASE_REF`, `PASEO_BRANCH_MODE`, and `PASEO_CREATE_RESULT` aliases. Teardown receives only the project path, workspace path and branch pairs. Both hooks also receive the native Paseo names `PASEO_SOURCE_CHECKOUT_PATH` (project checkout), `PASEO_WORKTREE_PATH` (linked workspace), and `PASEO_BRANCH_NAME`. Commands are not rewritten; other inherited environment variables remain available. Setup job logs record the recipe path and a SHA-256 fingerprint of the recipe and include manifest. This fingerprint identifies the captured on-disk content, not a Git commit.

An optional `.worktreeinclude` in the project checkout uses gitignore pattern syntax, including `!` exclusions, to select existing Git-ignored local files. Copies happen before setup, use the same relative paths, skip existing destination files, and do not synchronize afterward. Tracked and non-ignored files are not copied. Unsafe paths, symlinks and unsupported selected entries fail setup. A copy or setup failure leaves the registered workspace available for inspection with its failure and job logs; nothing is automatically removed or retried.

Enabling Follow Paseo authorizes future recipe edits to execute as the daemon's user. Commands are not sandboxed, and included files can contain local secrets. Only enable it for projects and recipes you trust.


## Deleting a workspace

The default workspace cannot be deleted as a worktree. Deleting another workspace is blocked while setup runs. The daemon fences new session starts and finds all daemon-managed processes in that directory or its descendants, including unregistered sessions and processes shared with other servers. Confirm stopping them first; the daemon waits for exit and refuses deletion if a stop fails.

If the worktree is dirty, a separate confirmation asks whether to discard its changes. Declining at this point leaves the processes stopped. A branch merged into the default workspace's HEAD is deleted. A squash-integrated branch is also deleted when merging it into that HEAD would add no changes and produce no conflicts. For other branches, choose whether to keep or delete them. Detection uses the local default workspace's HEAD; update it first if it is behind the merge. After Git removes the worktree, the host unregisters it and its sessions for all linked servers. Session transcripts and artifacts are preserved.

In Follow Paseo mode, actual workspace removal (including Ship cleanup) runs the current project checkout's `worktree.teardown` after the existing process, dirty-file and branch decisions, but before session archival callbacks or Git removal. Closing a chat, archiving one session, and unregistering a project do not run teardown. The command sequence has a 60-second deadline; failure or timeout preserves the workspace and registration and reports captured output. Teardown logs are persisted with the daemon's workspace job records. Processes and dirtiness are checked again after teardown. There are no automatic retries; cleanup scripts should tolerate an explicit retry. An accepted daemon-owned deletion may continue after a browser or host-link disconnect, so a transport error alone does not prove cancellation.

Teardown must not change the linked workspace's HEAD or branch identity, or the default checkout's HEAD or branch identity used for merge safety. If it does, Keylime refuses removal before session archival or Git deletion and preserves the workspace and branches, even if the working tree is clean or an earlier branch-deletion decision was explicit. Inspect the new history and adjust the teardown recipe before retrying; the earlier safety decision is no longer authoritative.

Changing configuration source affects subsequent operations only and never reruns setup automatically. Returning to Manual also disables Paseo teardown for subsequent removals.

## Interactive terminals

Open terminals from a workspace. Each terminal has its own application tab and shell, starting in that workspace's directory on its owning host. Local and linked hosts use the same daemon-backed terminal path. Terminals share workspace files with its sessions and other terminals.

Switching tabs, closing the browser, or restarting the web server leaves shells running. Reopening the workspace discovers its terminals and restores their retained display. Explicitly closing a terminal ends its shell; stopping the host daemon ends all its terminals. Terminal state is in daemon memory, not durable across daemon restarts.

Workspace deletion includes terminals in its process confirmation and stops them before removing the worktree.

Each daemon allows 32 terminals and retains 2,000 scrollback lines per terminal. Screens resize up to 500 columns by 300 rows. A pathological output burst that leaves more than 16 MiB awaiting terminal parsing stops that terminal to bound daemon memory; ordinary browser or host-link backpressure instead reconnects the display without stopping its shell.
