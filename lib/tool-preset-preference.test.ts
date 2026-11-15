import assert from "node:assert/strict";
import test from "node:test";

const { getPreferredToolPreset, setPreferredToolPreset } =
  await import("./tool-preset-preference");
const { getToolNamesForPreset } = await import("./tool-presets");

function createStorage(values: Record<string, string> = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
  };
}

test("defaults to the full OMP toolset and persists explicit choices", () => {
  const storage = createStorage({ "omp-web:tool-preset": "unknown" });
  assert.equal(getPreferredToolPreset(storage), "full");

  setPreferredToolPreset("default", storage);
  assert.equal(getPreferredToolPreset(storage), "default");

  setPreferredToolPreset("full", storage);
  assert.equal(getPreferredToolPreset(storage), "full");
});

test("full preset leaves OMP's native toolset unrestricted", () => {
  assert.equal(getToolNamesForPreset("full"), undefined);
  assert.deepEqual(getToolNamesForPreset("default"), [
    "read",
    "bash",
    "edit",
    "write",
  ]);
  assert.deepEqual(getToolNamesForPreset("none"), []);
});
