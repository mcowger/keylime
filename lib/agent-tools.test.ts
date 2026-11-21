import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_NAMES,
  AgentToolGuard,
  executeAgentTool,
  formatAttributedMessage,
  type AgentToolContext,
  type AgentToolCreateSessionInput,
  type AgentToolDeliverInput,
  type AgentToolSessionOps,
} from "./agent-tools.ts";
import { isRecord } from "./type-guards.ts";

function fakeOps(overrides: Partial<AgentToolSessionOps> = {}) {
  const calls: {
    list: string[];
    create: AgentToolCreateSessionInput[];
    deliver: AgentToolDeliverInput[];
    register: string[];
    monitor: number;
    lookup: number;
  } = {
    list: [],
    create: [],
    deliver: [],
    register: [],
    monitor: 0,
    lookup: 0,
  };
  return {
    calls,
    async listSessions(sourceHostId: string) {
      calls.list.push(sourceHostId);
      return sourceHostId === "local"
        ? [
            {
              id: "target-1",
              name: "Release",
              cwd: "/tmp/release",
              running: false,
              host: "Desk",
            },
          ]
        : [
            {
              id: "build-target",
              cwd: "/srv/app",
              running: true,
              host: "build-box",
            },
          ];
    },
    async createSession(input: AgentToolCreateSessionInput) {
      calls.create.push(input);
      return { sessionId: "new-1" };
    },
    async registerWorkspacePr(prUrl: string) {
      calls.register.push(prUrl);
      return {
        number: 42,
        url: prUrl,
        state: "open" as const,
        checks: "none" as const,
        autoMerge: false,
        cleanup: false,
        checkedAt: new Date().toISOString(),
      };
    },
    async getWorkspacePr() {
      calls.lookup++;
      return { pr: null };
    },
    async monitorWorkspacePr() {
      calls.monitor++;
      return { status: "started" as const, message: "Monitoring started" };
    },
    async deliver(input: AgentToolDeliverInput) {
      calls.deliver.push(input);
      return {
        accepted: true,
        targetSessionId: input.sessionId,
        delivery: input.delivery,
        waited: false,
        responseText: null,
      };
    },
    ...overrides,
  };
}

const ctx = (overrides: Partial<AgentToolContext> = {}): AgentToolContext => ({
  sourceSessionId: "source-1",
  sourceRequestId: "native-request-1",
  sourceCwd: "/tmp/source",
  sourceHostId: "local",
  enabled: true,
  guard: new AgentToolGuard(),
  ...overrides,
});

test("agent tool definitions cover the three cross-session tools (#275)", () => {
  assert.deepEqual([...AGENT_TOOL_NAMES].sort(), [
    "get_workspace_pr",
    "list_sessions",
    "monitor_workspace_pr",
    "new_session",
    "register_workspace_pr",
    "send_to_session",
  ]);
  assert.deepEqual(AGENT_TOOL_DEFINITIONS.map((t) => t.name).sort(), [
    "get_workspace_pr",
    "list_sessions",
    "monitor_workspace_pr",
    "new_session",
    "register_workspace_pr",
    "send_to_session",
  ]);
  const send = AGENT_TOOL_DEFINITIONS.find((t) => t.name === "send_to_session");
  assert.ok(send);
  assert.ok(isRecord(send.parameters.properties));
  assert.ok(isRecord(send.parameters.properties.delivery));
  for (const { parameters } of AGENT_TOOL_DEFINITIONS) {
    assert.ok(isRecord(parameters.properties));
    assert.ok(!("host" in parameters.properties));
  }
  assert.deepEqual(send.parameters.required, ["sessionId", "message"]);
  assert.deepEqual(send.parameters.properties.delivery.enum, [
    "prompt",
    "steer",
    "followUp",
  ]);
});

test("register PR tool validates its URL and never accepts an alternate session", async () => {
  const ops = fakeOps();
  const prUrl = "https://github.com/test/repo/pull/42";
  const result = await executeAgentTool(
    "register_workspace_pr",
    { prUrl },
    ops,
    ctx(),
  );
  assert.ok(isRecord(result));
  assert.equal(result.url, prUrl);
  assert.deepEqual(ops.calls.register, [prUrl]);
  await assert.rejects(
    () =>
      executeAgentTool(
        "register_workspace_pr",
        { prUrl, sessionId: "other" },
        ops,
        ctx(),
      ),
    /canonical/,
  );
  await assert.rejects(
    () =>
      executeAgentTool(
        "register_workspace_pr",
        { prUrl },
        ops,
        ctx({ enabled: false }),
      ),
    /disabled/,
  );
  assert.deepEqual(ops.calls.register, [prUrl]);
});

test("PR lookup rejects targets, works with agent tools off and shares the rate cap", async () => {
  const ops = fakeOps();
  const context = ctx({ enabled: false });
  const definition = AGENT_TOOL_DEFINITIONS.find(
    (tool) => tool.name === "get_workspace_pr",
  );
  assert.ok(definition);
  assert.equal(definition.loadMode, "essential");
  assert.deepEqual(definition.parameters.properties, {});
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(
    await executeAgentTool("get_workspace_pr", {}, ops, context),
    { pr: null },
  );
  for (const args of [
    { sessionId: "other" },
    { host: "other" },
    { path: "/tmp/other" },
    { prUrl: "https://github.com/test/repo/pull/42" },
    null,
    [],
  ]) {
    await assert.rejects(() =>
      executeAgentTool("get_workspace_pr", args, ops, context),
    );
  }
  for (let i = 1; i < 20; i++)
    await executeAgentTool(
      i % 2 ? "monitor_workspace_pr" : "get_workspace_pr",
      {},
      ops,
      context,
    );
  await assert.rejects(
    () => executeAgentTool("get_workspace_pr", {}, ops, context),
    /rate/i,
  );
  assert.equal(ops.calls.lookup, 10);
  assert.equal(ops.calls.monitor, 10);
});

test("monitor tool remains available with the gate off, scoped and rate limited", async () => {
  const ops = fakeOps();
  const context = ctx();
  const definition = AGENT_TOOL_DEFINITIONS.find(
    (tool) => tool.name === "monitor_workspace_pr",
  );
  assert.ok(definition);
  assert.equal(definition.loadMode, "essential");
  assert.equal(definition.parameters.additionalProperties, false);
  assert.deepEqual(
    await executeAgentTool("monitor_workspace_pr", {}, ops, context),
    {
      status: "started",
      message: "Monitoring started",
    },
  );
  for (const args of [
    { sessionId: "other" },
    { prUrl: "https://github.com/test/repo/pull/42" },
    { host: "other" },
    { path: "/tmp/other" },
    null,
  ]) {
    await assert.rejects(() =>
      executeAgentTool("monitor_workspace_pr", args, ops, context),
    );
  }
  await executeAgentTool(
    "monitor_workspace_pr",
    {},
    ops,
    ctx({ enabled: false }),
  );
  for (let i = 1; i < 20; i++)
    await executeAgentTool("monitor_workspace_pr", {}, ops, context);
  await assert.rejects(
    () => executeAgentTool("monitor_workspace_pr", {}, ops, context),
    /rate/i,
  );
  assert.equal(ops.calls.monitor, 21);
});

test("cross-session agent tools refuse calls while the Settings gate is off (#275)", async () => {
  const off = ctx({ enabled: false });
  await assert.rejects(
    () => executeAgentTool("list_sessions", {}, fakeOps(), off),
    /disabled/,
  );
  await assert.rejects(
    () =>
      executeAgentTool(
        "send_to_session",
        { sessionId: "t", message: "hi" },
        fakeOps(),
        off,
      ),
    /disabled/,
  );
});

test("list_sessions requests only the calling host's sessions", async () => {
  const ops = fakeOps();
  assert.deepEqual(await executeAgentTool("list_sessions", {}, ops, ctx()), {
    sessions: [
      {
        id: "target-1",
        name: "Release",
        cwd: "/tmp/release",
        running: false,
        host: "Desk",
      },
    ],
  });
  assert.deepEqual(
    await executeAgentTool(
      "list_sessions",
      {},
      ops,
      ctx({ sourceHostId: "h-build" }),
    ),
    {
      sessions: [
        {
          id: "build-target",
          cwd: "/srv/app",
          running: true,
          host: "build-box",
        },
      ],
    },
  );
  assert.deepEqual(ops.calls.list, ["local", "h-build"]);
});

test("new_session defaults cwd, attributes the prompt, and splits provider/model (#275)", async () => {
  const ops = fakeOps();
  const result = await executeAgentTool(
    "new_session",
    {
      prompt: "Do the release checklist",
      model: "anthropic/claude-sonnet-4-5",
      name: "Release worker",
    },
    ops,
    ctx(),
  );
  assert.deepEqual(result, { sessionId: "new-1" });
  assert.equal(ops.calls.create.length, 1);
  const input = ops.calls.create[0];
  assert.equal(input.cwd, "/tmp/source");
  assert.equal(input.hostId, "local");
  assert.equal(
    input.prompt,
    "[From session source-1 via keylime agent tools]: Do the release checklist",
  );
  assert.equal(input.provider, "anthropic");
  assert.equal(input.modelId, "claude-sonnet-4-5");
  assert.equal(input.name, "Release worker");
});

test("new_session without a prompt creates an idle session, and bad models are rejected (#275)", async () => {
  const ops = fakeOps();
  await executeAgentTool("new_session", { cwd: "/tmp/other" }, ops, ctx());
  assert.equal(ops.calls.create[0].prompt, null);
  assert.equal(ops.calls.create[0].cwd, "/tmp/other");
  await assert.rejects(
    () =>
      executeAgentTool("new_session", { model: "no-slash" }, fakeOps(), ctx()),
    /provider\/modelId/,
  );
  await assert.rejects(
    () =>
      executeAgentTool(
        "new_session",
        { provider: "anthropic" },
        fakeOps(),
        ctx(),
      ),
    /together/,
  );
  await assert.rejects(
    () =>
      executeAgentTool("new_session", {}, fakeOps(), ctx({ sourceCwd: "" })),
    /cwd/,
  );
});

test("send_to_session attributes, defaults to prompt, and passes wait through (#275)", async () => {
  const ops = fakeOps();
  const result = await executeAgentTool(
    "send_to_session",
    {
      sessionId: "target-1",
      message: "The build passed",
      wait: true,
      waitTimeoutMs: 5000,
    },
    ops,
    ctx(),
  );
  assert.equal(ops.calls.deliver.length, 1);
  const input = ops.calls.deliver[0];
  assert.equal(input.sourceHostId, "local");
  assert.equal(
    input.message,
    "[From session source-1 via keylime agent tools]: The build passed",
  );
  assert.equal(input.delivery, "prompt");
  assert.equal(input.wait, true);
  assert.equal(input.waitTimeoutMs, 5000);
  assert.ok(isRecord(result));
  assert.equal(result.targetSessionId, "target-1");
});

test("send_to_session rejects self-targets, bad deliveries, and bad waits (#275)", async () => {
  const base = ctx();
  await assert.rejects(
    () =>
      executeAgentTool(
        "send_to_session",
        { sessionId: "source-1", message: "hi" },
        fakeOps(),
        base,
      ),
    /itself/,
  );
  await assert.rejects(
    () =>
      executeAgentTool(
        "send_to_session",
        { sessionId: "t", message: "hi", delivery: "shout" },
        fakeOps(),
        ctx(),
      ),
    /delivery/,
  );
  await assert.rejects(
    () =>
      executeAgentTool(
        "send_to_session",
        { sessionId: "t", message: "hi", wait: "yes" },
        fakeOps(),
        ctx(),
      ),
    /wait/,
  );
  await assert.rejects(
    () =>
      executeAgentTool("send_to_session", { sessionId: "t" }, fakeOps(), ctx()),
    /message/,
  );
});

test("send_to_session wait timeout defaults and caps (#275)", async () => {
  const ops = fakeOps();
  await executeAgentTool(
    "send_to_session",
    { sessionId: "t", message: "hi" },
    ops,
    ctx(),
  );
  assert.equal(ops.calls.deliver[0].wait, false);
  assert.equal(ops.calls.deliver[0].waitTimeoutMs, 120000);
  const capped = fakeOps();
  await executeAgentTool(
    "send_to_session",
    { sessionId: "t", message: "hi", waitTimeoutMs: 9999999 },
    capped,
    ctx(),
  );
  assert.equal(capped.calls.deliver[0].waitTimeoutMs, 300000);
});

test("attribution format keeps the full source ID for sidebar lookup (#275)", () => {
  assert.equal(
    formatAttributedMessage("019c625b-b900-7000-8000-000000000277", "hello"),
    "[From session 019c625b-b900-7000-8000-000000000277 via keylime agent tools]: hello",
  );
});

test("chain depth stops a loop and a failed delivery does not advance it (#275)", async () => {
  const guard = new AgentToolGuard();
  guard.setDepth("source-1", 5);
  await assert.rejects(
    () =>
      executeAgentTool(
        "send_to_session",
        { sessionId: "t", message: "hi" },
        fakeOps(),
        ctx({ guard }),
      ),
    /chain depth/,
  );

  const failing = fakeOps({
    async deliver() {
      throw new Error("target vanished");
    },
  });
  const guard2 = new AgentToolGuard();
  await assert.rejects(
    () =>
      executeAgentTool(
        "send_to_session",
        { sessionId: "t", message: "hi" },
        failing,
        ctx({ guard: guard2 }),
      ),
    /target vanished/,
  );
  assert.equal(guard2.depthFor("t"), 0);

  const ok = fakeOps();
  await executeAgentTool(
    "send_to_session",
    { sessionId: "t", message: "hi" },
    ok,
    ctx({ guard: guard2 }),
  );
  assert.equal(guard2.depthFor("t"), 1);
});

test("rate limit caps a source at 20 agent tool calls per minute (#275)", async () => {
  const guard = new AgentToolGuard();
  const ops = fakeOps();
  for (let i = 0; i < 20; i++) {
    await executeAgentTool("list_sessions", {}, ops, ctx({ guard }));
  }
  await assert.rejects(
    () => executeAgentTool("list_sessions", {}, ops, ctx({ guard })),
    /rate limit/,
  );
});

test("agent tools reject an explicit host before invoking any operation", async () => {
  const ops = fakeOps();
  for (const [tool, args] of [
    ["list_sessions", {}],
    ["new_session", { cwd: "/tmp/source" }],
    ["send_to_session", { sessionId: "target-1", message: "hi" }],
    [
      "register_workspace_pr",
      { prUrl: "https://github.com/test/repo/pull/42" },
    ],
    ["monitor_workspace_pr", {}],
    ["get_workspace_pr", {}],
  ] as const) {
    for (const host of ["local", "h-build", null, undefined]) {
      await assert.rejects(
        () => executeAgentTool(tool, { ...args, host }, ops, ctx()),
        /do not accept a "host" argument/,
      );
    }
  }
  assert.deepEqual(ops.calls, {
    list: [],
    create: [],
    deliver: [],
    register: [],
    monitor: 0,
    lookup: 0,
  });
});

test("new_session pins remote creation to the caller and preserves shared workspace intent", async () => {
  const ops = fakeOps();
  const source = ctx({ sourceHostId: "h-build", sourceCwd: "/srv/app" });
  await executeAgentTool("new_session", { shareWorkspace: true }, ops, source);
  assert.equal(ops.calls.create[0].hostId, "h-build");
  assert.equal(ops.calls.create[0].cwd, "/srv/app");
  assert.equal(ops.calls.create[0].shareWorkspace, true);
  await assert.rejects(
    () =>
      executeAgentTool(
        "new_session",
        { shareWorkspace: true, cwd: "/srv/other" },
        ops,
        source,
      ),
    /requires the calling session's directory/,
  );
  assert.equal(ops.calls.create.length, 1);
  await executeAgentTool("new_session", { cwd: "/srv/other" }, ops, source);
  assert.equal(ops.calls.create[1].hostId, "h-build");
  assert.equal(ops.calls.create[1].cwd, "/srv/other");
  assert.equal(ops.calls.create[1].shareWorkspace, false);
});

test("send_to_session forwards the caller's host to target lookup and delivery", async () => {
  const ops = fakeOps();
  for (const sourceHostId of ["local", "h-build"]) {
    await executeAgentTool(
      "send_to_session",
      { sessionId: "target-1", message: "hi" },
      ops,
      ctx({ sourceHostId }),
    );
  }
  assert.deepEqual(
    ops.calls.deliver.map(({ sourceHostId, sessionId }) => [
      sourceHostId,
      sessionId,
    ]),
    [
      ["local", "target-1"],
      ["h-build", "target-1"],
    ],
  );
});

test("unknown agent tools are rejected (#275)", async () => {
  await assert.rejects(
    () => executeAgentTool("delete_everything", {}, fakeOps(), ctx()),
    /Unknown agent tool/,
  );
});

test("new_session rejects malformed shared-workspace intent before creating anything", async () => {
  for (const shareWorkspace of ["true", 1, null, {}, []]) {
    const ops = fakeOps();
    await assert.rejects(
      () => executeAgentTool("new_session", { shareWorkspace }, ops, ctx()),
      /shareWorkspace.*boolean/,
    );
    assert.equal(ops.calls.create.length, 0);
  }
});

test("new_session preserves the enable, rate and chain-depth guards", async () => {
  const ops = fakeOps();
  await assert.rejects(
    () => executeAgentTool("new_session", {}, ops, ctx({ enabled: false })),
    /disabled/,
  );
  const deep = new AgentToolGuard();
  deep.setDepth("source-1", 5);
  await assert.rejects(
    () => executeAgentTool("new_session", {}, ops, ctx({ guard: deep })),
    /chain depth/,
  );
  const busy = new AgentToolGuard();
  for (let i = 0; i < 20; i++) busy.checkRate("source-1");
  await assert.rejects(
    () => executeAgentTool("new_session", {}, ops, ctx({ guard: busy })),
    /rate limit/,
  );
  assert.equal(ops.calls.create.length, 0);
});
