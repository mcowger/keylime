import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { LinkDriver } from "./hosts/link-driver.test-helper.ts";

test("new-session route rejects malformed commands", async () => {
  const newRoute = await readFile(
    new URL("../app/api/agent/new/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(newRoute, /command_type_required/);
  assert.match(newRoute, /newSessionErrorResponse/);
});

test("session archive route stops live children and maps missing sessions", async () => {
  const route = await readFile(
    new URL("../app/api/sessions/[id]/archive/route.ts", import.meta.url),
    "utf8",
  );
  const utils = await readFile(
    new URL("../lib/api-utils.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /destroyAndWait/);
  assert.match(route, /sessionOps\.archiveSession/);
  // Missing-session responses now come from the shared helper.
  assert.match(route, /resolveSessionHostOr404/);
  assert.match(utils, /session_not_found/);
  assert.match(route, /session_archive_failed/);
  assert.match(route, /session_has_children/);
});

test("session archive remains keyboard-discoverable with an ARIA label", async () => {
  const source = await readFile(
    new URL("../components/SessionSidebar.tsx", import.meta.url),
    "utf8",
  );
  const rows = await readFile(
    new URL("../components/SessionSidebar-rows.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    rows,
    /api\/sessions\/\$\{encodeURIComponent\(session\.id\)\}\/archive/,
  );
  assert.match(rows, /sessionSidebar\.archiveLeafOnly/);
  assert.match(source, /onOpenArchive/);
});

test("prompt controls preserve abort, steer, and follow-up RPC commands", async () => {
  const source = await readFile(
    new URL("./rpc-manager.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /case "abort":/);
  assert.match(source, /case "steer":/);
  assert.match(source, /case "follow_up":/);
  assert.match(source, /streamingBehavior/);
});

test("worktree discovery filters prunable entries and identifies the main checkout", async () => {
  const source = await readFile(
    new URL("./worktree.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /current\.prunable/);
  assert.match(source, /isMain:\s*samePath\(worktreePath,\s*repoRoot\)/);
  assert.match(source, /"worktree", "list", "--porcelain"/);
});

test("agent project discovery requires an explicit workspace", async () => {
  const route = await readFile(
    new URL("../app/api/agents/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /scope === "project" && !cwdParam/);
  assert.match(route, /cwd is required for project scope/);
});

test("agent mutations bound JSON input before parsing", async () => {
  const route = await readFile(
    new URL("../app/api/agents/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /parseJsonWithinLimit/);
  assert.match(route, /MAX_AGENT_REQUEST_BYTES/);
  assert.match(route, /RequestBodyTooLargeError/);
  assert.match(route, /status: 413/);
  assert.doesNotMatch(route, /request\.json\(\)/);
});

test("mutating agent and MCP routes bound JSON input", async () => {
  const newAgent = await readFile(
    new URL("../app/api/agent/new/route.ts", import.meta.url),
    "utf8",
  );
  const agent = await readFile(
    new URL("../app/api/agent/[id]/route.ts", import.meta.url),
    "utf8",
  );
  const mcp = await readFile(
    new URL("../app/api/mcp/route.ts", import.meta.url),
    "utf8",
  );
  for (const route of [newAgent, agent, mcp])
    assert.match(route, /parseJsonWithinLimit/);
  for (const route of [newAgent, mcp])
    assert.match(route, /RequestBodyTooLargeError/);
  assert.match(newAgent, /status: 413/);
  assert.match(mcp, /\? 413 : 400/);
});

test("MCP route redacts project server credentials", async () => {
  const route = await readFile(
    new URL("../app/api/mcp/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /redactMcpServer\(config\)/);
  assert.doesNotMatch(route, /config }\)\), user: safeUser/);
});

test("new-session route never forwards a session id into the child RPC", async () => {
  const route = await readFile(
    new URL("../app/api/agent/new/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /delete promptCommand\.sessionId/);
});

test("PUT /api/web-settings validates the transport and tells open streams only when it changed", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "keylime-settings-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { PUT, GET } = await import("../app/api/web-settings/route.ts");
  const { EventStreamConnection } = await import("./event-stream-hub.ts");
  const endpoint = "http://localhost/api/web-settings?scope=browser";
  const put = (body: unknown) =>
    PUT(
      new Request(endpoint, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );
  const connection = new EventStreamConnection();
  assert.ok(connection.stream);
  const reader = connection.stream.getReader();
  const decoder = new TextDecoder();
  const read = async () => {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () =>
            reject(new Error("read stalled: the expected frame never arrived")),
          2000,
        );
      }),
    ]).finally(() => clearTimeout(watchdog));
    return decoder.decode(chunk.value);
  };
  try {
    assert.match(await read(), /"type":"hello"/);

    // The experiment's modes are gone: only sse and ws.
    for (const value of ["websocket", "ws-pool", "ws-client"]) {
      const invalid = await put({ browserTransport: value });
      assert.equal(invalid.status, 400);
      assert.match((await invalid.json()).error, /Expected browserTransport/);
    }

    // The default is ws, so the first change is to sse.
    const ok = await put({ browserTransport: "sse" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).browserTransport, "sse");
    assert.match(
      await read(),
      /^event: mux\n[\s\S]*\ndata: \{"type":"transport","transport":"sse"\}\n\n$/,
    );
    assert.deepEqual(await (await GET(new Request(endpoint))).json(), {
      browserTransport: "sse",
    });

    // Saves that do not change the state broadcast nothing: the next frame is the one we trigger ourselves.
    for (const [patch, status] of [
      [{ autoResumeSessions: false }, 400],
      [{ browserTransport: "sse" }, 200],
    ] as const) {
      assert.equal((await put(patch)).status, status);
      connection.control({ type: "open", sub: "s1" });
      assert.match(await read(), /"type":"open"/);
    }

    assert.equal((await put({ browserTransport: "ws" })).status, 200);
    assert.match(await read(), /"type":"transport","transport":"ws"/);
  } finally {
    connection.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings and model requests stay on the selected daemon", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { linkHost } = await import("./hosts/link-driver.test-helper.ts");
  const { closeHostLink } = await import("./hosts/hub.ts");
  const settings = await import("../app/api/web-settings/route.ts");
  const models = await import("../app/api/models/route.ts");
  const dir = mkdtempSync(join(tmpdir(), "keylime-host-policy-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const links: LinkDriver[] = [];
  try {
    const first = await linkHost("first");
    links.push(first);
    const second = await linkHost("second");
    links.push(second);
    const requests: string[] = [];
    for (const link of links) {
      let policy = {
        autoResumeSessions: false,
        agentToolsEnabled: false,
        uploadRetentionDays: link === first ? 7 : 90,
      };
      void link.serve({
        hostSettingsGet: () => policy,
        hostSettingsSet: (patch) => {
          requests.push(link.id);
          policy = { ...policy, ...patch };
          return policy;
        },
        modelsList: ({ refresh }) => {
          requests.push(`${link.id}:${refresh}`);
          return {
            models: { [link.id]: "Model" },
            modelList: [],
            defaultModel: null,
            thinkingLevels: {},
            anthropicSlowMode: link === second,
          };
        },
      });
    }
    const url = (path: string, id: string) =>
      `http://localhost/api/${path}?hostId=${encodeURIComponent(id)}`;
    const firstSettings = url("web-settings", first.id);
    const patch = (body: unknown) =>
      settings.PUT(
        new Request(firstSettings, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      );
    assert.equal(
      (await patch({ agentEnv: { SECRET: "never forwarded" } })).status,
      400,
    );
    const saved = await patch({ uploadRetentionDays: 30 });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      autoResumeSessions: false,
      agentToolsEnabled: false,
      uploadRetentionDays: 30,
    });
    const untouched = await settings.GET(
      new Request(url("web-settings", second.id)),
    );
    assert.equal((await untouched.json()).uploadRetentionDays, 90);
    const catalog = await models.GET(new Request(url("models", first.id)));
    assert.deepEqual((await catalog.json()).models, { [first.id]: "Model" });
    const refreshed = await models.POST(
      new Request(url("models", second.id), { method: "POST" }),
    );
    assert.equal((await refreshed.json()).anthropicSlowMode, true);
    assert.deepEqual(requests, [
      first.id,
      `${first.id}:false`,
      `${second.id}:true`,
    ]);

    closeHostLink(first.id);
    assert.equal((await settings.GET(new Request(firstSettings))).status, 503);
    assert.equal(
      (await models.GET(new Request(url("models", first.id)))).status,
      503,
    );
  } finally {
    for (const link of links) link.drop();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
