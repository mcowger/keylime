import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";
const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react/pure.js");
const { CreationPipelineEditor } = await import("./CreationPipelineEditor.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function settings() {
  return {
    defaults: { pre: [], create: [], post: [] },
    override: { pre: [], create: [], post: ["original manual command"] },
    source: "manual",
    paseo: {
      path: "/project/paseo.json",
      setup: ["initial recipe"],
      teardown: [],
      includePath: "/project/.worktreeinclude",
      includePatterns: [],
      unsupportedFeatures: [],
    },
  };
}

test("refreshing the live recipe preserves unsaved source and manual commands through save", async () => {
  let stored = settings();
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "POST") {
      const { input } = JSON.parse(options.body);
      stored = { ...stored, source: input.source, override: input.override };
    }
    return Response.json(stored);
  };
  const view = render(React.createElement(CreationPipelineEditor, {
    hostId: "remote",
    projectPath: "/project",
    gitProject: true,
  }));
  const post = await view.findByRole("textbox", { name: "post commands (one per line)" });
  fireEvent.change(post, { target: { value: "my unsaved setup" } });
  const follow = view.getByRole("radio", { name: "Follow Paseo workspace setup" });
  assert.match(view.getByText(/Commands receive OMP_PROJECT_PATH/).textContent, /OMP_CREATE_RESULT/);
  fireEvent.click(follow);
  assert.match(view.getByText(/Setup and teardown commands receive PASEO_SOURCE_CHECKOUT_PATH/).textContent, /PASEO_WORKTREE_PATH.*PASEO_BRANCH_NAME/);
  assert.equal(view.queryByText(/Commands receive OMP_PROJECT_PATH/), null);
  stored = { ...stored, paseo: { ...stored.paseo, setup: ["revised on-disk recipe"] } };
  fireEvent.click(view.getByRole("button", { name: "Refresh preview" }));
  await view.findByText("revised on-disk recipe");
  assert.equal(follow.checked, true);
  fireEvent.click(view.getByRole("radio", { name: "Manual", exact: true }));
  assert.equal(view.getByRole("textbox", { name: "post commands (one per line)" }).value, "my unsaved setup");
  fireEvent.click(follow);
  fireEvent.click(view.getByRole("button", { name: "Save commands" }));
  await waitFor(() => assert.equal(view.getByRole("button", { name: "Save commands" }).disabled, false));
  fireEvent.click(view.getByRole("radio", { name: "Manual", exact: true }));
  assert.equal(view.getByRole("textbox", { name: "post commands (one per line)" }).value, "my unsaved setup");
});

test("missing Paseo recipe hides the option and preserves the manual setting", async () => {
  const stored = settings();
  stored.paseo = { ...stored.paseo, missing: true, error: "Cannot read Paseo recipe: ENOENT" };
  globalThis.fetch = async () => Response.json(stored);
  const view = render(React.createElement(CreationPipelineEditor, { hostId: "remote", projectPath: "/project", gitProject: true }));
  assert.equal((await view.findByRole("radio", { name: "Manual", exact: true })).checked, true);
  assert.equal(view.queryByRole("radio", { name: "Follow Paseo workspace setup" }), null);
  assert.ok(view.getByRole("textbox", { name: "post commands (one per line)" }));
});

test("a missing selected recipe can be switched back to manual", async () => {
  let stored = settings();
  stored = { ...stored, source: "paseo", paseo: { ...stored.paseo, missing: true, error: "Cannot read Paseo recipe: ENOENT" } };
  globalThis.fetch = async (_url, options) => {
    if (options?.method === "POST") stored = { ...stored, source: JSON.parse(options.body).input.source };
    return Response.json(stored);
  };
  const view = render(React.createElement(CreationPipelineEditor, { hostId: "remote", projectPath: "/project", gitProject: true }));
  const manual = await view.findByRole("radio", { name: "Manual", exact: true });
  assert.equal(view.queryByRole("radio", { name: "Follow Paseo workspace setup" }), null);
  assert.ok(view.getByRole("alert"));
  fireEvent.click(manual);
  fireEvent.click(view.getByRole("button", { name: "Save commands" }));
  await waitFor(() => assert.equal(stored.source, "manual"));
});

test("an invalid but present Paseo recipe remains selectable", async () => {
  const stored = settings();
  stored.paseo = { ...stored.paseo, error: "Cannot read Paseo recipe: invalid JSON" };
  globalThis.fetch = async () => Response.json(stored);
  const view = render(React.createElement(CreationPipelineEditor, { hostId: "remote", projectPath: "/project", gitProject: true }));
  fireEvent.click(await view.findByRole("radio", { name: "Follow Paseo workspace setup" }));
  assert.match(view.getByRole("alert").textContent, /invalid JSON/);
});
