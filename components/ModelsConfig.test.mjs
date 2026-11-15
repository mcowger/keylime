import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react/pure.js");

const { ModelsConfig, providerInitials } = await import("./ModelsConfig.tsx");

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("provider glyphs derive from arbitrary runtime provider ids", () => {
  assert.equal(providerInitials("acme-provider"), "AP");
  assert.equal(providerInitials("my_custom_gateway"), "MC");
  assert.equal(providerInitials("provider"), "P");
  assert.equal(providerInitials(""), "?");
});

test("custom cards show discovered models without duplicating editable entries", async () => {
  let resolveModels;
  const runtimeResponse = new Promise((resolve) => { resolveModels = resolve; });
  const json = (data) => ({ ok: true, json: async () => data });
  globalThis.fetch = async (url) => {
    if (url === "/api/models") return runtimeResponse;
    if (url === "/api/models-config") return json({ providers: {
      alpha: { models: [{ id: "configured" }] },
      beta: {},
      empty: {},
    } });
    return json({ providers: [] });
  };

  const { container } = render(createElement(ModelsConfig, { onClose: () => {}, embedded: true }));
  fireEvent.click(await screen.findByRole("button", { name: /Custom providers/ }));
  await screen.findByText("configured");
  const card = (name) => [...container.querySelectorAll(".settings-card")]
    .find((element) => within(element).queryByText(name));
  assert.ok(within(card("beta")).getByText("Loading OMP runtime models…"));
  assert.equal(within(card("alpha")).getByText("configured").tagName, "SPAN");

  resolveModels(json({ modelList: [
    { provider: "alpha", id: "configured", name: "Configured" },
    { provider: "alpha", id: "discovered", name: "Discovered" },
    { provider: "beta", id: "beta-model", name: "Beta" },
    { provider: "other", id: "other-model", name: "Other" },
  ] }));
  await waitFor(() => assert.ok(within(card("alpha")).getByText("discovered")));
  const alpha = within(card("alpha"));
  assert.equal(alpha.getAllByText("configured").length, 1);
  assert.equal(alpha.getByRole("button", { name: "configured" }).tagName, "BUTTON");
  assert.equal(alpha.getByTitle("Automatically discovered by OMP").textContent, "discovered");
  assert.equal(within(card("beta")).getByTitle("Automatically discovered by OMP").textContent, "beta-model");
  assert.equal(screen.queryByText("other-model"), null);
  assert.match(card("empty").textContent, /No models configured or discovered/);
});
