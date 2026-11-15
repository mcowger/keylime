import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readPaseo, copyPaseoIncludes } from "./workspace-paseo";
import { hierarchyOperation } from "./project-hierarchy";
import { workspaceCreationSettings, createWorkspace, workspaceCreationStatus, removeRegisteredWorktree, setWorkspaceDeletionAdapter } from "./workspace-creation";

test("Paseo snapshots live configuration and applies Git include semantics safely", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-test-"));
  const project = path.join(dir, "source"), target = path.join(dir, "target");
  fs.mkdirSync(project); fs.mkdirSync(target);
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
  try {
    git("init");
    fs.writeFileSync(path.join(project, ".gitignore"), "*.env\n");
    fs.writeFileSync(path.join(project, ".worktreeinclude"), "*.env\n!skip.env\n");
    fs.writeFileSync(path.join(project, "one.env"), "secret");
    fs.writeFileSync(path.join(project, "skip.env"), "skip");
    fs.writeFileSync(path.join(project, "paseo.json"), JSON.stringify({ worktree: { setup: "first\nsecond" } }));
    const first = readPaseo(project);
    assert.deepEqual(first.setup, ["first", "second"]);
    fs.writeFileSync(path.join(project, "paseo.json"), JSON.stringify({ worktree: { setup: ["new"] } }));
    fs.writeFileSync(path.join(project, "paseo.json"), JSON.stringify({ worktree: { setup: ["first\nsecond"], teardown: "first\nsecond" } }));
    assert.deepEqual(readPaseo(project).setup, ["first\nsecond"]);
    assert.deepEqual(readPaseo(project).teardown, ["first\nsecond"]);
    assert.notEqual(first.fingerprint, readPaseo(project).fingerprint);
    copyPaseoIncludes(project, target, first);
    assert.equal(fs.readFileSync(path.join(target, "one.env"), "utf8"), "secret");
    assert.equal(fs.existsSync(path.join(target, "skip.env")), false);
    fs.writeFileSync(path.join(target, "one.env"), "existing destination");
    copyPaseoIncludes(project, target, first);
    assert.equal(fs.readFileSync(path.join(target, "one.env"), "utf8"), "existing destination");
    fs.symlinkSync("/etc/passwd", path.join(project, "link.env"));
    fs.rmSync(path.join(target, "one.env"));
    assert.throws(() => copyPaseoIncludes(project, target, first), /Unsafe/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Paseo overrides manual commands and uses current source recipe for teardown", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paseo-life-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  const project = path.join(dir, "repo"); fs.mkdirSync(project);
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
  try {
    git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    fs.writeFileSync(path.join(project, "tracked"), "x"); git("add", "."); git("commit", "-m", "init");
    assert.equal((await hierarchyOperation({ action: "registerProject", path: project })).ok, true);
    assert.deepEqual((await workspaceCreationSettings({ projectPath: project, paseoBlocking: [] })).paseoBlocking, []);
    await workspaceCreationSettings({ projectPath: project, override: { pre: ["exit 9"], create: [], postBlocking: [], postNonBlocking: [] }, source: "paseo" });
    assert.ok((await workspaceCreationSettings({ projectPath: project })).paseo.error);
    fs.writeFileSync(path.join(project, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(project, ".worktreeinclude"), ".env\n");
    fs.writeFileSync(path.join(project, ".env"), "copied");
    fs.writeFileSync(path.join(project, "paseo.json"), JSON.stringify({ worktree: { setup: "test \"$(cat .env)\" = copied", teardown: "exit 0" } }));
    const selected = [{ index: 0, command: 'test "$(cat .env)" = copied' }];
    await workspaceCreationSettings({ projectPath: project, paseoBlocking: selected });
    assert.deepEqual((await workspaceCreationSettings({ projectPath: project })).paseoBlocking, selected);
    await assert.rejects(workspaceCreationSettings({ projectPath: project, paseoBlocking: [{ index: 0, command: "other" }] }), /Invalid Paseo/);
    fs.writeFileSync(path.join(project, "paseo.json"), JSON.stringify({ worktree: { setup: "changed" } }));
    await assert.rejects(createWorkspace({ projectPath: project, branch: "feature", mode: "new", baseRef: "main", name: "Feature" }), /review blocking commands/);
    fs.writeFileSync(path.join(project, "paseo.json"), "invalid json");
    assert.deepEqual((await workspaceCreationSettings({ projectPath: project, paseoBlocking: [] })).paseoBlocking, []);
    fs.writeFileSync(path.join(project, "paseo.json"), JSON.stringify({ worktree: { setup: selected[0].command } }));
    await workspaceCreationSettings({ projectPath: project, paseoBlocking: selected });
    fs.writeFileSync(path.join(project, "paseo.json"), JSON.stringify({ worktree: { setup: selected[0].command, teardown: "exit 0" } }));
    let job = await createWorkspace({ projectPath: project, branch: "feature", mode: "new", baseRef: "main", name: "Feature" });
    while (job.status === "running") { await Bun.sleep(15); job = await workspaceCreationStatus(job.id); }
    assert.equal(job.status, "complete", job.error);
    fs.writeFileSync(path.join(job.workspacePath, "paseo.json"), JSON.stringify({ worktree: { teardown: "exit 0" } }));
    fs.writeFileSync(path.join(project, "paseo.json"), JSON.stringify({ worktree: { teardown: "echo current-recipe; exit 7" } }));
    setWorkspaceDeletionAdapter({ fence: () => () => {}, inspect: async () => [], stop: async () => {} });
    await assert.rejects(removeRegisteredWorktree({ projectPath: project, path: job.workspacePath, stopProcesses: true, discardChanges: true, keepBranch: true }), /current-recipe/);
    assert.ok(fs.existsSync(job.workspacePath));
    await workspaceCreationSettings({ projectPath: project, source: "manual" });
    assert.deepEqual((await workspaceCreationSettings({ projectPath: project })).override.pre, ["exit 9"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
