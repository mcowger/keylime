import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { mock } from "bun:test";
import { getHostModels, invalidateModelsCache } from "./models-cache";
import { linkLocalHost } from "./hosts/link-driver.test-helper";
import { closeHostLink } from "./hosts/hub";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(
  join(tmpdir(), "keylime-models-route-"),
);
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
    if (
      command.type === "refresh_available_models" ||
      command.type === "get_available_models"
    ) {
      return { models: [{ provider: "test", id: modelId, name: modelId }] };
    }
    if (command.type === "get_login_providers") return { providers: [] };
    if (command.type === "get_state") return {};
    throw new Error(`Unexpected command: ${command.type}`);
  },
}));
const route = await import("../app/api/models/route.ts");
const link = await linkLocalHost();
link.serve({ modelsList: ({ refresh }) => getHostModels(refresh === true) });
after(() => closeHostLink(link.id));
const request = new Request("http://localhost/api/models");
after(() => mock.module(utilityPath, () => realUtility));
beforeEach(() => {
  invalidateModelsCache();
  commands.length = 0;
  modelId = "old";
  refreshGate = undefined;
  failRefresh = false;
});

test("POST refresh bypasses the cached snapshot and concurrent GET joins it", async () => {
  const old = await (await route.GET(request)).json();
  assert.equal(old.modelList[0].id, "old");
  const gate = Promise.withResolvers<void>();
  refreshGate = gate.promise;
  const post = route.POST(request);
  const get = route.GET(request);
  gate.resolve();
  const postResponse = await post;
  const updated = await postResponse.json();
  const read = await (await get).json();
  assert.equal(postResponse.status, 200);
  assert.equal(updated.modelList[0].id, "new");
  assert.deepEqual(read, updated);
  assert.equal(
    commands.filter((type) => type === "refresh_available_models").length,
    1,
  );
  assert.equal(
    commands.filter((type) => type === "get_available_models").length,
    1,
  );
  assert.deepEqual(await (await route.GET(request)).json(), updated);
});

test("POST reports refresh errors without caching stale data or leaking details", async () => {
  await route.GET(request);
  failRefresh = true;
  const response = await route.POST(request);
  assert.equal(response.status, 503);
  const error = await response.json();
  assert.match(error.error, /Model refresh failed/);
  assert.doesNotMatch(error.error, /provider secret/);
  failRefresh = false;
  const retried = await route.POST(request);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).modelList[0].id, "new");
});
