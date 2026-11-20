import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";
import { createElement } from "react";
const { cleanup, render, screen, waitFor } =
  await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { SettingsConfig } = await import("./SettingsConfig");
const { PluginsConfig } = await import("./PluginsConfig");
afterEach(cleanup);

const noop = () => {};
const MEMBER_CWD = "/srv/h1/keylime-cluster/app";
const MEMBER_SESSION = "member-session-1";
const REMOTE = "Configure OMP on the host running the session. This editor only works on the web server.";

const settingsProps = {
  activeTab: "mcp",
  toolCallsDefaultCollapsed: false,
  onToolCallsDefaultCollapsedChange: noop,
  hideToolActivity: false,
  onHideToolActivityChange: noop,
  neverFoldActivity: false,
  onNeverFoldActivityChange: noop,
  showToolCallsUnfolded: false,
  onShowToolCallsUnfoldedChange: noop,
  expandThinkingByDefault: "off",
  onExpandThinkingByDefaultChange: noop,
  onHideThinkingBlockChange: noop,
  providerUsageVisible: false,
  onProviderUsageVisibleChange: noop,
  scopeNativeSelectAll: false,
  onScopeNativeSelectAllChange: noop,
  openUrlAutomatically: false,
  onOpenUrlAutomaticallyChange: noop,
  cwd: MEMBER_CWD,
  remoteHost: false,
  sessionId: MEMBER_SESSION,
  onModelsSaved: noop,
  onPluginsReloaded: noop,
  onSelectTab: noop,
  onClose: noop,
} as const;

/** Every request, answered with an empty panel; MCP's live read says its one server is connected. */
function recordRequests(t: TestContext) {
  const requests: Array<{
    url: string;
    method: string;
    body: BodyInit | null | undefined;
  }> = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      const path = String(url).split("?")[0];
      if (path === "/api/omp-settings") return Response.json({ settings: {} });
      if (path === "/api/mcp") {
        const inventory = [
          {
            name: "demo",
            source: "User level",
            status: "configured",
            type: "stdio",
          },
        ];
        return Response.json(
          String(url).includes("live=1")
            ? {
                servers: [],
                inventory,
                liveServers: [{ ...inventory[0], status: "connected" }],
              }
            : { servers: [], inventory },
        );
      }
      if (path === "/api/skills") return Response.json({ skills: [] });
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/plugins")
        return Response.json({
          packages: [],
          totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
          diagnostics: [],
        });
      return Response.json({});
    },
  );
  return requests;
}
test("remote MCP shows live status without loading the web server's configuration", async (t) => {
  const requests = recordRequests(t);
  render(createElement(SettingsConfig, { ...settingsProps, remoteHost: true }));
  assert.ok(await screen.findByText("connected"));
  assert.equal(screen.queryByText("Load Project MCP Servers"), null);
  assert.equal(screen.queryByText("Project MCP Servers"), null);
  assert.equal(
    (screen.getByRole("button", { name: "Reload MCP" }) as HTMLButtonElement).disabled,
    true,
  );
  const mcp = requests.filter(({ url }) => url.startsWith("/api/mcp"));
  assert.ok(mcp.length > 0);
  for (const { method, url } of mcp) {
    assert.equal(method, "GET");
    const query = new URL(url, "http://localhost").searchParams;
    assert.equal(query.get("attach"), "1");
    assert.equal(query.get("sessionId"), MEMBER_SESSION);
    assert.equal(query.has("cwd"), false);
  }
  assert.equal(requests.length, mcp.length);
});

for (const tab of ["skills", "agents", "models", "safety"] as const) {
  test(`remote ${tab} settings do not load web server settings`, async (t) => {
    const requests = recordRequests(t);
    render(createElement(SettingsConfig, { ...settingsProps, remoteHost: true, activeTab: tab }));
    assert.ok(await screen.findByText(REMOTE));
    assert.deepEqual(requests, []);
  });
}

test("without a workspace the Plugins panel works at the user level: no cwd, global installs only", async (t) => {
  const requests = recordRequests(t);
  render(
    createElement(PluginsConfig, {
      embedded: true,
      cwd: null,
      sessionId: null,
      onClose: noop,
    }),
  );
  const source = await screen.findByRole("textbox", { name: "Source" });
  assert.deepEqual(
    requests.map((request) => request.url),
    ["/api/plugins"],
  );
  assert.ok(screen.getByText("~/.omp/plugins"));
  assert.equal(screen.queryByRole("button", { name: "project" }), null);
  const user = userEvent.setup();
  await user.type(source, "npm:demo");
  await user.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => assert.equal(requests.length, 2));
  assert.ok(typeof requests[1].body === "string");
  const { cwd, ...install } = JSON.parse(requests[1].body);
  assert.equal(cwd ?? null, null);
  assert.deepEqual(install, {
    action: "install",
    source: "npm:demo",
    scope: "global",
  });
});
