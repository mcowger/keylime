# Projects and workspaces

Projects belong to a host. The sidebar shows explicitly registered projects and their workspaces. Workspace menus provide selective import and unregister actions. The hierarchy starts empty, even if older projects or session files exist. Add a project to register its default workspace, then selectively discover and import existing worktrees and sessions. A non-Git project has exactly one workspace.

Click **+** beside a Git project to open a blank chat for a new workspace. Write the first prompt and send it; Keylime asks the configured `smol` task model for a display name and branch name, creates the worktree using the project's setup pipeline, then starts the agent there. The first chat uses the workspace name; later unnamed chats generate their own titles after their first run. The branch gets a random suffix to avoid collisions. No worktree or agent starts before Send. Naming/setup failures keep the prompt available; inspect setup logs through **Manage workspaces**. For non-Git projects, **+** opens a new session in the project's existing workspace.

Importing sessions finds sessions whose working directory is inside the selected workspace, excluding other workspace roots. App-created sessions and forks register with their workspace. Multiple agents can use the same workspace and files at once; they are not isolated from one another. A missing project or workspace remains registered and visible as unavailable.

Unregistering a project or workspace forgets its child registrations, but does not stop processes or delete files. Re-registering starts fresh; import any existing children again. The default workspace cannot be unregistered separately from its project. Duplicate imports of the same canonical resource are idempotent, and each resource has one parent.

## Chat tabs

Each workspace can have multiple chat tabs alongside its terminals. Desktop shows open tabs and a **Chats** picker for saved conversations. Mobile uses a compact workspace/tab-count button in the header; tap it for open chats and terminals, creation actions and searchable saved chats. Selecting a saved conversation opens its existing tab or adds one. Unsent chats keep separate drafts, including when several belong to the same workspace.

The X archives a saved chat, then removes its tab. Find it under **Archived Sessions** to restore it. If archiving fails, the tab stays open and an error is shown. Unsaved new-chat tabs simply close. Open chat tabs are retained across reloads in the same browser tab; terminal processes remain owned by the host daemon.

## Creating a workspace

For a Git project, create a workspace from an existing local branch, a remote branch, or a new branch based on a selected ref. Listing branches fetches remote refs. Base ref initially selects the repository's advertised default branch (preferring origin), not the currently checked-out feature branch. Without a remote default, it uses main, master, then the current branch. Checkout paths are derived from the branch under the project's sibling worktrees directory; the display name is editable.

New branch names, including local branches created from remote refs, are normalized before creation. For example, `option to Expand only latest thinking` becomes `option-to-Expand-only-latest-thinking`. The panel previews the Git branch and checkout directory; case and valid slash namespaces are preserved. Existing local branches and base refs are used unchanged. Empty normalized names are rejected, and Git validates the resulting branch name.

Configure host creation commands in **Settings → Hosts**. **Settings → Projects** lists registered projects and edits their display names and optional whole-project command overrides. These settings live on the owning daemon and are shared with other linked web servers; the workspace creation panel only creates workspaces and displays job output.

Each pipeline has ordered pre, create, and post stages. Commands have no interactive stdin or automatic retries. With no create command, Git creates the worktree. Pre and create commands run in the project directory; post commands run in the actual worktree.

Commands receive `OMP_PROJECT_PATH`, `OMP_WORKSPACE_PATH`, `OMP_BRANCH`, `OMP_BASE_REF`, `OMP_BRANCH_MODE`, and `OMP_CREATE_RESULT`. A create command may write JSON such as `{"path":"/absolute/path"}` to `OMP_CREATE_RESULT`; otherwise the requested path is used. The result must resolve to a linked worktree of the project. The host registers it before post commands run, so sessions can start while post setup is running.

The daemon records the captured pipeline, status, and command output. A browser or web server restart does not stop a job; a daemon restart marks it interrupted. A failed pre or create stage leaves any files in place without importing them. A failed post stage leaves the workspace registered and usable, with its failure and logs available; there is no automatic retry.

## Deleting a workspace

The default workspace cannot be deleted as a worktree. Deleting another workspace is blocked while setup runs. The daemon fences new session starts and finds all daemon-managed processes in that directory or its descendants, including unregistered sessions and processes shared with other servers. Confirm stopping them first; the daemon waits for exit and refuses deletion if a stop fails.

If the worktree is dirty, a separate confirmation asks whether to discard its changes. Declining at this point leaves the processes stopped. After Git successfully removes the worktree, the host unregisters it and its sessions for all linked servers. The Git branch, session transcripts, and artifacts are preserved.

## Interactive terminals

Open terminals from a workspace. Each terminal has its own application tab and shell, starting in that workspace's directory on its owning host. Local and linked hosts use the same daemon-backed terminal path. Terminals share workspace files with its sessions and other terminals.

Switching tabs, closing the browser, or restarting the web server leaves shells running. Reopening the workspace discovers its terminals and restores their retained display. Explicitly closing a terminal ends its shell; stopping the host daemon ends all its terminals. Terminal state is in daemon memory, not durable across daemon restarts.

Workspace deletion includes terminals in its process confirmation and stops them before removing the worktree. Unregistering a workspace does not stop its processes or delete files.

Each daemon allows 32 terminals and retains 2,000 scrollback lines per terminal. Screens resize up to 500 columns by 300 rows. A pathological output burst that leaves more than 16 MiB awaiting terminal parsing stops that terminal to bound daemon memory; ordinary browser or host-link backpressure instead reconnects the display without stopping its shell.
