import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workspaceHarness } from "./workspace-test-helper.ts";

test("Git status, patch and repository links come from the authorized owning daemon", async (t) => {
  const f = await workspaceHarness();
  t.after(() => f.close());
  const owner = await f.startHost();
  const cwd = owner.project;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args]);
  git("init", "-q");
  git("config", "user.name", "Workspace test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(cwd, "report.txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("remote", "add", "origin", "https://github.com/example/owning-host.git");
  await owner.host.sessionOps.validateCwd(cwd);
  writeFileSync(join(cwd, "report.txt"), "owning host after\n");
  const status = await owner.host.workspaceOps.gitStatus(cwd);
  assert.ok(status.ok);
  assert.equal(
    status.value.files.find((x) => x.filePath === join(cwd, "report.txt"))
      ?.status,
    "modified",
  );
  const diff = await owner.host.workspaceOps.gitDiff(
    cwd,
    join(cwd, "report.txt"),
  );
  assert.ok(diff.ok);
  assert.ok(typeof diff.value.patch === "string");
  assert.match(diff.value.patch, /\+owning host after/);
  assert.deepEqual(await owner.host.workspaceOps.githubRepo(cwd), {
    ok: true,
    value: { repo: "example/owning-host" },
  });
  const outside = join(owner.home, "outside.txt");
  writeFileSync(outside, "outside workspace\n");
  symlinkSync(outside, join(cwd, "escape"));
  const denied = await owner.host.workspaceOps.gitDiff(
    cwd,
    join(cwd, "escape"),
  );
  assert.ok(!denied.ok);
  assert.equal(denied.status, 403);
  git("checkout", "--detach", "-q");
  const worktrees = await owner.host.workspaceOps.listWorktrees(cwd);
  assert.ok(worktrees.ok);
  assert.equal(worktrees.value.worktrees[0].branch, null);
});

test("Git actions execute on the owning daemon and preserve rebase conflicts", async (t) => {
  const f = await workspaceHarness();
  t.after(() => f.close());
  const owner = await f.startHost();
  const cwd = owner.project;
  const remote = join(f.root, "remote.git");
  const peer = join(f.root, "peer");
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(f.root, "init", "--bare", "-q", remote);
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Workspace test");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "remote", "add", "upstream", remote);
  writeFileSync(join(cwd, "shared.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "base");
  git(cwd, "push", "-u", "upstream", "main");
  writeFileSync(join(cwd, "pushed.txt"), "via configured upstream\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "push action");
  await owner.host.sessionOps.validateCwd(cwd);

  const push = await owner.host.workspaceOps.gitAction(cwd, "push");
  assert.ok(push.ok, JSON.stringify(push));
  assert.equal(
    git(remote, "rev-parse", "refs/heads/main").trim(),
    git(cwd, "rev-parse", "HEAD").trim(),
  );
  git(f.root, "clone", "-q", remote, peer);
  git(peer, "config", "user.name", "Workspace peer");
  git(peer, "config", "user.email", "peer@example.invalid");
  writeFileSync(join(peer, "peer.txt"), "peer\n");
  git(peer, "add", ".");
  git(peer, "commit", "-qm", "peer change");
  git(peer, "push", "-q");
  const rejected = await owner.host.workspaceOps.gitAction(cwd, "push");
  assert.ok(!rejected.ok);
  assert.equal(rejected.code, "git_action_failed");
  assert.match(rejected.error, /rejected|fetch first|non-fast-forward/i);
  assert.equal(
    git(remote, "rev-parse", "refs/heads/main").trim(),
    git(peer, "rev-parse", "HEAD").trim(),
  );
  const pull = await owner.host.workspaceOps.gitAction(cwd, "pull");
  assert.ok(pull.ok, JSON.stringify(pull));
  assert.equal(
    git(cwd, "rev-parse", "HEAD").trim(),
    git(peer, "rev-parse", "HEAD").trim(),
  );
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "tag", "main", "HEAD");
  git(cwd, "tag", "origin/main", "HEAD");

  git(cwd, "checkout", "-qb", "feature");
  writeFileSync(join(cwd, "feature.txt"), "feature\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "feature");
  git(cwd, "switch", "-q", "main");
  writeFileSync(join(cwd, "main.txt"), "main\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "main change");
  git(cwd, "checkout", "-q", "feature");
  const rebaseMain = await owner.host.workspaceOps.gitAction(
    cwd,
    "rebase-main",
  );
  assert.ok(rebaseMain.ok, JSON.stringify(rebaseMain));
  git(cwd, "merge-base", "--is-ancestor", "refs/heads/main", "HEAD");

  writeFileSync(join(peer, "another.txt"), "remote\n");
  git(peer, "add", ".");
  git(peer, "commit", "-qm", "remote change");
  git(peer, "push", "-q");
  const fetch = await owner.host.workspaceOps.gitAction(cwd, "fetch");
  assert.ok(fetch.ok, JSON.stringify(fetch));
  assert.equal(
    git(cwd, "rev-parse", "refs/remotes/origin/main").trim(),
    git(peer, "rev-parse", "HEAD").trim(),
  );
  const rebaseOrigin = await owner.host.workspaceOps.gitAction(
    cwd,
    "rebase-origin-main",
  );
  assert.ok(rebaseOrigin.ok, JSON.stringify(rebaseOrigin));
  git(cwd, "merge-base", "--is-ancestor", "refs/remotes/origin/main", "HEAD");

  writeFileSync(join(cwd, "shared.txt"), "local conflict\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "local conflict");
  writeFileSync(join(peer, "shared.txt"), "remote conflict\n");
  git(peer, "add", ".");
  git(peer, "commit", "-qm", "remote conflict");
  git(peer, "push", "-q");
  const fetchedConflict = await owner.host.workspaceOps.gitAction(cwd, "fetch");
  assert.ok(fetchedConflict.ok, JSON.stringify(fetchedConflict));
  const conflict = await owner.host.workspaceOps.gitAction(
    cwd,
    "rebase-origin-main",
  );
  assert.ok(!conflict.ok);
  assert.equal(conflict.code, "git_action_failed");
  assert.match(conflict.error, /conflict/i);
  assert.match(git(cwd, "status", "--porcelain"), /^UU shared\.txt/m);
  assert.match(git(cwd, "status"), /rebase in progress/i);
});

test("rebase rejects missing branches even when same-named tags exist", async (t) => {
  const f = await workspaceHarness();
  t.after(() => f.close());
  const owner = await f.startHost();
  const cwd = owner.project;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "feature");
  git("config", "user.name", "Workspace test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(cwd, "file.txt"), "content\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("tag", "main");
  git("tag", "origin/main");
  await owner.host.sessionOps.validateCwd(cwd);
  const head = git("rev-parse", "HEAD");
  for (const action of ["rebase-main", "rebase-origin-main"] as const) {
    const result = await owner.host.workspaceOps.gitAction(cwd, action);
    assert.ok(!result.ok);
    assert.equal(result.code, "git_action_failed");
    assert.equal(git("rev-parse", "HEAD"), head);
  }
});

test("gitOrigins answers each requested path in order with its origin and main-checkout state", async (t) => {
  const f = await workspaceHarness();
  t.after(() => f.close());
  const owner = await f.startHost();
  const dir = (name: string) => {
    const path = join(owner.home, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args]);
  const one = dir("one");
  git(one, "init", "-q");
  git(one, "remote", "add", "origin", "https://example.invalid/one.git");
  const none = dir("none");
  git(none, "init", "-q");
  const many = dir("many");
  git(many, "init", "-q");
  git(many, "remote", "add", "origin", "https://example.invalid/a.git");
  git(
    many,
    "remote",
    "set-url",
    "--add",
    "origin",
    "https://example.invalid/b.git",
  );
  const sub = join(one, "sub");
  mkdirSync(sub);
  const plain = dir("plain");
  const foreign = join(f.root, "foreign");
  mkdirSync(foreign);
  git(foreign, "init", "-q");
  for (const path of [one, none, many, plain])
    assert.equal((await owner.host.sessionOps.addProject(path)).ok, true);
  const paths = [
    plain,
    many,
    sub,
    join(owner.home, "missing"),
    one,
    foreign,
    none,
  ];
  const answer = await owner.host.workspaceOps.gitOrigins(paths);
  assert.deepEqual(answer, {
    ok: true,
    value: {
      origins: [
        { path: plain, origin: null, mainCheckout: false },
        { path: many, origin: null, mainCheckout: true },
        {
          path: sub,
          origin: "https://example.invalid/one.git",
          mainCheckout: false,
        },
        {
          path: join(owner.home, "missing"),
          origin: null,
          mainCheckout: false,
        },
        {
          path: one,
          origin: "https://example.invalid/one.git",
          mainCheckout: true,
        },
        { path: foreign, origin: null, mainCheckout: false },
        { path: none, origin: null, mainCheckout: true },
      ],
    },
  });
  const tooMany = await owner.host.workspaceOps.gitOrigins(
    Array.from({ length: 501 }, () => one),
  );
  assert.ok(!tooMany.ok);
  assert.equal(tooMany.status, 400);
});

test("gitOrigins rejects malformed input, drops unusable origins, keeps order across batches and honours its budget", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-git-origins-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const { grantWorkspaceRoot } = await import("./workspace-roots.ts");
  const { createWorkspaceService, gitOriginLimits } =
    await import("./workspace-ops.ts");
  const { StagedUploads } = await import("./uploads.ts");
  const service = createWorkspaceService(new StagedUploads(() => {}), () => {});
  const budget = gitOriginLimits.budgetMs;
  t.after(() => {
    gitOriginLimits.budgetMs = budget;
    service.stop();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  grantWorkspaceRoot(root);
  const repo = (name: string, url?: string) => {
    const path = join(root, name);
    mkdirSync(path);
    execFileSync("git", ["-C", path, "init", "-q"]);
    if (url !== undefined)
      execFileSync("git", ["-C", path, "config", "remote.origin.url", url]);
    return path;
  };
  const gitOrigins = (paths: unknown[]) =>
    service.ops.gitOrigins(paths as string[]);
  for (const bad of [[null], [5], [""], ["x".repeat(4097)]]) {
    const failed = await gitOrigins(bad);
    assert.ok(!failed.ok);
    assert.equal(failed.status, 400);
  }
  const good = repo("good", "https://example.invalid/good.git");
  const unusable = [
    repo("empty", ""),
    repo("long", `https://example.invalid/${"a".repeat(3000)}`),
    repo("creds", "https://user:token@example.com/a/b"),
    repo("local", "/srv/local/repo"),
  ];
  const mixed = await gitOrigins([...unusable, good]);
  assert.ok(mixed.ok);
  assert.deepEqual(
    mixed.value.origins.map((entry) => entry.origin),
    [null, null, null, null, "https://example.invalid/good.git"],
  );
  assert.ok(mixed.value.origins.every((entry) => entry.mainCheckout));
  // An inherited GIT_DIR/GIT_WORK_TREE naming another repository is ignored: each path answers for itself.
  const elsewhere = repo("elsewhere", "https://example.invalid/elsewhere.git");
  const inherited = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  };
  Object.assign(process.env, {
    GIT_DIR: join(elsewhere, ".git"),
    GIT_WORK_TREE: elsewhere,
  });
  try {
    const result = await gitOrigins([good]);
    assert.ok(result.ok);
    assert.deepEqual(result.value.origins, [
      {
        path: good,
        origin: "https://example.invalid/good.git",
        mainCheckout: true,
      },
    ]);
  } finally {
    for (const [name, value] of Object.entries(inherited))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
  const many = Array.from({ length: 20 }, (_, i) =>
    repo(`r${i}`, `https://example.invalid/r${i}.git`),
  );
  const manyResults = await gitOrigins(many);
  assert.ok(manyResults.ok);
  assert.deepEqual(
    manyResults.value.origins.map((entry) => entry.origin),
    many.map((_, i) => `https://example.invalid/r${i}.git`),
  );
  gitOriginLimits.budgetMs = 0;
  const timedOut = await gitOrigins([good]);
  assert.ok(timedOut.ok);
  assert.deepEqual(timedOut.value.origins, [
    { path: good, origin: null, mainCheckout: false },
  ]);
});
