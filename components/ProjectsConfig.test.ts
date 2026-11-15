import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";

const { render, cleanup, fireEvent, waitFor } =
  await import("@testing-library/react/pure.js");
const { ProjectSettings } = await import("./ProjectsConfig");
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("retries a failed project name save with the retained name", async () => {
  const aliases: string[] = [];
  const snapshot = { projects: [], workspaces: [], sessions: [] };
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, options?: RequestInit) => {
      if (url === "/api/hierarchy") {
        assert.ok(typeof options?.body === "string");
        aliases.push(JSON.parse(options.body).input.alias);
        return aliases.length === 1
          ? Response.json({ error: "Save failed" }, { status: 503 })
          : Response.json(snapshot);
      }
      return Response.json({
        defaults: {
          pre: [],
          create: [],
          postBlocking: [],
          postNonBlocking: [],
        },
        override: null,
        source: "manual",
        paseoBlocking: [],
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  let updated:
    | Parameters<React.ComponentProps<typeof ProjectSettings>["onUpdated"]>[0]
    | undefined;
  const view = render(
    React.createElement(ProjectSettings, {
      hostId: "local",
      project: {
        id: "retry-project",
        name: "Original",
        path: "/project",
        kind: "directory",
        addedAt: "",
        workspaces: [],
      },
      onUpdated: (value) => {
        updated = value;
      },
    }),
  );
  fireEvent.change(view.getByRole("textbox", { name: "Display name" }), {
    target: { value: "New name" },
  });
  assert.match(
    (await view.findByRole("alert")).textContent ?? "",
    /Save failed/,
  );
  assert.equal(
    (view.getByRole("textbox", { name: "Display name" }) as HTMLInputElement)
      .value,
    "New name",
  );
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.deepEqual(updated, snapshot));
  assert.deepEqual(aliases, ["New name", "New name"]);
  assert.equal(view.queryByRole("alert"), null);
});
