import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  watchApiContracts,
  type ApiContractWatcher,
} from "./dev-api-contracts";

const fixture = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const log = "events.log";
const count = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(line => line.startsWith("start ")).length + 1 : 1;
appendFileSync(log, "start " + count + " " + process.pid + "\\n");
mkdirSync("docs/api", { recursive: true });
writeFileSync("docs/api/generated.json", String(count));
if (existsSync("fail")) process.exit(7);
while (!existsSync("release-" + count)) await Bun.sleep(10);
appendFileSync(log, "end " + count + "\\n");
`;

function project() {
  const root = mkdtempSync(path.join(tmpdir(), "keylime-api-watch-"));
  for (const dir of [
    "scripts",
    "lib",
    "app/api",
    "runner/src",
    "server",
    "docs/api",
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, "scripts/generate-api-docs.ts"), fixture);
  return root;
}

function events(root: string) {
  const log = path.join(root, "events.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

test("watcher serializes changes during generation, coalesces bursts and ignores outputs", async () => {
  const root = project();
  const errors: unknown[] = [];
  const watcher = watchApiContracts(root, { ...process.env }, (error) =>
    errors.push(error),
  );
  try {
    const first = watcher.start();
    assert.equal(watcher.start(), first);
    await until(() => events(root).length === 1, "first generation");
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(root, "lib", `contract-${i}.ts`), String(i));
    }
    // Real fs.watch delivery and debounce use the platform clock, not fake timers.
    await Bun.sleep(300);
    assert.equal(events(root).length, 1);
    writeFileSync(path.join(root, "release-1"), "");
    await first;
    await until(
      () => events(root).some((line) => line.startsWith("start 2 ")),
      "follow-up generation",
    );
    assert.match(events(root).join("\n"), /^start 1 \d+\nend 1\nstart 2 \d+$/);
    writeFileSync(path.join(root, "release-2"), "");
    await until(() => events(root).includes("end 2"), "follow-up completion");
    writeFileSync(
      path.join(root, "docs/api/generated.json"),
      "external output change",
    );
    // Observe a full real debounce interval to detect an unexpected third child.
    await Bun.sleep(350);
    assert.equal(
      events(root).filter((line) => line.startsWith("start ")).length,
      2,
    );
    assert.deepEqual(errors, []);
  } finally {
    await watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation failure reaches the error handler and stops the watcher", async () => {
  const root = project();
  const errors: unknown[] = [];
  let watcher: ApiContractWatcher;
  watcher = watchApiContracts(root, { ...process.env }, (error) => {
    errors.push(error);
    void watcher.close();
  });
  try {
    writeFileSync(path.join(root, "release-1"), "");
    await watcher.start();
    writeFileSync(path.join(root, "fail"), "");
    writeFileSync(path.join(root, "lib/changed.ts"), "change");
    await until(() => errors.length === 1, "failure callback");
    writeFileSync(path.join(root, "lib/after-failure.ts"), "change");
    // The real watcher and debounce must remain stopped after failure.
    await Bun.sleep(350);
    assert.equal(
      events(root).filter((line) => line.startsWith("start ")).length,
      2,
    );
  } finally {
    await watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing aborts and waits for the active generator", async () => {
  const root = project();
  const errors: unknown[] = [];
  const watcher = watchApiContracts(root, { ...process.env }, (error) =>
    errors.push(error),
  );
  try {
    const generation = watcher.start();
    // Attach the rejection handler before aborting the child.
    const rejected = assert.rejects(generation, /cancelled/);
    await until(() => events(root).length === 1, "blocked child");
    const pid = Number(events(root)[0].split(" ")[2]);
    await watcher.close();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(errors, []);
    assert.equal(events(root).length, 1);
  } finally {
    await watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});
