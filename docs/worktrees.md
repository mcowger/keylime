# Projects and workspaces

Projects belong to a host. The sidebar shows explicitly registered projects, their workspaces, and registered sessions within each workspace. The hierarchy starts empty, even if older projects or session files exist. Add a project to register its default workspace, then selectively discover and import existing worktrees and sessions. A non-Git project has exactly one workspace.

Importing sessions finds sessions whose working directory is inside the selected workspace, excluding other workspace roots. App-created sessions and forks register with their workspace. Multiple agents can use the same workspace and files at once; they are not isolated from one another. A missing project or workspace remains registered and visible as unavailable.

Unregistering a project or workspace forgets its child registrations, but does not stop processes or delete files. Re-registering starts fresh; import any existing children again. The default workspace cannot be unregistered separately from its project. Duplicate imports of the same canonical resource are idempotent, and each resource has one parent.

## Creating a workspace

For a Git project, create a workspace from an existing local branch, a remote branch, or a new branch based on a selected ref. Listing branches fetches remote refs. Base ref initially selects the repository's advertised default branch (preferring origin), not the currently checked-out feature branch. Without a remote default, it uses main, master, then the current branch. Checkout paths are derived from the branch under the project's sibling worktrees directory; the display name is editable.

Configure host creation commands in **Settings → Hosts**. **Settings → Projects** lists registered projects and edits their display names and optional whole-project command overrides. These settings live on the owning daemon and are shared with other linked web servers; the workspace creation panel only creates workspaces and displays job output.

Each pipeline has ordered pre, create, and post stages. Commands have no interactive stdin or automatic retries. With no create command, Git creates the worktree. Pre and create commands run in the project directory; post commands run in the actual worktree.

Commands receive `OMP_PROJECT_PATH`, `OMP_WORKSPACE_PATH`, `OMP_BRANCH`, `OMP_BASE_REF`, `OMP_BRANCH_MODE`, and `OMP_CREATE_RESULT`. A create command may write JSON such as `{"path":"/absolute/path"}` to `OMP_CREATE_RESULT`; otherwise the requested path is used. The result must resolve to a linked worktree of the project. The host registers it before post commands run, so sessions can start while post setup is running.

The daemon records the captured pipeline, status, and command output. A browser or web server restart does not stop a job; a daemon restart marks it interrupted. A failed pre or create stage leaves any files in place without importing them. A failed post stage leaves the workspace registered and usable, with its failure and logs available; there is no automatic retry.

## Deleting a workspace

The default workspace cannot be deleted as a worktree. Deleting another workspace is blocked while setup runs. The daemon fences new session starts and finds all daemon-managed processes in that directory or its descendants, including unregistered sessions and processes shared with other servers. Confirm stopping them first; the daemon waits for exit and refuses deletion if a stop fails.

If the worktree is dirty, a separate confirmation asks whether to discard its changes. Declining at this point leaves the processes stopped. After Git successfully removes the worktree, the host unregisters it and its sessions for all linked servers. The Git branch, session transcripts, and artifacts are preserved.
