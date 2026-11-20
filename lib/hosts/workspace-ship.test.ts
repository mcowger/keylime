import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getSessionDirNameForCwd } from "../omp/paths";
import {
  cacheSessionPath,
  invalidateSessionPathCache,
} from "../session-reader";
import type { ShipPrDigest } from "./link-protocol";
import type { ShipJob } from "../workspace-ship-types";
import {
  hierarchyOperation,
  readHierarchy,
  registerCreatedSession,
  registerCreatedWorkspace,
  registerEffortRoot,
  registerSystemRepo,
  unregisterEffortRoot,
} from "./project-hierarchy.ts";
import { setWorkspaceDeletionAdapter } from "./workspace-creation.ts";
import {
  acceptShipDigestReceipt,
  removeShipMonitorsForSession,
  shipFinish,
  shipMonitorStatus,
  shipPreview,
  startShip,
  shipStatus,
  refreshShipPrs,
  startShipWatcher,
  stopShipMonitor,
  stopShipWatcher,
  workspaceShipState,
} from "./workspace-ship.ts";

interface Fixture {
  project: string;
  root: string;
  workspace: string;
  git: (cwd: string, ...args: string[]) => string;
  input: { projectPath: string; path: string };
}

async function fixture(t: TestContext, effortMember = false): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ship-test-")));
  const oldDir = process.env.PI_CODING_AGENT_DIR,
    oldPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
root='${root}'
echo "$*" >> "$root/gh.log"
gate() {
  [ -f "$root/hold-$1" ] || return 0
  touch "$root/started-$1"
  for i in $(seq 1 500); do
    [ -f "$root/hold-$1" ] || return 0
    sleep 0.01
  done
  exit 1
}
case "$1 $2" in
  'auth status') exit 0;;
  'pr list')
    gate list
    if [ -f "$root/lookup-fails" ] || { [ -f "$root/fail-after-first" ] && [ -f "$root/seen-lookup" ]; }; then
      echo 'GitHub rate limit exceeded' >&2; exit 1
    elif [ -f "$root/empty-after-first" ] && [ -f "$root/seen-lookup" ]; then
      echo '[]'
    else
      touch "$root/seen-lookup"
      if [ -f "$root/open-pr" ]; then cat "$root/open-pr"; else echo '[]'; fi
    fi;;
  'pr create')
    cat >/dev/null
    gate create
    if [ -f "$root/race-pr" ]; then cp "$root/race-pr" "$root/open-pr"; echo 'PR already exists' >&2; exit 1; fi
    if [ -f "$root/create-url" ]; then cat "$root/create-url"; else echo https://github.com/test/repo/pull/42; fi;;
  'pr merge') if [ -f "$root/auto-fails" ]; then echo 'Auto-merge disabled' >&2; exit 1; fi;;
  'pr view')
    number=\${3##*/}
    state=MERGED
    [ ! -f "$root/pr-state" ] || state=$(cat "$root/pr-state")
    [ ! -f "$root/view-fails" ] || exit 1
    printf '{"state":"%s","url":"%s","number":%s,"autoMergeRequest":null,"statusCheckRollup":[]}\n' "$state" "$3" "$number";;
  'api --hostname')
    [ "$3 $4 $5" = 'github.com --paginate --slurp' ] || exit 1
    case "$6" in
      repos/test/repo/issues/*/comments'?per_page=100') kind=conversation;;
      repos/test/repo/pulls/*/comments'?per_page=100') kind=inline;;
      repos/test/repo/pulls/*/reviews'?per_page=100') kind=review;;
      *) exit 1;;
    esac
    gate "$kind"
    [ ! -f "$root/$kind-fails" ] || exit 1
    if [ -f "$root/$kind" ]; then cat "$root/$kind"; else echo '[[]]'; fi;;
  *) exit 1;;
esac
`,
  );
  chmodSync(gh, 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(root, "project"),
    workspace = effortMember
      ? join(root, "effort", "member")
      : join(root, "workspace"),
    remote = join(root, "remote.git");
  mkdirSync(project);
  if (effortMember) mkdirSync(dirname(workspace));
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(project, "init", "-q");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  writeFileSync(join(project, "file"), "base\n");
  git(project, "add", ".");
  git(project, "commit", "-qm", "base");
  git(project, "remote", "add", "origin", remote);
  git(project, "push", "-u", "origin", "HEAD");
  git(project, "remote", "add", "github", "https://github.com/test/repo.git");
  if (effortMember) registerSystemRepo(project);
  else {
    const result = await hierarchyOperation({
      action: "registerProject",
      path: project,
    });
    assert.equal(result.ok, true);
  }
  git(project, "worktree", "add", "-qb", "feature", workspace);
  registerCreatedWorkspace(project, workspace, "feature");
  setWorkspaceDeletionAdapter({
    fence: () => () => {},
    inspect: async () => [],
    stop: async () => {},
  });
  return {
    project,
    root,
    workspace,
    git,
    input: { projectPath: project, path: workspace },
  };
}
async function finished(job: ShipJob) {
  const deadline = Date.now() + 15000;
  while (job.status === "running" && Date.now() < deadline) {
    await delay(25);
    job = await shipStatus(job.id);
  }
  return job;
}
test("PR lookup failure permits both PR modes and local landing", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "lookup-fails"), "");
  writeFileSync(join(f.workspace, "feature"), "feature");
  f.git(f.workspace, "add", ".");
  f.git(f.workspace, "commit", "-qm", "feature");
  const preview = await shipPreview(f.input);
  assert.equal(preview.pr, null);
  assert.match(preview.github.prLookupError!, /GitHub rate limit exceeded/);
  for (const mode of ["pr", "pr-auto"] as const) {
    const job = await finished(
      await startShip({
        ...f.input,
        mode,
        rebase: false,
        cleanup: false,
        pr: { title: "Feature", body: "Details" },
      }),
    );
    assert.equal(job.status, "complete", job.error);
    assert.equal(job.pr?.number, 42);
    if (mode === "pr-auto") assert.equal(job.pr?.autoMerge, true);
  }
  const local = await finished(
    await startShip({
      ...f.input,
      mode: "local",
      rebase: false,
      cleanup: false,
    }),
  );
  assert.equal(local.status, "complete", local.error);
  assert.equal(
    f.git(f.project, "rev-parse", "HEAD"),
    f.git(f.workspace, "rev-parse", "HEAD"),
  );
});

test("preview counts and local landing deletes merged branch", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "feature"), "feature");
  f.git(f.workspace, "add", ".");
  f.git(f.workspace, "commit", "-qm", "feature");
  const preview = await shipPreview(f.input);
  assert.equal(preview.ahead, 1);
  assert.equal(preview.behind, 0);
  assert.equal(preview.dirty, false);
  assert.deepEqual(preview.issues, []);
  const job = await finished(
    await startShip({ ...f.input, mode: "local", rebase: true, cleanup: true }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.equal(existsSync(f.workspace), false);
  assert.throws(() =>
    f.git(f.project, "rev-parse", "--verify", "refs/heads/feature"),
  );
  assert.equal(f.git(f.project, "rev-parse", "HEAD"), job.landedSha);
});
test("conflicted rebase is aborted", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "file"), "feature\n");
  f.git(f.workspace, "commit", "-am", "feature");
  const before = f.git(f.workspace, "rev-parse", "HEAD");
  writeFileSync(join(f.project, "file"), "base change\n");
  f.git(f.project, "commit", "-am", "base change");
  const preview = await shipPreview(f.input);
  assert.equal(preview.ahead, 1);
  assert.equal(preview.behind, 1);
  assert.deepEqual(preview.issues, [
    `Potential conflicts with ${preview.base}: file`,
  ]);
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "local",
      rebase: true,
      cleanup: false,
    }),
  );
  assert.equal(job.status, "conflict");
  assert.deepEqual(job.conflictFiles, ["file"]);
  assert.equal(f.git(f.workspace, "rev-parse", "HEAD"), before);
  assert.equal(f.git(f.workspace, "status", "--porcelain"), "");
});
test("preview reports unmerged files and in-progress operations without changing the workspace", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "file"), "feature\n");
  f.git(f.workspace, "commit", "-am", "feature");
  writeFileSync(join(f.project, "file"), "base change\n");
  f.git(f.project, "commit", "-am", "base change");
  assert.throws(() =>
    f.git(f.workspace, "merge", f.git(f.project, "branch", "--show-current")),
  );
  const before = f.git(f.workspace, "status", "--porcelain");
  const preview = await shipPreview(f.input);
  assert.ok(
    preview.issues.some((issue) =>
      issue.includes("Unresolved conflicts: file"),
    ),
  );
  assert.ok(
    preview.issues.some((issue) => issue.includes("merge is in progress")),
  );
  assert.equal(f.git(f.workspace, "status", "--porcelain"), before);
});
test("preview detects conflicts in uncommitted changes without modifying the index or worktree", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "file"), "staged feature\n");
  f.git(f.workspace, "add", "file");
  writeFileSync(join(f.workspace, "file"), "unstaged feature\n");
  writeFileSync(join(f.project, "file"), "base change\n");
  f.git(f.project, "commit", "-am", "base change");
  const status = f.git(f.workspace, "status", "--porcelain");
  const staged = f.git(f.workspace, "show", ":file");
  const preview = await shipPreview(f.input);
  assert.deepEqual(preview.issues, [
    `Potential conflicts with ${preview.base}: file`,
  ]);
  assert.equal(f.git(f.workspace, "status", "--porcelain"), status);
  assert.equal(f.git(f.workspace, "show", ":file"), staged);
  assert.equal(
    f.git(f.workspace, "diff", "--", "file").includes("unstaged feature"),
    true,
  );
});
test("merged PR watcher finishes and removes workspace", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, "feature"), "feature");
  f.git(f.workspace, "add", ".");
  f.git(f.workspace, "commit", "-qm", "feature");
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr",
      rebase: false,
      cleanup: true,
      pr: { title: "Feature", body: "Details" },
    }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.ok(job.pr);
  assert.equal(job.pr.number, 42);
  await refreshShipPrs();
  const deadline = Date.now() + 15000;
  while (existsSync(f.workspace) && Date.now() < deadline) await delay(25);
  assert.equal(existsSync(f.workspace), false);
});

test("Effort ownership hides worktrees and fences standalone Ship, including old PR records", async (t) => {
  const f = await fixture(t, true);
  const effortRoot = dirname(f.workspace);
  const canonical = registerSystemRepo(f.workspace);
  const initial = await hierarchyOperation({ action: "list" });
  assert.ok(initial.ok);
  assert.deepEqual(initial.value.projects, []);
  const visible = await hierarchyOperation({
    action: "registerProject",
    path: f.project,
  });
  assert.ok(visible.ok);
  assert.equal(visible.value.selectedProjectId, canonical.id);

  const effort = registerEffortRoot(effortRoot, "Launch");
  const chat = "11111111-1111-4111-8111-111111111111";
  registerCreatedSession(effortRoot, chat);
  const renamed = registerEffortRoot(effortRoot, "Launch again");
  assert.equal(renamed.id, effort.id);
  assert.equal(renamed.name, "Launch again");
  assert.deepEqual(renamed.sessionIds, [chat]);
  const persisted = readHierarchy().projects.find(
    (p) => p.id === effort.projectId,
  );
  assert.equal(persisted?.name, "Launch again");
  assert.equal(persisted?.workspaces[0].name, "Launch again");

  // Include a worktree that Git knows about but Effort setup hasn't registered.
  const partial = join(effortRoot, "partial");
  const standalone = join(f.root, "effort-standalone");
  f.git(f.project, "worktree", "add", "-qb", "partial", partial);
  f.git(f.project, "worktree", "add", "-qb", "standalone", standalone);
  const alias = join(f.root, "alias");
  symlinkSync(partial, alias);
  const keylime = join(f.root, "agent", "keylime");
  mkdirSync(join(keylime, "ship"), { recursive: true });
  writeFileSync(
    join(keylime, "systems.json"),
    JSON.stringify({
      version: 1,
      systems: [],
      efforts: [
        {
          root: effortRoot,
          status: "ready",
          members: [
            { path: f.workspace, repoPath: f.project },
            { path: partial, repoPath: f.project },
          ],
        },
      ],
    }),
  );
  const discovered = await hierarchyOperation({
    action: "discoverWorkspaces",
    projectId: canonical.id,
  });
  assert.ok(discovered.ok);
  assert.deepEqual(
    discovered.value.projects.map((p) => p.id),
    [canonical.id],
  );
  assert.deepEqual(
    discovered.value.projects[0].workspaces.map((w) => w.path),
    [f.project],
  );
  assert.deepEqual(
    discovered.value.workspaceCandidates?.map((w) => w.path),
    [standalone],
  );
  for (const rejected of [
    await hierarchyOperation({ action: "registerProject", path: alias }),
    await hierarchyOperation({ action: "registerProject", path: effort.path }),
    await hierarchyOperation({
      action: "importWorkspaces",
      projectId: canonical.id,
      paths: [alias],
    }),
  ])
    assert.equal(rejected.ok, false);

  const prFile = join(keylime, "ship", "prs.json");
  const oldRecords = JSON.stringify({
    [f.workspace]: {
      ...f.input,
      base: f.git(f.project, "branch", "--show-current"),
      pr: {
        number: 42,
        url: "https://github.com/test/repo/pull/42",
        state: "open",
        cleanup: true,
        autoMerge: false,
        checks: "none",
        checkedAt: new Date().toISOString(),
      },
    },
  });
  writeFileSync(prFile, oldRecords);
  await assert.rejects(shipPreview(f.input), { code: "effort_workspace" });
  await assert.rejects(
    startShip({ ...f.input, mode: "local", rebase: false, cleanup: false }),
    { code: "effort_workspace" },
  );
  await assert.rejects(shipFinish(f.input), { code: "effort_workspace" });
  await refreshShipPrs();
  assert.equal(readFileSync(prFile, "utf8"), oldRecords);
  assert.equal(existsSync(join(f.root, "gh.log")), false);
  assert.equal(existsSync(f.workspace), true);

  const hidden = await hierarchyOperation({
    action: "unregisterProject",
    projectId: canonical.id,
  });
  assert.ok(hidden.ok);
  assert.deepEqual(hidden.value.projects, []);
  const retained = readHierarchy().projects.find((p) => p.id === canonical.id);
  assert.ok(retained?.workspaces.some((w) => w.path === f.workspace));
  const restored = await hierarchyOperation({
    action: "registerProject",
    path: standalone,
  });
  assert.ok(restored.ok);
  assert.equal(restored.value.selectedProjectId, canonical.id);
  unregisterEffortRoot(effortRoot);
  assert.ok(!readHierarchy().projects.some((p) => p.id === effort.projectId));
});

test("preview discovers an existing PR and auto-merge adopts it", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "open-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        autoMergeRequest: null,
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  const preview = await shipPreview(f.input);
  assert.equal(preview.pr?.number, 17);
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: true,
    }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.pr?.number, 17);
  assert.equal(job.pr?.autoMerge, true);
  assert.equal(job.pr?.cleanup, true);
  const log = readFileSync(join(f.root, "gh.log"), "utf8");
  assert.match(
    log,
    /pr merge https:\/\/github\.com\/test\/repo\/pull\/17 --squash --auto/,
  );
  assert.doesNotMatch(log, /pr create/);
  await refreshShipPrs();
  const deadline = Date.now() + 15000;
  while (existsSync(f.workspace) && Date.now() < deadline) await delay(25);
  assert.equal(existsSync(f.workspace), false);
});
test("auto-merge retains the job preview PR only when post-push discovery fails", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "open-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  writeFileSync(join(f.root, "fail-after-first"), "");
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: false,
    }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.pr?.number, 17);
  assert.match(
    readFileSync(join(f.root, "gh.log"), "utf8"),
    /pr merge https:\/\/github\.com\/test\/repo\/pull\/17 --squash --auto/,
  );
});

test("auto-merge does not reuse a preview PR after a successful empty lookup", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "open-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  writeFileSync(join(f.root, "empty-after-first"), "");
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: false,
    }),
  );
  assert.equal(job.status, "failed");
  assert.match(job.error!, /title and body are required/);
  assert.doesNotMatch(readFileSync(join(f.root, "gh.log"), "utf8"), /pr merge/);
});

test("open PR mode rejects an existing PR before pushing", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "open-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr",
      rebase: false,
      cleanup: false,
      pr: { title: "Feature", body: "Details" },
    }),
  );
  assert.equal(job.status, "failed");
  assert.match(job.error!, /already exists/);
  assert.equal(
    job.steps.find((step) => step.name === "push")?.status,
    "pending",
  );
});

test("auto-merge requires a description when no PR exists", async (t) => {
  const f = await fixture(t);
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: false,
    }),
  );
  assert.equal(job.status, "failed");
  assert.match(job.error!, /title and body are required/);
});

test("auto-merge adopts a PR created concurrently", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.root, "race-pr"),
    JSON.stringify([
      {
        number: 17,
        url: "https://github.com/test/repo/pull/17",
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
  const job = await finished(
    await startShip({
      ...f.input,
      mode: "pr-auto",
      rebase: false,
      cleanup: false,
      pr: { title: "Feature", body: "Details" },
    }),
  );
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.pr?.number, 17);
  assert.match(
    readFileSync(join(f.root, "gh.log"), "utf8"),
    /pr merge https:\/\/github\.com\/test\/repo\/pull\/17 --squash --auto/,
  );
});

const firstChat = "11111111-1111-4111-8111-111111111111";
const otherChat = "22222222-2222-4222-8222-222222222222";
const firstGrant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherGrant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const monitorInput = (f: Fixture) => ({
  ...f.input,
  mode: "pr" as const,
  rebase: false,
  cleanup: false,
  pr: { title: "Feature", body: "Details" },
  monitorSessionId: firstChat,
  monitorGrantId: firstGrant,
});

function addChat(
  t: TestContext,
  f: Fixture,
  id = firstChat,
  cwd = f.workspace,
) {
  const dir = join(f.root, "agent", "sessions", getSessionDirNameForCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(
    file,
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      cwd,
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  registerCreatedSession(cwd, id);
  cacheSessionPath(id, file);
  t.after(() => invalidateSessionPathCache(id));
  return file;
}

function startOffers(t: TestContext) {
  const offers: { owner: string; digest: ShipPrDigest }[] = [];
  startShipWatcher(
    () => {},
    (owner, digest) => offers.push({ owner, digest }),
  );
  t.after(stopShipWatcher);
  return offers;
}

function setOpenPr(f: Fixture, number: number) {
  writeFileSync(
    join(f.root, "open-pr"),
    JSON.stringify([
      {
        number,
        url: `https://github.com/Test/Repo/pull/${number}/`,
        headRepositoryOwner: { login: "test" },
        headRepository: { name: "repo" },
      },
    ]),
  );
}

function issueComment(id: number, at = Date.now()) {
  return {
    id,
    created_at: new Date(at).toISOString(),
    body: "untrusted command",
    html_url: "https://untrusted.example/redirect",
    path: "private/path",
  };
}

const prState = (f: Fixture) => workspaceShipState(f.workspace)?.pr;
function persistedPr(f: Fixture) {
  const file = join(f.root, "agent", "keylime", "ship", "prs.json");
  const records = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    {
      monitor: { id: string; seen: string[]; pending: ShipPrDigest[] };
    }
  >;
  return records[f.workspace];
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 4000;
  while (!existsSync(file) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(file), file);
}

test("new PR monitor batches all kinds from paginated GitHub responses after an incomplete first poll", async (t) => {
  const f = await fixture(t);
  addChat(t, f);
  writeFileSync(
    join(f.root, "create-url"),
    "https://GitHub.com/Test/Repo/pull/42/\n",
  );
  writeFileSync(join(f.root, "pr-state"), "OPEN");
  const offers = startOffers(t);
  const request = startShip(monitorInput(f), "server-a");
  const at = Date.now();
  const job = await finished(await request);
  assert.equal(job.status, "complete", job.error);
  assert.equal(job.pr?.url, "https://github.com/test/repo/pull/42");
  assert.equal(job.pr?.monitor?.id, firstGrant);
  assert.equal(job.pr?.monitor?.state, "watching");
  // The checkout is no longer a source of PR identity after Ship.
  f.git(
    f.workspace,
    "remote",
    "set-url",
    "github",
    "https://github.com/wrong/repo.git",
  );

  writeFileSync(
    join(f.root, "conversation"),
    JSON.stringify([
      [issueComment(2, at - 60_000), issueComment(12, at + 1)],
      [issueComment(9, at + 1), issueComment(12, at + 1)],
    ]),
  );
  writeFileSync(
    join(f.root, "inline"),
    JSON.stringify([[{ ...issueComment(12, at + 1), in_reply_to_id: 2 }]]),
  );
  writeFileSync(
    join(f.root, "review"),
    JSON.stringify([
      [{ id: 7, state: "PENDING" }],
      [
        {
          id: 1,
          state: "COMMENTED",
          submitted_at: new Date(at).toISOString(),
          body: "untrusted review",
        },
      ],
    ]),
  );
  writeFileSync(join(f.root, "inline-fails"), "");
  await refreshShipPrs();
  assert.equal(prState(f)?.monitor?.state, "error");
  assert.deepEqual(persistedPr(f).monitor.seen, []);
  assert.deepEqual(persistedPr(f).monitor.pending, []);
  assert.equal(offers.length, 0);

  rmSync(join(f.root, "inline-fails"));
  const review = join(f.root, "review");
  const validReviews = readFileSync(review);
  writeFileSync(
    review,
    '[[{"id":1,"state":"COMMENTED"}],{"message":"incomplete page"}]',
  );
  await refreshShipPrs();
  assert.equal(prState(f)?.monitor?.state, "error");
  assert.deepEqual(persistedPr(f).monitor.seen, []);
  assert.equal(offers.length, 0);
  writeFileSync(review, validReviews);
  await refreshShipPrs();
  assert.equal(prState(f)?.monitor?.state, "watching");
  assert.equal(offers.length, 1);
  const offer = offers[0];
  assert.equal(offer.owner, "server-a");
  assert.equal(offer.digest.sessionId, firstChat);
  assert.deepEqual(offer.digest, {
    id: offer.digest.id,
    monitorId: firstGrant,
    sessionId: firstChat,
    createdAt: offer.digest.createdAt,
    prUrl: "https://github.com/test/repo/pull/42",
    feedback: [
      { kind: "review", id: 1 },
      { kind: "conversation", id: 9 },
      { kind: "conversation", id: 12 },
      { kind: "inline", id: 12 },
    ],
    omitted: 0,
  });
  assert.deepEqual(persistedPr(f).monitor.pending, [offer.digest]);
  assert.equal(persistedPr(f).monitor.seen.length, 4);
  assert.doesNotMatch(
    JSON.stringify(prState(f)),
    /server-a|issuecomment|requestedAt|sessionId/,
  );

  // A reconnect without an application receipt still offers the original payload.
  stopShipWatcher();
  const resumed = startOffers(t);
  await refreshShipPrs();
  assert.deepEqual(resumed, [offer]);
  assert.equal(acceptShipDigestReceipt("server-b", offer.digest.id), false);
  assert.equal(acceptShipDigestReceipt("server-a", offer.digest.id), true);
  await refreshShipPrs();
  assert.deepEqual(resumed, [offer]);
  assert.deepEqual(persistedPr(f).monitor.pending, []);

  const prFile = join(f.root, "agent", "keylime", "ship", "prs.json");
  const record = persistedPr(f);
  writeFileSync(
    prFile,
    JSON.stringify({
      [f.workspace]: {
        ...record,
        monitor: {
          ...record.monitor,
          pending: [
            {
              id: offer.digest.id,
              sessionId: firstChat,
              createdAt: Date.now(),
              message: "legacy text",
            },
          ],
        },
      },
    }),
  );
  await refreshShipPrs();
  assert.deepEqual(resumed, [offer]);
  assert.deepEqual(persistedPr(f).monitor.pending, []);
});

test("adoption records the watch before auto-merge, and a repeat cannot take it over or reset it", async (t) => {
  const f = await fixture(t);
  addChat(t, f);
  addChat(t, f, otherChat);
  setOpenPr(f, 17);
  writeFileSync(join(f.root, "pr-state"), "OPEN");
  writeFileSync(join(f.root, "auto-fails"), "");
  const offers = startOffers(t);
  const input = { ...monitorInput(f), mode: "pr-auto" as const, pr: undefined };
  const first = await finished(await startShip(input, "server-a"));
  assert.equal(first.status, "failed");
  assert.match(first.error!, /Auto-merge disabled/);
  assert.equal(first.pr?.number, 17);
  assert.equal(first.pr?.monitor?.state, "watching");
  writeFileSync(
    join(f.root, "conversation"),
    JSON.stringify([[issueComment(9)]]),
  );
  await refreshShipPrs();
  assert.equal(offers.length, 1);
  const original = persistedPr(f).monitor;

  rmSync(join(f.root, "auto-fails"));
  const repeat = await finished(
    await startShip(
      { ...input, monitorSessionId: otherChat, monitorGrantId: otherGrant },
      "server-b",
    ),
  );
  assert.equal(repeat.status, "complete", repeat.error);
  assert.equal(repeat.pr?.monitor?.id, first.pr?.monitor?.id);
  assert.deepEqual(persistedPr(f).monitor, original);
  await refreshShipPrs();
  assert.deepEqual(offers, [offers[0], offers[0]]);
  assert.equal(offers[0].owner, "server-a");
  assert.equal(offers[0].digest.sessionId, firstChat);
  const stop = { ...f.input, monitorId: original.id };
  assert.throws(() => stopShipMonitor(stop, "server-b"), { status: 403 });
  assert.deepEqual(
    stopShipMonitor({ ...stop, monitorId: "obsolete" }, "server-a"),
    { stopped: false },
  );
  writeFileSync(join(f.root, "hold-list"), "");
  const repeatingWhileStopped = await startShip(input, "server-a");
  await waitForFile(join(f.root, "started-list"));
  const inFlightStatus = shipMonitorStatus(stop, "server-a");
  assert.deepEqual(stopShipMonitor(stop, "server-a"), { stopped: true });
  assert.deepEqual(await inFlightStatus, { watch: null });
  rmSync(join(f.root, "hold-list"));
  const stoppedRepeat = await finished(repeatingWhileStopped);
  assert.equal(stoppedRepeat.status, "complete", stoppedRepeat.error);
  await refreshShipPrs();
  assert.equal(offers.length, 2);
  assert.equal(prState(f)?.monitor, undefined);
  assert.equal(acceptShipDigestReceipt("server-a", offers[0].digest.id), false);
});

test("session validation precedes Git effects and is repeated after async preview and PR creation", async (t) => {
  const f = await fixture(t);
  addChat(t, f, otherChat, f.project);
  const input = monitorInput(f);
  await assert.rejects(startShip(input), { status: 403 });
  for (const invalid of [
    { ...input, monitorGrantId: undefined },
    { ...input, monitorGrantId: "not-a-uuid" },
    { ...input, monitorSessionId: undefined },
  ])
    await assert.rejects(startShip(invalid, "server-a"), { status: 400 });
  await assert.rejects(startShip({ ...input, mode: "local" }, "server-a"), {
    status: 400,
  });
  await assert.rejects(
    startShip({ ...input, monitorSessionId: otherChat }, "server-a"),
    { status: 409 },
  );
  assert.equal(existsSync(join(f.root, "gh.log")), false);

  const file = addChat(t, f);
  const session = readFileSync(file);
  writeFileSync(join(f.root, "hold-list"), "");
  const early = await startShip(input, "server-a");
  await waitForFile(join(f.root, "started-list"));
  rmSync(file);
  rmSync(join(f.root, "hold-list"));
  const failed = await finished(early);
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(
    readFileSync(join(f.root, "gh.log"), "utf8"),
    /pr create/,
  );
  assert.throws(() =>
    f.git(f.workspace, "rev-parse", "--verify", "refs/remotes/origin/feature"),
  );

  writeFileSync(file, session);
  writeFileSync(join(f.root, "hold-create"), "");
  const late = await startShip(input, "server-a");
  await waitForFile(join(f.root, "started-create"));
  rmSync(file);
  removeShipMonitorsForSession(firstChat);
  rmSync(join(f.root, "hold-create"));
  const lateResult = await finished(late);
  assert.equal(lateResult.status, "failed");
  assert.equal(prState(f)?.number, 42);
  assert.equal(prState(f)?.monitor, undefined);
});

test("monitor status is owner-scoped, fresh and read-only", async (t) => {
  const f = await fixture(t);
  const file = addChat(t, f);
  const job = await finished(await startShip(monitorInput(f), "server-a"));
  assert.equal(job.status, "complete", job.error);
  const input = { ...f.input, monitorId: firstGrant };
  const prFile = join(f.root, "agent", "keylime", "ship", "prs.json");
  const before = readFileSync(prFile, "utf8");
  assert.deepEqual(await shipMonitorStatus(input, "server-a"), {
    watch: {
      sessionId: firstChat,
      prUrl: "https://github.com/test/repo/pull/42",
    },
  });
  assert.deepEqual(await shipMonitorStatus(input, "server-b"), { watch: null });
  assert.deepEqual(await shipMonitorStatus(input), { watch: null });
  assert.deepEqual(
    await shipMonitorStatus({ ...input, monitorId: otherGrant }, "server-a"),
    { watch: null },
  );
  assert.deepEqual(
    await shipMonitorStatus({ ...input, projectPath: f.workspace }, "server-a"),
    { watch: null },
  );
  rmSync(file);
  assert.deepEqual(await shipMonitorStatus(input, "server-a"), { watch: null });
  assert.equal(readFileSync(prFile, "utf8"), before);
});

test("receipt during an in-flight poll stays committed; stop and a newer Ship fence stale reads", async (t) => {
  const f = await fixture(t);
  addChat(t, f);
  writeFileSync(join(f.root, "pr-state"), "OPEN");
  const offers = startOffers(t);
  const job = await finished(await startShip(monitorInput(f), "server-a"));
  assert.ok(job.pr?.monitor);
  writeFileSync(
    join(f.root, "conversation"),
    JSON.stringify([[issueComment(1)]]),
  );
  await refreshShipPrs();
  assert.equal(offers.length, 1);

  const hold = join(f.root, "hold-conversation");
  const started = join(f.root, "started-conversation");
  writeFileSync(hold, "");
  const receiptRace = refreshShipPrs();
  await waitForFile(started);
  assert.equal(acceptShipDigestReceipt("server-a", offers[0].digest.id), true);
  rmSync(hold);
  await receiptRace;
  assert.equal(offers.length, 1);
  assert.deepEqual(persistedPr(f).monitor.pending, []);

  rmSync(started);
  writeFileSync(hold, "");
  writeFileSync(
    join(f.root, "conversation"),
    JSON.stringify([[issueComment(2)]]),
  );
  const newShipRace = refreshShipPrs();
  await waitForFile(started);
  assert.deepEqual(
    stopShipMonitor({ ...f.input, monitorId: job.pr.monitor.id }, "server-a"),
    { stopped: true },
  );
  setOpenPr(f, 43);
  const replacement = await finished(
    await startShip(
      { ...monitorInput(f), mode: "pr-auto", monitorGrantId: otherGrant },
      "server-b",
    ),
  );
  assert.equal(replacement.status, "complete", replacement.error);
  rmSync(hold);
  await newShipRace;
  assert.equal(offers.length, 1);
  assert.equal(prState(f)?.number, 43);
  assert.equal(prState(f)?.monitor?.id, replacement.pr?.monitor?.id);
  assert.deepEqual(persistedPr(f).monitor.seen, []);
});

for (const stop of [
  "merge",
  "close",
  "archive hook",
  "file disappeared",
] as const) {
  test(`watch drops pending offers on ${stop}`, async (t) => {
    const f = await fixture(t);
    const file = addChat(t, f);
    writeFileSync(join(f.root, "pr-state"), "OPEN");
    const offers = startOffers(t);
    const job = await finished(await startShip(monitorInput(f), "server-a"));
    assert.ok(job.pr?.monitor);
    writeFileSync(
      join(f.root, "conversation"),
      JSON.stringify([[issueComment(1)]]),
    );
    await refreshShipPrs();
    assert.equal(offers.length, 1);
    if (stop === "archive hook") removeShipMonitorsForSession(firstChat);
    else if (stop === "file disappeared") rmSync(file);
    else
      writeFileSync(
        join(f.root, "pr-state"),
        stop === "merge" ? "MERGED" : "CLOSED",
      );
    await refreshShipPrs();
    assert.equal(prState(f)?.monitor, undefined);
    assert.equal(
      prState(f)?.state,
      stop === "merge" ? "merged" : stop === "close" ? "closed" : "open",
    );
    assert.equal(offers.length, 1);
    assert.equal(
      acceptShipDigestReceipt("server-a", offers[0].digest.id),
      false,
    );
  });
}

test("a bounded digest expires after seven days without waking the chat again", async (t) => {
  const f = await fixture(t);
  addChat(t, f);
  writeFileSync(join(f.root, "pr-state"), "OPEN");
  const offers = startOffers(t);
  const job = await finished(await startShip(monitorInput(f), "server-a"));
  assert.ok(job.pr?.monitor);
  writeFileSync(
    join(f.root, "conversation"),
    JSON.stringify([Array.from({ length: 50 }, (_, i) => issueComment(i + 1))]),
  );
  await refreshShipPrs();
  assert.equal(offers.length, 1);
  assert.equal(offers[0].digest.feedback.length, 20);
  writeFileSync(join(f.root, "view-fails"), "");
  await refreshShipPrs();
  assert.equal(prState(f)?.monitor?.state, "error");
  assert.equal(offers.length, 1);
  rmSync(join(f.root, "view-fails"));
  assert.equal(offers[0].digest.omitted, 30);
  const clock = t.mock.method(
    Date,
    "now",
    () => offers[0].digest.createdAt + 7 * 24 * 60 * 60 * 1000,
  );
  try {
    await refreshShipPrs();
    assert.equal(prState(f)?.monitor?.state, "delivery-expired");
    assert.equal(offers.length, 1);
    assert.equal(
      acceptShipDigestReceipt("server-a", offers[0].digest.id),
      false,
    );
    await refreshShipPrs();
    assert.equal(offers.length, 1);
    assert.equal(persistedPr(f).monitor.seen.length, 50);
  } finally {
    clock.mock.restore();
  }
});
