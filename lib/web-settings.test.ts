import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadBrowserSettings,
  loadHostSettings,
  loadLocalAgentEnv,
  saveBrowserSettings,
  saveHostSettings,
} from "./web-settings";

function withAgentDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "keylime-settings-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const defaults = {
  autoResumeSessions: false,
  agentToolsEnabled: false,
  uploadRetentionDays: null,
};

test("host policy and browser transport have independent defaults and writes", () => {
  withAgentDir((dir) => {
    assert.deepEqual(loadHostSettings(), defaults);
    assert.deepEqual(loadBrowserSettings(), { browserTransport: "ws" });
    saveBrowserSettings({ browserTransport: "sse" });
    saveHostSettings({ autoResumeSessions: true, agentToolsEnabled: true });
    saveHostSettings({ uploadRetentionDays: null });
    assert.deepEqual(loadHostSettings(), {
      autoResumeSessions: true,
      agentToolsEnabled: true,
      uploadRetentionDays: null,
    });
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(dir, "keylime-browser-settings.json"), "utf8"),
      ),
      { browserTransport: "sse" },
    );
    assert.equal(loadBrowserSettings().browserTransport, "sse");
  });
});

test("host policy preserves private operator environment and rejects attempts to change it", () => {
  withAgentDir((dir) => {
    const file = join(dir, "keylime-settings.json");
    const agentEnv = {
      OBSIDIAN_API_KEY: "local-secret",
      PATH: "untrusted",
      INVALID_VALUE: 123,
    };
    writeFileSync(file, JSON.stringify({ agentEnv, browserTransport: "sse" }));
    chmodSync(file, 0o644);
    assert.deepEqual(loadBrowserSettings(), { browserTransport: "ws" });
    for (const patch of [
      { agentEnv: {} },
      { browserTransport: "sse" },
      { uploadRetentionDays: 0 },
      { autoResumeSessions: "true" },
      { agentToolsEnabled: null },
    ]) {
      assert.throws(
        () => saveHostSettings(patch),
        /Invalid host settings patch/,
      );
    }
    assert.deepEqual(saveHostSettings({ autoResumeSessions: true }), {
      ...defaults,
      autoResumeSessions: true,
    });
    assert.deepEqual(loadLocalAgentEnv(), { OBSIDIAN_API_KEY: "local-secret" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).agentEnv, agentEnv);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test("retention preserves the locally stored policy until a host patch overrides it", () => {
  withAgentDir((dir) => {
    mkdirSync(join(dir, "keylime"));
    const old = join(dir, "keylime", "upload-retention.json");
    writeFileSync(old, JSON.stringify({ days: null }));
    assert.equal(loadHostSettings().uploadRetentionDays, null);
    saveHostSettings({ uploadRetentionDays: 90 });
    assert.equal(loadHostSettings().uploadRetentionDays, 90);
    assert.deepEqual(JSON.parse(readFileSync(old, "utf8")), { days: null });
  });
});

test("manually edited or malformed settings are read without a stale cache", () => {
  withAgentDir((dir) => {
    const file = join(dir, "keylime-settings.json");
    assert.deepEqual(loadHostSettings(), defaults);
    writeFileSync(file, JSON.stringify({ autoResumeSessions: true }));
    assert.equal(loadHostSettings().autoResumeSessions, true);
    writeFileSync(file, "{ not json");
    assert.deepEqual(loadHostSettings(), defaults);
  });
});
