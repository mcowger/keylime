import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeWorkspaceBranch } from "../workspace-branch";
import { hierarchyOperation } from "./project-hierarchy";
import {
  createWorkspace,
  workspaceCreationSettings,
  workspaceCreationStatus,
} from "./workspace-creation";

test("new branch normalization preserves valid names and produces Git-valid refs", () => {
  for (const name of [
    "Feature/KeepCase",
    "foo./bar",
    "foo/-bar",
    "foo/@",
    "head",
    "a.LOCK",
  ]) {
    assert.equal(sanitizeWorkspaceBranch(name), name);
    execFileSync("git", ["check-ref-format", "--branch", name], {
      stdio: "pipe",
    });
  }
  for (const name of [
    "option to Expand only latest thinking",
    " ../Feature//.hidden.lock ",
    "foo.lock.",
    "a@{b",
    "a..b",
    "a~^:?*[\\]b",
    "@{-1}",
  ]) {
    const normalized = sanitizeWorkspaceBranch(name);
    assert.ok(normalized);
    execFileSync("git", ["check-ref-format", "--branch", normalized], {
      stdio: "pipe",
    });
    assert.ok(!normalized.split("/").includes(".."));
  }
  for (const name of ["", "  ", "...///", "@", "HEAD", "***"]) {
    assert.equal(sanitizeWorkspaceBranch(name), "");
  }
});

test("workspace creation normalizes new branches but preserves existing refs", async () => {
  const temporary = realpathSync(
    mkdtempSync(path.join(tmpdir(), "keylime-branch-")),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
  const project = path.join(temporary, "repo");
  mkdirSync(project);
  const git = (...args) =>
    execFileSync("git", ["-C", project, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(path.join(project, "tracked"), "initial");
    git("add", ".");
    git("commit", "-m", "initial");
    git("branch", "existing./Local", "main");
    git("update-ref", "refs/remotes/origin/Remote", "main");
    git("remote", "add", "origin", project);
    const registration = await hierarchyOperation({
      action: "registerProject",
      path: project,
    });
    assert.equal(registration.ok, true, registration.error);
    await workspaceCreationSettings({
      projectPath: project,
      override: {
        pre: [
          'printf "%s\\n%s" "$OMP_BRANCH" "$OMP_BASE_REF" > "$OMP_PROJECT_PATH/pipeline-env"',
        ],
        create: [],
        post: [],
      },
    });
    const create = async (mode, branch, baseRef, expected) => {
      let job = await createWorkspace({
        projectPath: project,
        mode,
        branch,
        baseRef,
        name: branch,
      });
      assert.equal(job.input.branch, expected);
      assert.equal(job.input.baseRef, baseRef);
      const deadline = Date.now() + 10000;
      while (job.status === "running") {
        assert.ok(Date.now() < deadline);
        await Bun.sleep(15);
        job = await workspaceCreationStatus(job.id);
      }
      assert.equal(job.status, "complete", job.error ?? job.logs);
      assert.equal(
        job.workspacePath,
        path.join(
          `${project}-worktrees`,
          expected.replace(/[^a-zA-Z0-9._-]/g, "-"),
        ),
      );
      assert.equal(
        execFileSync(
          "git",
          ["-C", job.workspacePath, "branch", "--show-current"],
          { encoding: "utf8" },
        ).trim(),
        expected,
      );
      assert.equal(
        readFileSync(path.join(project, "pipeline-env"), "utf8"),
        `${expected}\n${baseRef}`,
      );
    };
    await create(
      "new",
      "option to Expand only latest thinking",
      "main",
      "option-to-Expand-only-latest-thinking",
    );
    await create(
      "remote",
      "Remote feature/Branch",
      "origin/Remote",
      "Remote-feature/Branch",
    );
    await create(
      "local",
      "existing./Local",
      "existing./Local",
      "existing./Local",
    );
    await assert.rejects(
      createWorkspace({
        projectPath: project,
        mode: "new",
        branch: "...///",
        baseRef: "main",
        name: "invalid",
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});
