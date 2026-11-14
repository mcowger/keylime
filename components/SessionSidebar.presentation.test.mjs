import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
const { render, cleanup, fireEvent, screen, waitFor } =
  await import("@testing-library/react/pure.js");
const { SessionSidebar } = await import("./SessionSidebar.tsx");

class FakeWorker {
  postMessage() {}
}

const snapshot = {
  projects: [
    {
      id: "project-1",
      path: "/workspace",
      name: "Project",
      kind: "directory",
      addedAt: "2026-01-01T00:00:00.000Z",
      workspaces: [
        {
          id: "workspace-1",
          projectId: "project-1",
          path: "/workspace",
          name: "Workspace",
          isDefault: true,
          sessionIds: [],
        },
      ],
    },
  ],
};

function setup(hierarchy) {
  const original = {
    fetch: globalThis.fetch,
    Worker: globalThis.Worker,
    SharedWorker: globalThis.SharedWorker,
    matchMedia: window.matchMedia,
    confirm: window.confirm,
  };
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/hierarchy") return hierarchy(url, init);
    if (url.pathname === "/api/sessions")
      return Response.json({ sessions: [] });
    if (url.pathname === "/api/projects")
      return Response.json({ projects: [] });
    return Response.json({});
  };
  return () => {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
    window.confirm = original.confirm;
  };
}

function renderSidebar(props = {}) {
  return render(
    React.createElement(SessionSidebar, {
      selectedSessionId: null,
      onSelectSession() {},
      skipInitialProjectSelection: true,
      addProjectOpen: false,
      setAddProjectOpen() {},
      usageVisible: false,
      ...props,
    }),
  );
}

test("registered hierarchy workspaces can be selected and hosts collapsed", async () => {
  const hosts = [];
  const restore = setup((url) => {
    hosts.push(url.searchParams.get("host"));
    return Response.json(snapshot);
  });
  try {
    renderSidebar();
    const workspace = await screen.findByRole("button", { name: "Workspace" });
    assert.ok(hosts.includes("local"));
    assert.equal(workspace.getAttribute("aria-pressed"), "false");
    fireEvent.click(workspace);
    await waitFor(() =>
      assert.equal(workspace.getAttribute("aria-pressed"), "true"),
    );
    fireEvent.click(screen.getByRole("button", { name: /This machine/ }));
    assert.equal(screen.queryByRole("button", { name: "Workspace" }), null);
    fireEvent.click(screen.getByRole("button", { name: /This machine/ }));
    assert.ok(screen.getByRole("button", { name: "Workspace" }));
  } finally {
    restore();
  }
});

test("hierarchy load errors are shown", async () => {
  const restore = setup(() =>
    Response.json({ error: "Host unavailable" }, { status: 503 }),
  );
  try {
    renderSidebar();
    assert.equal(
      (await screen.findByRole("alert")).textContent,
      "Host unavailable",
    );
  } finally {
    restore();
  }
});

test("failed project unregistration reports the error and keeps the hierarchy", async () => {
  const writes = [];
  const restore = setup((_url, init) => {
    if (init.method === "POST") {
      writes.push(JSON.parse(init.body));
      return Response.json({ error: "Unregister refused" }, { status: 400 });
    }
    return Response.json(snapshot);
  });
  window.confirm = () => true;
  try {
    renderSidebar();
    fireEvent.click(await screen.findByRole("button", { name: "Unregister" }));
    assert.equal(
      (await screen.findByRole("alert")).textContent,
      "Unregister refused",
    );
    assert.deepEqual(writes, [
      {
        host: "local",
        input: { action: "unregisterProject", projectId: "project-1" },
      },
    ]);
    assert.ok(screen.getByRole("button", { name: "Workspace" }));
  } finally {
    restore();
  }
});
