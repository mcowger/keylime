import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// The host modules read the agent directory during initialization, after this test sets it.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "keylime-chat-roles-"));
const { linkLocalHost, linkHost } = await import("./hosts/link-driver.test-helper");
const { closeHostLink } = await import("./hosts/hub");
const route = await import("../app/api/chat-roles/route");
const local = await linkLocalHost();
const remote = await linkHost("role host");
const calls: Array<{ host: string; cwd: unknown; currentProvider?: unknown; currentModelId?: unknown }> = [];
for (const link of [local, remote]) {
  link.serve({ chatRolesList: ({ cwd, thinkingLevel, currentProvider, currentModelId }) => {
    calls.push({ host: link.id, cwd, ...(currentProvider === undefined ? {} : { currentProvider, currentModelId }) });
    return { roles: [{ id: "default", provider: link.id, modelId: "model", modelName: "Model", thinkingLevel: null, effectiveThinkingLevel: thinkingLevel === "off" ? "off" : "medium" }] };
  } });
}
after(() => { closeHostLink(local.id); closeHostLink(remote.id); });

test("resolves chat roles on the selected host with the workspace path", async () => {
  const response = await route.GET(new Request(`http://localhost/api/chat-roles?hostId=${remote.id}&cwd=%2Fremote%2Frepo`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).roles[0].provider, remote.id);
  assert.deepEqual(calls, [{ host: remote.id, cwd: "/remote/repo" }]);
});

test("requires a workspace path before contacting a host", async () => {
  const response = await route.GET(new Request("http://localhost/api/chat-roles"));
  assert.equal(response.status, 400);
});

test("does not infer an inactive chat's inherited effort from a fresh runner", async () => {
  const response = await route.GET(new Request(`http://localhost/api/chat-roles?hostId=${remote.id}&cwd=%2Fremote%2Frepo&sessionId=12345678-1234-1234-1234-123456789abc`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).roles[0].effectiveThinkingLevel, null);
});

test("sends an inactive chat's composer effort to its owning host", async () => {
  const response = await route.GET(new Request(`http://localhost/api/chat-roles?hostId=${remote.id}&cwd=%2Fremote%2Frepo&sessionId=12345678-1234-1234-1234-123456789abc&thinkingLevel=off`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).roles[0].effectiveThinkingLevel, "off");
});

test("passes the known current model to the owning host", async () => {
  calls.length = 0;
  const response = await route.GET(new Request(`http://localhost/api/chat-roles?hostId=${remote.id}&cwd=%2Fremote%2Frepo&currentProvider=example&currentModelId=other`));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ host: remote.id, cwd: "/remote/repo", currentProvider: "example", currentModelId: "other" }]);
});

test("rejects incomplete or empty current model identities", async () => {
  const base = `http://localhost/api/chat-roles?hostId=${remote.id}&cwd=%2Fremote%2Frepo`;
  assert.equal((await route.GET(new Request(`${base}&currentProvider=example`))).status, 400);
  assert.equal((await route.GET(new Request(`${base}&currentProvider=example&currentModelId=`))).status, 400);
});
