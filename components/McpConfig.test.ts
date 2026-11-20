import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { cleanup, render, screen, waitFor } =
  await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { McpConfig } = await import("./McpConfig");
afterEach(cleanup);

test("MCP switches persist the named action and reload without sending a model prompt", async (t) => {
  let disabled = true;
  const actions: Array<{ sessionId: string; action: string; name?: string }> =
    [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === "PATCH") {
        assert.ok(typeof options.body === "string");
        const action = JSON.parse(options.body) as {
          sessionId: string;
          action: string;
          name?: string;
        };
        actions.push(action);
        if (action.action === "enable") disabled = false;
        return Response.json({ success: true });
      }
      const inventory = [
        {
          name: "demo",
          source: "User level",
          sourcePath: "/fixture/mcp.json",
          status: disabled ? "disabled" : "configured",
          type: "stdio",
        },
      ];
      return Response.json({ servers: [], inventory, liveServers: inventory });
    },
  );
  render(createElement(McpConfig, { cwd: null, sessionId: "fixture-session" }));
  const toggle = (await screen.findByRole("switch", {
    name: "Enable demo",
  })) as HTMLButtonElement;
  await waitFor(() => assert.equal(toggle.disabled, false));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  await userEvent.setup().click(toggle);
  await waitFor(() =>
    assert.equal(toggle.getAttribute("aria-checked"), "true"),
  );
  assert.deepEqual(actions[0], {
    sessionId: "fixture-session",
    action: "enable",
    name: "demo",
  });
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: "Reload MCP" }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Reload MCP" }));
  await waitFor(() => assert.equal(actions.length, 2));
  assert.deepEqual(actions[1], {
    sessionId: "fixture-session",
    action: "reload",
  });
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: "Reload MCP" }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
});

test("MCP management cannot mutate configuration without a selected session", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      inventory: [{ name: "demo", source: "User level", status: "configured" }],
    }),
  );
  render(createElement(McpConfig, { cwd: null }));
  assert.equal(
    (
      (await screen.findByRole("switch", {
        name: "Enable demo",
      })) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(
    (screen.getByRole("button", { name: "Reload MCP" }) as HTMLButtonElement)
      .disabled,
    true,
  );
});

test("remote MCP reads only the selected live session and hides the project editor", async (t) => {
  const requests: URL[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: RequestInfo | URL, options?: RequestInit) => {
      assert.equal(options?.method, undefined);
      requests.push(new URL(String(url), "http://localhost"));
      return Response.json({
        liveServers: [
          { name: "demo", source: "Project level", status: "disabled" },
        ],
      });
    },
  );
  const view = render(
    createElement(McpConfig, {
      cwd: "/remote/project",
      hostId: "east",
      sessionId: "same-id",
    }),
  );
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(Object.fromEntries(requests[0]!.searchParams), {
    hostId: "east",
    sessionId: "same-id",
    attach: "1",
    live: "1",
  });
  assert.equal(view.container.querySelector(".mcp-editor-card"), null);
  assert.ok(
    (screen.getByRole("button", { name: "Reload MCP" }) as HTMLButtonElement)
      .disabled,
  );
});
