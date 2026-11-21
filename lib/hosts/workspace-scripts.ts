import type {
  WorkspaceScriptsRequest,
  WorkspaceScriptsResult,
} from "../api-contracts/workspace-models";
import { HostOpError } from "./link-protocol";
import { isEffortPath } from "./systems";
import {
  paseoServicePortVariable,
  resolveTerminalWorkspace,
  type TerminalWorkspaceRegistration,
  type TerminalManager,
  type WorkspaceScriptObservation,
} from "./terminals";
import {
  readWorkspaceCreationSource,
  workspaceGit,
} from "./workspace-creation";
import {
  readPaseoScripts,
  validPaseoScriptName,
  type PaseoScript,
} from "./workspace-paseo";

const customAllocatorError =
  "worktree.servicePorts requires an explicit port in Keylime";
const collisionError =
  "Service names must map to distinct PASEO_SERVICE_*_PORT variables";

function servicePortCollisions(
  entries: Map<string, PaseoScript>,
  runs: WorkspaceScriptObservation[],
): Set<string> {
  const names = new Map<string, string>();
  const collisions = new Set<string>();
  const track = (name: string) => {
    const variable = paseoServicePortVariable(name);
    const first = names.get(variable);
    if (first === undefined) names.set(variable, name);
    else if (first !== name) collisions.add(variable);
  };
  for (const [name, entry] of entries)
    if (entry.kind === "service") track(name);
  for (const { name, kind, run } of runs)
    if (kind === "service" && run.status === "running") track(name);
  return collisions;
}

function enabled({
  project,
  workspace,
}: TerminalWorkspaceRegistration): boolean {
  return (
    project.kind === "git" &&
    !project.hidden &&
    !isEffortPath(workspace.path) &&
    readWorkspaceCreationSource(project.path) === "paseo"
  );
}

function assertLaunchEnabled(
  registration: TerminalWorkspaceRegistration,
): void {
  if (!enabled(registration))
    throw new HostOpError(
      403,
      "paseo_scripts_disabled",
      "Enable Follow Paseo workspace setup in the Repo settings to launch scripts",
    );
  const { setup } = registration.workspace;
  if (setup?.status === "running" && setup.stage === "postBlocking")
    throw new HostOpError(
      409,
      "workspace_setup_blocking",
      "Workspace setup is still running blocking commands",
    );
}

export async function workspaceScriptsOperation(
  input: WorkspaceScriptsRequest,
  terminals: TerminalManager,
  assertCurrentLink: () => void,
): Promise<WorkspaceScriptsResult> {
  if (input.action === "stop") {
    assertCurrentLink();
    await terminals.stopWorkspaceScript(input.cwd, input.terminalId);
    return { stopped: true };
  }

  const registration = resolveTerminalWorkspace(input.cwd);
  const { workspace, project } = registration;
  const cwd = workspace.path;
  if (input.action === "list") {
    const runs = terminals.listWorkspaceScriptRuns(cwd);
    const canLaunch = enabled(registration);
    const recipe = canLaunch ? readPaseoScripts(project.path) : null;
    const byName = new Map(runs.map((row) => [row.name, row]));
    const entries = [];
    if (recipe) {
      const collisions = servicePortCollisions(recipe.entries, runs);
      for (const [name, entry] of recipe.entries) {
        const observation = byName.get(name);
        byName.delete(name);
        let error = entry.error;
        if (!error && entry.kind === "service") {
          if (collisions.has(paseoServicePortVariable(name)))
            error = collisionError;
          else if (recipe.customAllocator && entry.port === undefined)
            error = customAllocatorError;
        }
        entries.push({
          name,
          kind:
            observation?.run.status === "running"
              ? observation.kind
              : entry.kind,
          configured: true,
          error,
          run: observation?.run ?? null,
        });
      }
    }
    for (const run of byName.values())
      entries.push({ ...run, configured: false, error: null });
    return { enabled: canLaunch, error: recipe?.error ?? null, entries };
  }

  assertCurrentLink();
  assertLaunchEnabled(registration);
  let branch: string | null;
  try {
    branch = (
      await workspaceGit(
        cwd,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        5000,
      )
    ).trimEnd();
  } catch (error) {
    branch =
      error instanceof Error && "code" in error && error.code === 1 ? "" : null;
  }
  assertCurrentLink();
  const current = resolveTerminalWorkspace(input.cwd);
  if (
    current.workspace.path !== cwd ||
    current.workspace.id !== workspace.id ||
    current.project.id !== project.id
  )
    throw new HostOpError(
      403,
      "workspace_not_registered",
      "Workspace registration changed",
    );
  assertLaunchEnabled(current);
  if (branch === null)
    throw new HostOpError(
      500,
      "paseo_launch_failed",
      "Could not determine the workspace branch",
    );

  // Admission, reading the live recipe, port selection and spawning have no await between them.
  const recipe = readPaseoScripts(current.project.path);
  if (recipe.error && recipe.entries.size === 0)
    throw new HostOpError(400, "paseo_invalid_script", recipe.error);
  if (!validPaseoScriptName(input.name))
    throw new HostOpError(400, "paseo_invalid_script", "Invalid script name");
  const entry = recipe.entries.get(input.name);
  if (!entry)
    throw new HostOpError(
      404,
      "paseo_script_not_found",
      "Script not found in paseo.json",
    );
  if (entry.error || entry.command === null)
    throw new HostOpError(
      400,
      "paseo_invalid_script",
      entry.error ?? "Invalid script command",
    );
  if (entry.kind === "service") {
    const collisions = servicePortCollisions(
      recipe.entries,
      terminals.listWorkspaceScriptRuns(cwd),
    );
    if (collisions.has(paseoServicePortVariable(input.name)))
      throw new HostOpError(400, "paseo_invalid_script", collisionError);
    if (recipe.customAllocator && entry.port === undefined)
      throw new HostOpError(
        400,
        "paseo_unsupported_allocator",
        customAllocatorError,
      );
  }

  const source = current.project.path;
  try {
    const terminal = terminals.startWorkspaceScript({
      cwd,
      name: input.name,
      kind: entry.kind,
      command: entry.command,
      port: entry.port,
      env: {
        PASEO_SOURCE_CHECKOUT_PATH: source,
        PASEO_WORKTREE_PATH: cwd,
        PASEO_BRANCH_NAME: branch,
        PASEO_PROJECT_PATH: source,
        PASEO_WORKSPACE_PATH: cwd,
        PASEO_BRANCH: branch,
        OMP_PROJECT_PATH: source,
        OMP_WORKSPACE_PATH: cwd,
        OMP_BRANCH: branch,
      },
    });
    return { terminal };
  } catch (error) {
    if (error instanceof HostOpError) throw error;
    throw new HostOpError(
      500,
      "paseo_launch_failed",
      "Could not start the workspace script",
    );
  }
}
