import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { mock } from "bun:test";
import { invalidateModelsCache } from "./models-cache";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "keylime-models-route-"));
// Import the route after installing the utility mock so its dependencies bind to the fake runner.
const utilityPath = join(import.meta.dir, "omp/rpc-utility.ts");
const realUtility = { ...(await import(utilityPath)) };
const commands: string[] = [];
let modelId = "old";
let refreshGate: Promise<void> | undefined;
let failRefresh = false;
mock.module(utilityPath, () => ({
  ...realUtility,
  disposeUtilityRpc: () => {},
  runUtilityCommand: async (command: { type: string }) => {
    commands.push(command.type);
    if (command.type === "refresh_available_models") {
      await refreshGate;
      if (failRefresh) throw new Error("provider secret");
      modelId = "new";
    }
    if (command.type === "refresh_available_models" || command.type === "get_available_models") {
      return { models: [{ provider: "test", id: modelId, name: modelId }] };
    }
    if (command.type === "get_login_providers") return { providers: [] };
    if (command.type === "get_state") return {};
    throw new Error(`Unexpected command: ${command.type}`);
  },
}));
const route = await import("../app/api/models/route.ts");
after(() => mock.module(utilityPath, () => realUtility));
beforeEach(() => {
  invalidateModelsCache();
  commands.length = 0;
  modelId = "old";
  refreshGate = undefined;
  failRefresh = false;
});

test("POST refresh bypasses the cached snapshot and concurrent GET joins it", async () => {
  const old = await (await route.GET()).json();
  assert.equal(old.modelList[0].id, "old");
  const gate = Promise.withResolvers<void>();
  refreshGate = gate.promise;
  const post = route.POST();
  const get = route.GET();
  gate.resolve();
  const postResponse = await post;
  const updated = await postResponse.json();
  const read = await (await get).json();
  assert.equal(postResponse.status, 200);
  assert.equal(updated.modelList[0].id, "new");
  assert.deepEqual(read, updated);
  assert.equal(commands.filter((type) => type === "refresh_available_models").length, 1);
  assert.equal(commands.filter((type) => type === "get_available_models").length, 1);
  assert.deepEqual(await (await route.GET()).json(), updated);
});

test("POST reports refresh errors without caching stale data or leaking details", async () => {
  await route.GET();
  failRefresh = true;
  const response = await route.POST();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Model refresh failed. Check your configuration and try again.",
  });
  failRefresh = false;
  const retried = await route.POST();
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).modelList[0].id, "new");
});
