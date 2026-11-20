import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "keylime-host-links-test-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const directory = join(agentDir, "keylime");
const file = join(directory, "host.json");
const lock = `${file}.lock`;
const primary = {
  url: "https://production.example",
  token: "production-token",
};
const staging = { url: "http://127.0.0.1:40000", token: "staging-token" };
const other = { url: "https://other.example", token: "other-token" };
// Import after installing the isolated agent directory.
const { loginHost, readHostLogin, removeHostLink } =
  await import("./host-login.ts");
const saved = () => JSON.parse(readFileSync(file, "utf8"));
const seed = (value: unknown) => writeFileSync(file, JSON.stringify(value));
beforeEach(() => {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
});
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

test("login replaces the controller, preserving unrelated config", async () => {
  assert.equal(readHostLogin(), null);
  seed({ ...primary, note: "keep" });
  await loginHost({ ...staging, url: `${staging.url}///` });
  assert.deepEqual(readHostLogin(), staging);
  assert.deepEqual(saved(), { ...staging, note: "keep" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await removeHostLink(primary.url);
  assert.deepEqual(readHostLogin(), staging);
  await removeHostLink(staging.url);
  assert.equal(readHostLogin(), null);
  assert.deepEqual(saved(), { note: "keep" });
});

test("malformed or unreadable configuration is never silently replaced", async () => {
  for (const contents of [
    "{broken",
    "null",
    "[]",
    '{"links":null}',
    '{"links":[{"url":"https://example.com"}]}',
    '{"url":123,"token":"keep"}',
  ]) {
    writeFileSync(file, contents);
    assert.throws(() => readHostLogin(), { name: "HostLoginUnreadableError" });
    for (const mutate of [
      () => loginHost(staging),
      () => removeHostLink(primary.url),
    ]) {
      await assert.rejects(mutate, { name: "HostLoginUnreadableError" });
      assert.equal(readFileSync(file, "utf8"), contents);
      assert.equal(existsSync(lock), false);
    }
  }
  rmSync(file);
  mkdirSync(file);
  await assert.rejects(loginHost(staging), {
    name: "HostLoginUnreadableError",
  });
  assert.equal(statSync(file).isDirectory(), true);
});

test("invalid inputs fail before changing saved credentials", async () => {
  seed(primary);
  await assert.rejects(
    loginHost({ url: "file:///tmp/server", token: "token" }),
    /https/,
  );
  await assert.rejects(loginHost({ url: primary.url, token: " \n " }), /empty/);
  assert.deepEqual(saved(), primary);
});

async function exitedChildPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return child.pid;
}

test("a lock with a proven exited owner is recovered, even when freshly written", async () => {
  seed(primary);
  writeFileSync(lock, JSON.stringify({ pid: await exitedChildPid() }), {
    mode: 0o600,
  });
  await loginHost(staging);
  assert.deepEqual(saved(), staging);
  assert.equal(existsSync(lock), false);
});

test(
  "a recovery mutex held by a live process blocks recovery until it is released",
  { timeout: 10_000 },
  async () => {
    seed(primary);
    const stale = JSON.stringify({ pid: await exitedChildPid() }),
      mutex = `${lock}.recover`;
    writeFileSync(lock, stale, { mode: 0o600 });
    writeFileSync(mutex, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    const mutation = loginHost(staging);
    await sleep(300);
    assert.equal(readFileSync(lock, "utf8"), stale);
    rmSync(mutex);
    await mutation;
    assert.deepEqual(saved(), staging);
    assert.equal(existsSync(mutex), false);
  },
);

test(
  "a recovery mutex whose owner exited does not block recovery forever",
  { timeout: 10_000 },
  async () => {
    seed(primary);
    const dead = JSON.stringify({ pid: await exitedChildPid() }),
      mutex = `${lock}.recover`;
    writeFileSync(lock, dead, { mode: 0o600 });
    writeFileSync(mutex, dead, { mode: 0o600 });
    await loginHost(staging);
    assert.deepEqual(saved(), staging);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(mutex), false);
  },
);

test(
  "a live owner's lock times out asynchronously without removing the lock",
  { timeout: 10_000 },
  async () => {
    seed(primary);
    const owner = JSON.stringify({ pid: process.pid });
    writeFileSync(lock, owner, { mode: 0o600 });
    const start = Date.now();
    const mutation = loginHost(staging);
    await sleep(25);
    assert.ok(
      Date.now() - start < 1_000,
      "waiting for a lock must not block the event loop",
    );
    assert.equal(readFileSync(lock, "utf8"), owner);
    await assert.rejects(mutation, /lock.*timed out|timed out.*lock/i);
    assert.ok(Date.now() - start >= 4_900);
    assert.ok(Date.now() - start < 8_000);
    assert.equal(readFileSync(lock, "utf8"), owner);
    assert.deepEqual(saved(), primary);
  },
);

test(
  "unknown lock ownership is not treated as a dead process",
  { timeout: 10_000 },
  async () => {
    writeFileSync(lock, "{incomplete");
    await assert.rejects(
      loginHost(staging),
      /lock.*timed out|timed out.*lock/i,
    );
    assert.equal(readFileSync(lock, "utf8"), "{incomplete");
    assert.equal(existsSync(file), false);
  },
);

const bin = fileURLToPath(new URL("../../bin/keylime.ts", import.meta.url));
function writer(t: test.TestContext, args: string[], token: string) {
  const child = spawn(process.execPath, [bin, "host", "login", ...args], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGKILL");
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(`${token}\n`);
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`writer exited ${code}: ${stderr}`)),
    );
  });
}

test(
  "concurrent child writers leave one complete credential pair",
  { timeout: 20_000 },
  async (t) => {
    const candidates = [staging, other];
    await Promise.all(
      candidates.map(({ url, token }) => writer(t, ["--url", url], token)),
    );
    const login = readHostLogin();
    assert.ok(
      candidates.some(
        ({ url, token }) => url === login?.url && token === login.token,
      ),
    );
    assert.deepEqual(saved(), login);
  },
);
