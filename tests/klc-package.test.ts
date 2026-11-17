import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the client builder rejects unsupported targets", () => {
  for (const target of ["bun-windows-x64", "bun-linux-arm64-baseline", "bun-linux-x64-modern"]) {
    const result = spawnSync(process.execPath, ["scripts/build-klc-binary.ts", "--target", target], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported target/);
  }
});

test("the standalone klc archive contains an executable and its licenses, not server assets", { timeout: 120_000 }, () => {
  const release = mkdtempSync(path.join(os.tmpdir(), "klc-package-"));
  try {
    execFileSync(process.execPath, ["scripts/build-klc-binary.ts", "--out-dir", release], {
      cwd: repo,
      stdio: "pipe",
      timeout: 115_000,
    });
    const name = `klc-${process.platform}-${process.arch}`;
    const dir = path.join(release, name);
    assert.deepEqual(readdirSync(dir).sort(), ["LICENSE", "klc", "licenses"]);
    const extracted = path.join(release, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", path.join(release, `${name}.tar.gz`), "-C", extracted]);
    const binary = path.join(extracted, name, "klc");
    assert.ok(statSync(binary).mode & 0o111);
    const help = execFileSync(binary, ["--help"], { encoding: "utf8", timeout: 10_000 });
    assert.match(help, /klc/i);
    const notices = readFileSync(path.join(dir, "licenses/README.md"), "utf8");
    assert.match(notices, /Bun \(the runtime in `klc`\)/);
    assert.match(notices, /@oh-my-pi\/pi-tui/);
    assert.ok(notices.includes(`@oh-my-pi/pi-natives-${process.platform}-${process.arch}`));
    const nativePackage = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`;
    const nativesRoot = path.dirname(Bun.resolveSync("@oh-my-pi/pi-natives", path.join(repo, "runner")));
    const nativeDir = path.dirname(Bun.resolveSync(`${nativePackage}/package.json`, nativesRoot));
    const { version } = JSON.parse(readFileSync(path.join(nativeDir, "package.json"), "utf8")) as { version: string };
    const noticePath = `${nativePackage}@${version}/THIRD-PARTY-NOTICES.txt`;
    assert.ok(notices.includes(noticePath));
    assert.equal(
      readFileSync(path.join(extracted, name, "licenses", noticePath), "utf8"),
      readFileSync(path.join(nativeDir, "THIRD-PARTY-NOTICES.txt"), "utf8"),
    );
    assert.doesNotMatch(notices, /dist\/|KaTeX/);
    assert.ok(readFileSync(path.join(dir, "licenses/bun/LICENSE.md"), "utf8").length > 0);
    const entries = execFileSync("tar", ["-tzf", path.join(release, `${name}.tar.gz`)], { encoding: "utf8" });
    assert.match(entries, new RegExp(`${name}/klc`));
    assert.match(entries, new RegExp(`${name}/licenses/bun/LICENSE\\.md`));
    assert.doesNotMatch(entries, /(?:dist|public|node_modules|keylime-omp)\//);
  } finally {
    rmSync(release, { recursive: true, force: true });
  }
});
