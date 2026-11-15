import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";

const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react/pure.js");
const { ProjectSettings } = await import("./ProjectsConfig.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("retries a failed project name save with the retained name", async () => {
  const aliases = [];
  const snapshot = { projects: [], workspaces: [], sessions: [] };
  globalThis.fetch = async (url, options) => {
    if (url === "/api/hierarchy") {
      aliases.push(JSON.parse(options.body).input.alias);
      return aliases.length === 1
        ? Response.json({ error: "Save failed" }, { status: 503 })
        : Response.json(snapshot);
    }
    return Response.json({ defaults: { pre: [], create: [], post: [] }, override: null, source: "manual" });
  };
  let updated;
  const view = render(React.createElement(ProjectSettings, {
    hostId: "local",
    project: { id: "retry-project", name: "Original", alias: null, path: "/project", kind: "directory" },
    onUpdated: (value) => { updated = value; },
  }));
  fireEvent.change(view.getByRole("textbox", { name: "Display name" }), { target: { value: "New name" } });
  assert.match((await view.findByRole("alert")).textContent, /Save failed/);
  assert.equal(view.getByRole("textbox", { name: "Display name" }).value, "New name");
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.deepEqual(updated, snapshot));
  assert.deepEqual(aliases, ["New name", "New name"]);
  assert.equal(view.queryByRole("alert"), null);
});
