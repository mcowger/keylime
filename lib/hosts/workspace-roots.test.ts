import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("credential exclusion follows a symlinked agent root as well as a workspace alias", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-workspace-secrets-"));
  const workspace = join(dir, "workspace");
  const backing = join(dir, "credential-store");
  const agent = join(dir, "config", "agent");
  mkdirSync(workspace);
  mkdirSync(backing);
  mkdirSync(join(dir, "config"));
  writeFileSync(join(backing, "agent.db"), "secret bytes");
  symlinkSync(backing, agent, "dir");
  const link = join(workspace, "apparently-safe.txt");
  symlinkSync(join(backing, "agent.db"), link);
  const previous = {
    agent: process.env.PI_CODING_AGENT_DIR,
    config: process.env.PI_CONFIG_DIR,
  };
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.PI_CONFIG_DIR = join(dir, "config");
  t.after(() => {
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.config === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = previous.config;
    rmSync(dir, { recursive: true, force: true });
  });
  // Import after setting the fixture's installation paths, never the developer's credential store.
  const { authorizeFileAccess } = await import("../file-authorization.ts");
  const decision = await authorizeFileAccess(
    [link],
    null,
    false,
    new Set([workspace, agent]),
  );
  assert.ok(!decision.ok);
  assert.equal(decision.status, 403);
});

test("selecting a symlinked workspace authorizes that spelling but not child symlink escapes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-workspace-alias-"));
  const target = join(dir, "real");
  const alias = join(dir, "selected");
  mkdirSync(target);
  symlinkSync(target, alias, "dir");
  writeFileSync(join(target, "report.txt"), "workspace bytes");
  symlinkSync("/etc/hosts", join(target, "escape.txt"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  // Root discovery must use this test's private installation.
  const { grantWorkspaceRoot, getWorkspaceRoots } =
    await import("./workspace-roots.ts");
  const { authorizeFileAccess } = await import("../file-authorization.ts");
  grantWorkspaceRoot(alias);
  const roots = await getWorkspaceRoots();
  const selected = await authorizeFileAccess(
    [join(alias, "report.txt")],
    null,
    false,
    roots,
  );
  assert.equal(selected.ok, true);
  const escaped = await authorizeFileAccess(
    [join(alias, "escape.txt")],
    null,
    false,
    roots,
  );
  assert.ok(!escaped.ok);
  assert.equal(escaped.status, 403);
});

test("daemon temporary roots allow aliases but retain credential and symlink protections", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-workspace-temp-"));
  const agent = join(dir, "agent");
  mkdirSync(agent);
  const image = join(dir, "screenshot.png");
  const secret = join(agent, "agent.db");
  const escape = join(dir, "escape");
  writeFileSync(image, "image bytes");
  writeFileSync(secret, "secret bytes");
  symlinkSync("/etc/hosts", escape);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  // Import after setting the fixture's installation paths for module initialization.
  const { getWorkspaceRoots, invalidateWorkspaceRoots } = await import("./workspace-roots.ts");
  const { authorizeFileAccess } = await import("../file-authorization.ts");
  invalidateWorkspaceRoots();
  for (const owner of [undefined, { sessionId: "00000000-0000-4000-8000-000000000000", cwd: process.cwd() }]) {
    const roots = await getWorkspaceRoots(owner);
    for (const root of [tmpdir(), "/tmp", "/var/tmp"]) {
      if (existsSync(root)) {
        assert.ok(roots.has(root));
        assert.ok(roots.has(realpathSync(root)));
      }
    }
    for (const path of [image, realpathSync(image)]) {
      assert.equal((await authorizeFileAccess([path], null, false, roots)).ok, true);
    }
    for (const path of [secret, escape]) {
      const decision = await authorizeFileAccess([path], null, false, roots);
      assert.ok(!decision.ok);
      assert.equal(decision.status, 403);
    }
  }
});
