import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

const { cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react/pure.js");

const { ModelsConfig, providerInitials } = await import("./ModelsConfig");

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
  const { promise: runtimeResponse, resolve: resolveModels } =
    Promise.withResolvers<Response>();
  const json = (data: unknown) => Response.json(data);
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL) => {
      if (url === "/api/models") return runtimeResponse;
      if (url === "/api/models-config")
        return json({
          providers: {
            alpha: { models: [{ id: "configured" }] },
            beta: {},
            empty: {},
          },
        });
      return json({ providers: [] });
    },
    { preconnect: originalFetch.preconnect },
  );

  const { container } = render(
    createElement(ModelsConfig, { onClose: () => {}, embedded: true }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Custom providers/ }),
  );
  await screen.findByText("configured");
  const card = (name: string) => {
    const element = [
      ...container.querySelectorAll<HTMLElement>(".settings-card"),
    ].find((candidate) => within(candidate).queryByText(name));
    assert.ok(element);
    return element;
  };
  assert.ok(within(card("beta")).getByText("Loading OMP runtime models…"));
  assert.equal(within(card("alpha")).getByText("configured").tagName, "SPAN");

  resolveModels(
    json({
      modelList: [
        { provider: "alpha", id: "configured", name: "Configured" },
        { provider: "alpha", id: "discovered", name: "Discovered" },
        { provider: "beta", id: "beta-model", name: "Beta" },
        { provider: "other", id: "other-model", name: "Other" },
      ],
    }),
  );
  await waitFor(() => assert.ok(within(card("alpha")).getByText("discovered")));
  const alpha = within(card("alpha"));
  assert.equal(alpha.getAllByText("configured").length, 1);
  assert.equal(
    alpha.getByRole("button", { name: "configured" }).tagName,
    "BUTTON",
  );
  assert.equal(
    alpha.getByTitle("Automatically discovered by OMP").textContent,
    "discovered",
  );
  assert.equal(
    within(card("beta")).getByTitle("Automatically discovered by OMP")
      .textContent,
    "beta-model",
  );
  assert.equal(screen.queryByText("other-model"), null);
  assert.match(
    card("empty").textContent ?? "",
    /No models configured or discovered/,
  );
});
