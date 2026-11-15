import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { filePathApiSegments } from "../file-paths.ts";
import { workspaceHarness } from "./workspace-test-helper.ts";

test("directory navigation and scratch creation stay on their host, and browsing grants no file access", async (t) => {
  const f = await workspaceHarness();
  t.after(() => f.close());
  const owner = await f.startHost(),
    other = await f.startHost();
  const homeResult = await owner.host.workspaceOps.home();
  assert.ok(homeResult.ok);
  const home = homeResult.value.home;
  const folder = join(home, "browse-only");
  mkdirSync(folder);
  writeFileSync(join(folder, "private.txt"), "owning machine");
  const browsed = await owner.host.workspaceOps.browseDirectories("~");
  assert.ok(browsed.ok);
  assert.equal(browsed.value.path, home);
  assert.ok(browsed.value.directories.some((x) => x.path === folder));
  const input = { segments: filePathApiSegments(folder), sessionId: null };
  const denied = await owner.host.workspaceOps.listFiles(input, false);
  assert.ok(!denied.ok);
  assert.equal(denied.status, 403);
  await owner.host.sessionOps.validateCwd(folder);
  assert.equal(
    (await owner.host.workspaceOps.listFiles(input, false)).ok,
    true,
  );
  const foreign = await other.host.workspaceOps.listFiles(input, false);
  assert.ok(!foreign.ok);
  assert.equal(foreign.status, 403);
  const scratch = await owner.host.workspaceOps.defaultCwd();
  assert.ok(scratch.ok);
  assert.equal(scratch.value.cwd.startsWith(join(home, "omp-cwd-")), true);
  assert.equal(
    (
      await owner.host.workspaceOps.listFiles(
        { segments: filePathApiSegments(scratch.value.cwd), sessionId: null },
        false,
      )
    ).ok,
    true,
  );
  const foreignScratch = await other.host.workspaceOps.listFiles(
    { segments: filePathApiSegments(scratch.value.cwd), sessionId: null },
    false,
  );
  assert.ok(!foreignScratch.ok);
  assert.equal(foreignScratch.status, 403);
});
