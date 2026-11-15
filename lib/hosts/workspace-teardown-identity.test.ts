import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hierarchyOperation, readHierarchy } from "./project-hierarchy";
import {
  createWorkspace,
  removeRegisteredWorktree,
  setWorkspaceDeletionAdapter,
  workspaceCreationSettings,
  workspaceCreationStatus,
} from "./workspace-creation";

for (const mutation of ["commit", "switch branch", "rewind default checkout"]) {
  test(`Paseo teardown cannot authorize deletion with stale history after ${mutation}`, async () => {
    const directory = realpathSync(
      mkdtempSync(path.join(tmpdir(), "paseo-identity-")),
    );
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(directory, "agent");
    const projectPath = path.join(directory, "repo");
    mkdirSync(projectPath);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    try {
      git(projectPath, "init", "-b", "main");
      git(projectPath, "config", "user.name", "Teardown fixture");
      git(projectPath, "config", "user.email", "teardown@example.invalid");
      git(projectPath, "config", "commit.gpgsign", "false");
      git(
        projectPath,
        "config",
        "core.hooksPath",
        path.join(directory, "no-hooks"),
      );
      writeFileSync(path.join(projectPath, "base.txt"), "base\n");
      git(projectPath, "add", "base.txt");
      git(projectPath, "commit", "-qm", "base");
      const base = git(projectPath, "rev-parse", "HEAD");
      writeFileSync(path.join(projectPath, "later.txt"), "later\n");
      git(projectPath, "add", "later.txt");
      git(projectPath, "commit", "-qm", "later");
      const initialHead = git(projectPath, "rev-parse", "HEAD");
      const registered = await hierarchyOperation({
        action: "registerProject",
        path: projectPath,
      });
      assert.ok(registered.ok, !registered.ok ? registered.error : undefined);
      writeFileSync(path.join(projectPath, "paseo.json"), "{}");
      await workspaceCreationSettings({ projectPath, source: "paseo" });
      let job = await createWorkspace({
        projectPath,
        branch: "feature",
        mode: "new",
        baseRef: "main",
        name: "Feature",
      });
      const deadline = Date.now() + 10_000;
      while (job.status === "running" && Date.now() < deadline) {
        await Bun.sleep(10);
        job = await workspaceCreationStatus(job.id);
      }
      assert.equal(job.status, "complete", job.error ?? job.logs);
      const workspacePath = job.workspacePath;
      assert.ok(workspacePath);
      const teardown =
        mutation === "commit"
          ? "printf 'new history\\n' > teardown.txt && git add teardown.txt && git commit -qm 'teardown commit'"
          : mutation === "switch branch"
            ? "git switch -c replacement"
            : `git -C "$PASEO_SOURCE_CHECKOUT_PATH" reset --hard ${base}`;
      writeFileSync(
        path.join(projectPath, "paseo.json"),
        JSON.stringify({ worktree: { teardown } }),
      );
      setWorkspaceDeletionAdapter({
        fence: () => () => {},
        inspect: async () => [],
        stop: async () => {},
      });
      let archiveCalled = false;
      await assert.rejects(
        removeRegisteredWorktree(
          {
            projectPath,
            path: workspacePath,
            stopProcesses: true,
            discardChanges: false,
            // Explicit permission about the old branch must not authorize history
            // which the teardown creates after that decision.
            keepBranch: false,
          },
          async () => {
            archiveCalled = true;
          },
        ),
        { status: 409, code: "paseo_teardown_changed_history" },
      );
      assert.equal(archiveCalled, false);
      assert.equal(existsSync(workspacePath), true);
      assert.equal(git(workspacePath, "status", "--porcelain"), "");
      assert.ok(
        readHierarchy().projects[0].workspaces.some(
          (workspace) => workspace.path === workspacePath,
        ),
      );
      if (mutation === "commit") {
        const retainedHead = git(workspacePath, "rev-parse", "HEAD");
        assert.notEqual(retainedHead, initialHead);
        assert.equal(
          git(projectPath, "rev-parse", "refs/heads/feature"),
          retainedHead,
        );
        assert.equal(
          readFileSync(path.join(workspacePath, "teardown.txt"), "utf8"),
          "new history\n",
        );
        assert.throws(() =>
          git(projectPath, "merge-base", "--is-ancestor", retainedHead, "main"),
        );
      } else if (mutation === "switch branch") {
        assert.equal(
          git(workspacePath, "symbolic-ref", "--short", "HEAD"),
          "replacement",
        );
        assert.equal(
          git(projectPath, "rev-parse", "refs/heads/feature"),
          initialHead,
        );
      } else {
        assert.equal(git(projectPath, "rev-parse", "HEAD"), base);
        assert.equal(git(workspacePath, "rev-parse", "HEAD"), initialHead);
        assert.equal(
          git(projectPath, "rev-parse", "refs/heads/feature"),
          initialHead,
        );
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
