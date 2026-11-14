import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import {
  assertFrontendCompatible,
  prepareFrontend,
  selectFrontend,
} from "./deploy-frontend";

test("frontend releases retain assets and versioned workers across atomic selection", () => {
  const base = mkdtempSync(path.join(tmpdir(), "frontend-deploy-"));
  try {
    const old = path.join(base, "old");
    const next = path.join(base, "next");
    for (const dir of [old, next]) {
      mkdirSync(path.join(dir, "dist/assets"), { recursive: true });
      mkdirSync(path.join(dir, "public"));
      writeFileSync(path.join(dir, "dist/index.html"), "html");
    }
    writeFileSync(path.join(old, "dist/assets/old.js"), "old asset");
    writeFileSync(path.join(next, "dist/assets/new.js"), "new asset");
    writeFileSync(path.join(old, "dist/event-stream-worker.js"), "old worker");
    writeFileSync(path.join(next, "dist/event-stream-worker.js"), "new worker");
    prepareFrontend(old);
    selectFrontend(base, old);
    prepareFrontend(next, old);
    selectFrontend(base, next);
    expect(realpathSync(path.join(base, "frontend-current"))).toBe(
      realpathSync(next),
    );
    expect(readFileSync(path.join(next, "dist/assets/old.js"), "utf8")).toBe(
      "old asset",
    );
    for (const worker of ["old worker", "new worker"]) {
      const hash = createHash("sha256")
        .update(worker)
        .digest("hex")
        .slice(0, 12);
      expect(
        readFileSync(path.join(next, `dist/workers/${hash}.js`), "utf8"),
      ).toBe(worker);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("frontend retention refuses collisions instead of breaking old pages", () => {
  const base = mkdtempSync(path.join(tmpdir(), "frontend-collision-"));
  try {
    const old = path.join(base, "old");
    const next = path.join(base, "next");
    for (const dir of [old, next]) {
      mkdirSync(path.join(dir, "dist/assets"), { recursive: true });
      mkdirSync(path.join(dir, "public"));
      writeFileSync(path.join(dir, "dist/index.html"), "html");
      writeFileSync(path.join(dir, "dist/event-stream-worker.js"), "worker");
    }
    writeFileSync(path.join(old, "dist/assets/shared.js"), "old");
    writeFileSync(path.join(next, "dist/assets/shared.js"), "new");
    expect(() => prepareFrontend(next, old)).toThrow(
      "Conflicting retained frontend asset",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("frontend compatibility rejects unknown commits and shared changes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "frontend-git-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    mkdirSync(path.join(root, "components"));
    mkdirSync(path.join(root, "lib"));
    writeFileSync(path.join(root, "components/view.tsx"), "one");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(root, "components/view.tsx"), "two");
    git("add", ".");
    git("commit", "-m", "ui");
    const ui = git("rev-parse", "HEAD");
    expect(() => assertFrontendCompatible(root, base, ui)).not.toThrow();
    writeFileSync(path.join(root, "lib/protocol.ts"), "changed");
    git("add", ".");
    git("commit", "-m", "protocol");
    expect(() =>
      assertFrontendCompatible(root, base, git("rev-parse", "HEAD")),
    ).toThrow("backend or shared");
    expect(() => assertFrontendCompatible(root, "0".repeat(40), ui)).toThrow(
      "Cannot compare",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
