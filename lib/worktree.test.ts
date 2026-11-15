import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { listWorktrees, removeWorktree, resolveProject } =
  await import("./worktree");
const { samePath } = await import("./paths");
function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, "-c", "safe.directory=*", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("discovers the main checkout and linked worktrees without retaining prunable paths", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not installed");
    return;
  }

  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "omp-web-worktree-test-")),
  );
  const repo = join(root, "repo");
  const worktreeBase = `${repo}-worktrees`;
  try {
    git(root, ["init", repo]);
    git(repo, ["config", "user.email", "omp-web@example.invalid"]);
    git(repo, ["config", "user.name", "omp-web test"]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "fixture"]);
    const main = await resolveProject(repo);
    assert.equal(main.isWorktree, false);
    assert.equal(main.isTopLevel, true);
    assert.ok(main.branch);

    const created = {
      path: join(worktreeBase, "feature-test"),
      branch: "feature/test",
    };
    git(repo, ["worktree", "add", "-b", created.branch, created.path]);
    assert.equal(created.branch, "feature/test");
    assert.equal(existsSync(created.path), true);

    const worktrees = await listWorktrees(repo);
    assert.equal(worktrees.length, 2);
    assert.equal(worktrees[0].isMain, true);
    assert.ok(
      worktrees.some(
        (entry) =>
          samePath(entry.path, created.path) && entry.branch === "feature/test",
      ),
    );

    const linked = await resolveProject(created.path);
    assert.equal(linked.projectRoot, main.projectRoot);
    assert.equal(linked.isWorktree, true);
    assert.equal(linked.branch, "feature/test");

    await removeWorktree(repo, created.path, true);
    assert.equal(existsSync(created.path), false);

    // When a directory still exists after removal (e.g. leftover .next/ on Windows),
    // resolveProject should still infer the project root back to the main repo.
    const dummyLeftover = join(worktreeBase, "dummy-branch");
    const inferred = await resolveProject(dummyLeftover);
    assert.equal(inferred.projectRoot, main.projectRoot);
    assert.equal(inferred.isWorktree, true);
    assert.equal(inferred.isTopLevel, true);
  } finally {
    rmSync(worktreeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
