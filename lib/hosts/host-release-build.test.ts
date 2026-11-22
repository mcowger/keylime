import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHostReleaseBuilder } from "./host-release-build";

async function fixture(mode = "success", arch = "arm64") {
  const root = await mkdtemp(join(tmpdir(), "keylime-build-test-"));
  const source = join(root, "source");
  const bin = join(root, "bin");
  const log = join(root, "calls");
  await mkdir(source);
  await mkdir(bin);
  await writeFile(join(source, "snapshot"), "committed source");
  const tar = Bun.spawnSync([
    "tar",
    "-cf",
    join(root, "keylime-source.tar"),
    "-C",
    source,
    ".",
  ]);
  if (tar.exitCode !== 0) throw new Error("Could not create test archive");
  await writeFile(
    join(bin, "mise"),
    `#!/bin/sh
printf '%s|%s\n' "$PWD" "$*" >> "$TEST_LOG"
case "$*" in
  *scripts/build-release-binaries.ts*)
    if [ "$TEST_MODE" = fail ]; then echo 'secret output' >&2; exit 1; fi
    if [ "$TEST_MODE" = block ]; then touch "$TEST_LOG.ready"; exec sleep 60; fi
    case "$*" in *bun-linux-x64-baseline*) name=keylime-linux-x64 ;; *) name=keylime-linux-arm64 ;; esac
    mkdir -p "release/$name"
    cp snapshot "release/$name/keylime"
    cp snapshot "release/$name/keylime-omp"
    chmod +x "release/$name/keylime" "release/$name/keylime-omp"
    if [ "$TEST_MODE" = incomplete ]; then rm "release/$name/keylime-omp"; fi
    ;;
esac
`,
    { mode: 0o755 },
  );
  if (mode === "race") {
    await writeFile(
      join(bin, "mv"),
      `#!/bin/sh
mkdir -p "$3/keylime-linux-arm64"
printf existing > "$3/keylime-linux-arm64/keep"
exec /bin/mv "$@"
`,
      { mode: 0o755 },
    );
  }
  const build = createHostReleaseBuilder({
    target: () => ({ platform: "linux", arch }),
    packageDir: () => root,
    environment: () => ({
      PATH: `${bin}:${process.env.PATH}`,
      TEST_LOG: log,
      TEST_MODE: mode,
    }),
  });
  return { root, log, build };
}

async function waitFor(path: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), (_event, name) => {
    if (name === basename(path) && existsSync(path)) resolve();
  });
  try {
    if (existsSync(path)) return;
    await promise;
  } finally {
    watcher.close();
  }
}

test("builds the archived source for the selected target and publishes the complete pair", async () => {
  const { root, log, build } = await fixture("success", "x64");
  try {
    await build("host", new AbortController().signal);
    const output = join(root, "host-releases", "keylime-linux-x64");
    expect(await readFile(join(output, "keylime"), "utf8")).toBe(
      "committed source",
    );
    expect(await readFile(join(output, "keylime-omp"), "utf8")).toBe(
      "committed source",
    );
    const calls = await readFile(log, "utf8");
    expect(calls).toContain("trust");
    expect(calls).toContain("install --frozen-lockfile");
    expect(calls).toContain("--target bun-linux-x64-baseline --no-archive");
    expect(existsSync(calls.split("|")[0])).toBe(false);
    expect(
      (await readdir(join(root, "host-releases"))).filter((name) =>
        name.startsWith(".keylime-"),
      ),
    ).toEqual([]);
    await expect(
      build("host", new AbortController().signal),
    ).rejects.toMatchObject({ code: "release_build_exists" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a missing archive and hides build subprocess output", async () => {
  const { root, build } = await fixture("fail");
  try {
    const failure = await build("host", new AbortController().signal).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "release_build_failed",
      message: expect.stringContaining("binary compilation"),
    });
    expect(String(failure)).not.toContain("secret output");
    expect(existsSync(join(root, "host-releases", "keylime-linux-arm64"))).toBe(
      false,
    );
    await rm(join(root, "keylime-source.tar"));
    await expect(
      build("host", new AbortController().signal),
    ).rejects.toMatchObject({ code: "release_source_unavailable" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not publish an incomplete binary pair", async () => {
  const { root, build } = await fixture("incomplete");
  try {
    await expect(
      build("host", new AbortController().signal),
    ).rejects.toMatchObject({ code: "release_build_failed" });
    expect(existsSync(join(root, "host-releases", "keylime-linux-arm64"))).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not overwrite a destination created during publication", async () => {
  const { root, build } = await fixture("race");
  try {
    await expect(
      build("host", new AbortController().signal),
    ).rejects.toMatchObject({ code: "release_build_exists" });
    const output = join(root, "host-releases", "keylime-linux-arm64");
    expect(await readFile(join(output, "keep"), "utf8")).toBe("existing");
    expect(await readdir(output)).toEqual(["keep"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes builds and aborts a running process before cleanup", async () => {
  const { root, log, build } = await fixture("block");
  const controller = new AbortController();
  const first = build("host", controller.signal);
  try {
    await waitFor(`${log}.ready`);
    await expect(
      build("host", new AbortController().signal),
    ).rejects.toMatchObject({ code: "release_build_busy" });
    controller.abort();
    await expect(first).rejects.toMatchObject({
      code: "release_build_cancelled",
    });
    const calls = await readFile(log, "utf8");
    expect(existsSync(calls.split("|")[0])).toBe(false);
    expect(existsSync(join(root, "host-releases", "keylime-linux-arm64"))).toBe(
      false,
    );
  } finally {
    controller.abort();
    await first.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
