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
import { readDeployState } from "./deploy-state";

test.each([
  ["symlink", "Not a Keylime release directory"],
  ["directory", "must be a symlink to the active release"],
])("checks staged deploy prerequisites with %s", (layout, error) => {
  const home = mkdtempSync(path.join(tmpdir(), "keylime-deploy-local-"));
  const base = path.join(home, ".local/share/keylime");
  const current = path.join(base, "current");
  const candidate = path.join(home, "invalid-release");
  try {
    // No release metadata, so activation cannot reach production services.
    mkdirSync(candidate);
    mkdirSync(base, { recursive: true });
    const oldRelease = path.join(
      base,
      "releases",
      "abcdef123456-1700000000000",
    );
    mkdirSync(oldRelease, { recursive: true });
    for (let i = 1; i <= 3; i++)
      mkdirSync(
        path.join(base, "releases", `abcdef123456-${1700000000000 + i}`),
      );
    if (layout === "symlink") {
      const active = path.join(base, "releases", "active");
      mkdirSync(active, { recursive: true });
      symlinkSync(active, current);
    } else {
      mkdirSync(current);
    }
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        path.join(import.meta.dir, "deploy-local.ts"),
        "--activate",
        candidate,
        "--timeout",
        "10",
        "--follow",
      ],
      { env: { ...process.env, HOME: home }, timeout: 20_000 },
    );
    expect(result.stdout.toString()).toContain(error);
    expect(result.exitCode).toBe(1);
    expect(readDeployState(base)?.phase).toBe("failed");
    expect(existsSync(oldRelease)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
