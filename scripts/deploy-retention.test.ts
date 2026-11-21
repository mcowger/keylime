import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneDeployReleases } from "./deploy-retention";

const releaseName = (n: number) => `abcdef123456-${1700000000000 + n}`;

test("retains recent releases and active and rollback selections across both release stores", () => {
  const base = mkdtempSync(path.join(tmpdir(), "keylime-retention-"));
  try {
    const full = path.join(base, "releases");
    const frontend = path.join(base, "frontend-releases");
    for (const root of [full, frontend]) {
      for (let i = 0; i < 6; i++)
        mkdirSync(path.join(root, releaseName(i)), { recursive: true });
    }
    const active = path.join(full, releaseName(0));
    const previous = path.join(full, releaseName(1));
    const frontendActive = path.join(frontend, releaseName(0));
    const frontendPrevious = path.join(frontend, releaseName(1));
    symlinkSync(active, path.join(base, "current"));
    symlinkSync(frontendActive, path.join(base, "frontend-current"));
    mkdirSync(path.join(full, "manual-release"));
    const external = path.join(base, "external");
    mkdirSync(external);
    symlinkSync(external, path.join(full, releaseName(9)));
    mkdirSync(path.join(base, "builds", releaseName(0)), { recursive: true });

    pruneDeployReleases(base, [previous, frontendPrevious]);

    for (const root of [full, frontend]) {
      for (const i of [0, 1, 3, 4, 5])
        expect(existsSync(path.join(root, releaseName(i)))).toBe(true);
      expect(existsSync(path.join(root, releaseName(2)))).toBe(false);
    }
    expect(existsSync(path.join(full, "manual-release"))).toBe(true);
    expect(existsSync(path.join(full, releaseName(9)))).toBe(true);
    expect(existsSync(external)).toBe(true);
    expect(existsSync(path.join(base, "builds", releaseName(0)))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("does not follow a symlinked release store", () => {
  const base = mkdtempSync(path.join(tmpdir(), "keylime-retention-"));
  try {
    const external = path.join(base, "external");
    mkdirSync(path.join(external, releaseName(0)), { recursive: true });
    symlinkSync(external, path.join(base, "releases"));
    expect(() => pruneDeployReleases(base, [])).toThrow(
      "Not a release directory",
    );
    expect(existsSync(path.join(external, releaseName(0)))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
