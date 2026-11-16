import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { useShipAvailability } from "./useShipAvailability.ts";

// Testing Library must bind to the document installed by setup-dom first.
const { render, cleanup, waitFor } = await import("@testing-library/react/pure.js");

function ShipButton() {
  const empty = useShipAvailability("local", "/repo", "/work");
  return React.createElement("button", { disabled: empty }, "Ship");
}

test("a clean workspace with an open PR remains available to ship", async () => {
  const originalFetch = globalThis.fetch;
  let pr: { state: string } | null = null;
  globalThis.fetch = Object.assign(async () => Response.json({
    dirty: false, ahead: 0, issues: [], pr,
  }), { preconnect: originalFetch.preconnect });
  try {
    const view = render(React.createElement(ShipButton));
    const button = view.getByRole("button", { name: "Ship" }) as HTMLButtonElement;
    await waitFor(() => assert.equal(button.disabled, true));
    pr = { state: "open" };
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => assert.equal(button.disabled, false));
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});
