import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ChannelTable } from "./daemon-channels.ts";
import { RESUME_PROMPT } from "./host-resume.ts";
import { LINK_PROTOCOL_VERSION } from "./link-protocol.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonLink } from "./daemon-link.ts";
import type { Unsequenced, UpMessage } from "./link-protocol.ts";
import type { SpawnRequest } from "./host.ts";
import type { RpcTransport } from "../omp/rpc-transport.ts";

type Frame = {
  t: string;
  op: string;
  id: string | number;
  args: Record<string, string>;
  result: unknown;
};
type Child = {
  request: SpawnRequest;
  transport: RpcTransport;
  writes: Frame[];
  kills: boolean[];
  holdExit: boolean;
  exit(force?: boolean): void;
  emit(frame: object): void;
  stderr(chunk: string): void;
};
type TestLink = DaemonLink & { login: { url: string; token: string } };
type OutputItem = { id: string; body: Unsequenced<UpMessage>; key?: string };
function line(item: OutputItem): string {
  assert.ok(item.body.type === "stdout");
  return item.body.line;
}

const SAVED = "11111111-1111-4111-8111-111111111111";
const MOVED = "22222222-2222-4222-8222-222222222222";
const launch = {
  cwd: "/tmp",
  recordedCwd: null,
  sessionFile: "/tmp/s.jsonl",
  advisor: false,
};
/** Commands the daemon sends on its own: the fake child answers them, never a link's. */
const DAEMON_OPS = new Set([
  "set_event_filter",
  "set_subagent_subscription",
  "set_host_tools",
  "set_host_uri_schemes",
]);
const cmd = (id: string | number, op: string, args: object = {}) =>
  JSON.stringify({ t: "cmd", id, op, args });
const ev = (child: Child, event: object) => child.emit({ t: "event", event });
/** The commands links sent, as the child received them (ids remapped by the daemon). */
const own = (child: Child) =>
  child.writes.filter(
    (frame) =>
      frame.t === "cmd" &&
      !DAEMON_OPS.has(frame.op) &&
      frame.args?.message !== RESUME_PROMPT,
  );
const stdoutFrames = (h: { output: OutputItem[] }, linkId?: string) =>
  h.output
    .filter(
      (item) =>
        item.body.type === "stdout" &&
        (linkId === undefined || item.id === linkId),
    )
    .map((item) => JSON.parse(line(item)));
function harness(launchAdvisor = false, hello: object = {}) {
  const children: Child[] = [],
    output: OutputItem[] = [],
    changed: string[] = [],
    logs: string[] = [];
  // What a spawned child does first; a test may replace it (exit during startup, for one).
  const hooks: {
    startup(child: Child, request: SpawnRequest): void;
    holdDaemonReplies?: boolean;
  } = {
    startup: (child, request) =>
      child.emit({
        t: "hello",
        proto: 1,
        pid: 1,
        sessionId: request.sessionFile ? SAVED : randomUUID(),
        sessionFile: request.sessionFile,
        cwd: request.cwd,
        ...hello,
      }),
  };
  const links = ["l1", "l2"].map((id) => ({
    id,
    version: LINK_PROTOCOL_VERSION,
    isUp: () => true,
    queue(body: Unsequenced<UpMessage>, key: string) {
      output.push({ id, body, key });
      return 1;
    },
    output(body: Unsequenced<UpMessage>) {
      output.push({ id, body });
    },
    discard() {},
  })) as unknown as TestLink[];
  async function spawn(request: SpawnRequest) {
    const listeners: {
        line?: (line: string) => void;
        stderr?: (chunk: string) => void;
      } = {},
      writes: Frame[] = [],
      exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[] =
        [];
    const transport: RpcTransport = {
      write(line, callback) {
        const frame = JSON.parse(line);
        writes.push(frame);
        callback?.(null);
        if (
          frame.t === "cmd" &&
          !hooks.holdDaemonReplies &&
          (DAEMON_OPS.has(frame.op) || frame.args?.message === RESUME_PROMPT)
        ) {
          queueMicrotask(() =>
            listeners.line?.(
              JSON.stringify({ t: "res", id: frame.id, ok: true, data: {} }),
            ),
          );
        }
      },
      endInput() {},
      killTree(force) {
        child.kills.push(force);
        if (!child.holdExit) child.exit(force);
      },
      onLine(fn) {
        listeners.line = fn;
        return () => {};
      },
      onStderr(fn) {
        listeners.stderr = fn;
        return () => {};
      },
      onExit(fn) {
        exits.push(fn);
        return () => {};
      },
    };
    const child: Child = {
      request,
      transport,
      writes,
      kills: [],
      holdExit: false,
      exit(force = false) {
        for (const exit of exits) exit(0, force ? "SIGKILL" : null);
      },
      emit(frame) {
        listeners.line?.(JSON.stringify(frame));
      },
      stderr(chunk) {
        listeners.stderr?.(chunk);
      },
    };
    children.push(child);
    setTimeout(() => hooks.startup(child, request), 0);
    return { transport, cwd: request.cwd, fellBack: false, launchAdvisor };
  }
  const table = new ChannelTable({
    sessionId: () => SAVED,
    prepareLaunch: (x) => x,
    log: (message) => logs.push(message),
    channelsChanged: (ch) => changed.push(ch),
    spawn,
  });
  return {
    table,
    children,
    output,
    changed,
    logs,
    hooks,
    spawn,
    a: links[0],
    b: links[1],
  };
}

test("concurrent opens spawn once; command order and replies stay source-owned", async () => {
  const h = harness();
  const [a, b] = await Promise.all([
    h.table.open(h.a, { sessionId: SAVED, launch }),
    h.table.open(h.b, { sessionId: SAVED, launch }),
  ]);
  assert.equal(h.children.length, 1);
  assert.equal(a.ch, b.ch);
  h.table.release(h.a, a.ch);
  h.table.release(h.b, b.ch);
  // Both links number their commands 1: the daemon gives each its own id toward the child and restores the link's on the reply.
  h.table.stdin(h.a, a.ch, cmd(1, "get_messages", { who: "a" }));
  h.table.stdin(h.b, a.ch, cmd(1, "get_messages", { who: "b" }));
  const sent = own(h.children[0]);
  assert.deepEqual(
    sent.map((frame) => frame.args.who),
    ["a", "b"],
  );
  assert.notEqual(sent[0].id, sent[1].id);
  for (const frame of sent)
    h.children[0].emit({
      t: "res",
      id: frame.id,
      ok: true,
      data: { who: frame.args.who },
    });
  assert.deepEqual(
    stdoutFrames(h).map((frame) => [frame.id, frame.data.who]),
    [
      [1, "a"],
      [1, "b"],
    ],
  );
  assert.deepEqual(
    h.output.map((item) => item.id),
    ["l1", "l2"],
  );
  assert.throws(() =>
    h.table.stdin(
      { ...h.a, id: "guessed" } as DaemonLink,
      a.ch,
      cmd(1, "get_messages"),
    ),
  );
  await h.table.stop();
});

test("shared opens report the actual advisor flag even when a joining link requests another mode", async () => {
  for (const [requested, forced] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    const h = harness(forced);
    const first = await h.table.open(h.a, {
      sessionId: SAVED,
      launch: { ...launch, advisor: requested },
    });
    const joined = await h.table.open(h.b, {
      sessionId: SAVED,
      launch: { ...launch, advisor: !requested },
    });
    assert.equal(first.advisorSpawned, requested || forced);
    assert.equal(joined.advisorSpawned, requested || forced);
    assert.equal(joined.launchAdvisor, forced);
    assert.equal(h.children.length, 1);
    await h.table.stop();
  }
});

test("an idle advisor replacement fences opens and correlates late stdin refusal before killing once", async () => {
  const h = harness(),
    first = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, first.ch);
  const old = h.children[0];
  old.holdExit = true;
  const replacement = h.table.open(h.b, {
    sessionId: SAVED,
    launch: { ...launch, advisor: true },
    replaceAdvisor: true,
    preparing: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(old.kills, [false]);
  h.table.stdin(
    h.a,
    first.ch,
    cmd("late-prompt", "prompt", { message: "must not disappear" }),
  );
  const refused = stdoutFrames(h).find((frame) => frame.id === "late-prompt");
  assert.equal(refused.t, "res");
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "session_restarting");
  assert.equal(
    old.writes.some((frame) => frame.args?.message === "must not disappear"),
    false,
  );
  let joined = false;
  const joining = h.table
    .open(h.a, { sessionId: SAVED, launch })
    .then((result) => {
      joined = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(joined, false);
  old.exit();
  const [next, peer] = await Promise.all([replacement, joining]);
  assert.notEqual(next.ch, first.ch);
  assert.equal(peer.ch, next.ch);
  assert.equal(next.advisorSpawned, true);
  assert.equal(h.children.length, 2);
  const held = await h.table.open(h.a, {
    sessionId: SAVED,
    launch,
    replaceAdvisor: true,
  });
  assert.equal(
    held.ch,
    next.ch,
    "the source's preparation handoff protects its new child",
  );
  h.table.setInterest(h.b, next.ch, true, false);
  await h.table.stop();
});

test("advisor changes never replace a peer command, unsettled background work, dialog or preparation", async () => {
  for (const phase of [
    "command",
    "acknowledged",
    "running",
    "unsettled",
    "dialog",
    "preparing",
  ]) {
    const h = harness(),
      first = await h.table.open(h.a, { sessionId: SAVED, launch });
    h.table.release(h.a, first.ch);
    const child = h.children[0];
    if (phase === "command" || phase === "acknowledged")
      h.table.stdin(
        h.a,
        first.ch,
        cmd("peer-prompt", "prompt", { message: "work" }),
      );
    if (phase === "acknowledged")
      child.emit({
        t: "res",
        id: own(child)[0].id,
        ok: true,
        data: { agentInvoked: true },
      });
    if (phase === "running" || phase === "unsettled")
      ev(child, { type: "agent_start" });
    if (phase === "unsettled")
      ev(child, { type: "agent_end", isTerminal: true });
    if (phase === "dialog")
      child.emit({ t: "ui_request", id: 1, method: "ask", args: {} });
    if (phase === "preparing") h.table.setInterest(h.a, first.ch, false, true);
    const joined = await h.table.open(h.b, {
      sessionId: SAVED,
      launch: { ...launch, advisor: true },
      replaceAdvisor: true,
    });
    assert.equal(joined.ch, first.ch, phase);
    assert.equal(joined.advisorSpawned, false, phase);
    assert.deepEqual(child.kills, [], phase);
    await h.table.stop();
  }
});

test("join captures full stream and dialogs before later deltas; first answer closes the other UI", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  const child = h.children[0];
  ev(child, {
    type: "message_start",
    messageId: "m",
    message: { role: "assistant", content: [{ type: "text", text: "one" }] },
  });
  child.emit({ t: "ui_request", id: 1, method: "ask", args: {} });
  const b = await h.table.open(h.b, { sessionId: SAVED, launch });
  assert.equal(JSON.parse(b.streaming!).event.message.content[0].text, "one");
  assert.equal(JSON.parse(b.pending![0]).id, 1);
  ev(child, {
    type: "message_update",
    messageId: "m",
    message: { role: "assistant" },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "two",
    },
  });
  assert.equal(h.output.filter((x) => x.id === "l2").length, 0);
  h.table.release(h.b, b.ch);
  assert.equal(h.output.filter((x) => x.id === "l2").length, 1);
  h.table.stdin(
    h.b,
    b.ch,
    JSON.stringify({ t: "ui_response", id: 1, value: "x" }),
  );
  h.table.stdin(
    h.a,
    a.ch,
    JSON.stringify({ t: "ui_response", id: 1, value: "y" }),
  );
  assert.equal(
    child.writes.filter((frame) => frame.t === "ui_response").length,
    1,
  );
  assert.ok(
    h.output.some(
      (x) =>
        x.id === "l1" &&
        x.body.type === "stdout" &&
        JSON.parse(x.body.line).t === "ui_end" &&
        JSON.parse(x.body.line).id === 1,
    ),
  );
  await h.table.stop();
});

test("a private res is never broadcast; a session frame after a persistence notice moves identity and keeps aliases", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  const b = await h.table.open(h.b, { sessionId: SAVED, launch });
  h.table.release(h.b, b.ch);
  ev(h.children[0], {
    type: "notice",
    source: "session-persistence",
    level: "info",
  });
  h.output.length = 0;
  h.table.stdin(h.a, a.ch, cmd("a", "get_state_probe"));
  h.children[0].emit({
    t: "res",
    id: own(h.children[0])[0].id,
    ok: true,
    data: { pad: "x".repeat(1100000) },
  });
  assert.equal(h.output.filter((x) => x.id === "l2").length, 0);
  assert.deepEqual(
    h.output.filter((x) => x.id === "l1").map((x) => JSON.parse(line(x)).id),
    ["a"],
  );
  h.children[0].emit({
    t: "session",
    sessionId: MOVED,
    sessionFile: "/tmp/moved.jsonl",
  });
  assert.equal(
    (await h.table.open(h.b, { sessionId: SAVED, launch })).ch,
    a.ch,
  );
  assert.equal(
    (
      await h.table.open(h.b, {
        sessionId: MOVED,
        launch: { ...launch, sessionFile: "/tmp/moved.jsonl" },
      })
    ).ch,
    a.ch,
  );
  assert.equal(h.table.listing(h.a)[0].sessionId, MOVED);
  assert.equal(h.children.length, 1);
  await h.table.stop();
});

test("startup sets global settings once for two members; links may not send daemon-owned ops", async () => {
  const h = harness();
  const a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch });
  assert.deepEqual(
    h.children[0].writes.map((frame) => [frame.t, frame.op]),
    [
      ["cmd", "set_event_filter"],
      ["cmd", "set_subagent_subscription"],
    ],
  );
  assert.deepEqual(h.children[0].writes[0].args, {
    events: null,
    messageUpdates: "delta",
  });
  assert.deepEqual(h.children[0].writes[1].args, { level: "events" });
  for (const op of DAEMON_OPS)
    assert.throws(() => h.table.stdin(h.a, a.ch, cmd(1, op)), {
      code: "invalid_request",
    });
  assert.equal(h.children[0].writes.length, 2);
  assert.deepEqual(h.output, []);
  h.table.release(h.a, a.ch);
  await h.table.stop();
});

test("only a rejoining member that lost no output is told its stream is continuous", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  assert.equal(a.continuous, undefined, "a new member needs the snapshot");
  ev(h.children[0], { type: "notice", message: "sent on" });
  const rejoined = await h.table.open(h.a, {
    sessionId: SAVED,
    launch,
    expectedChannel: a.ch,
  });
  h.table.release(h.a, a.ch);
  assert.equal(rejoined.continuous, true);
  // Output queued behind a pending open is superseded by that open's snapshot: not continuous.
  await h.table.open(h.a, { sessionId: SAVED, launch, expectedChannel: a.ch });
  ev(h.children[0], { type: "notice", message: "queued" });
  const behind = await h.table.open(h.a, {
    sessionId: SAVED,
    launch,
    expectedChannel: a.ch,
  });
  assert.equal(behind.continuous, undefined);
  await h.table.stop();
});

test("open never waits on a runner that answers startup commands late; replies nobody owns never reach a member", async () => {
  const h = harness();
  h.hooks.holdDaemonReplies = true;
  const a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  const child = h.children[0];
  h.table.stdin(h.a, a.ch, cmd(1, "get_state"));
  // Late answers to timed-out startup commands: ids the daemon no longer owns.
  child.emit({ t: "res", id: 1, ok: true });
  child.emit({ t: "res", id: 2, ok: true });
  child.emit({ t: "res", id: 99, ok: true });
  assert.deepEqual(stdoutFrames(h), []);
  child.emit({
    t: "res",
    id: own(child)[0].id,
    ok: true,
    data: { state: true },
  });
  assert.deepEqual(
    stdoutFrames(h).map((frame) => [frame.id, frame.data]),
    [[1, { state: true }]],
  );
  await h.table.stop();
});

test("a child that speaks another channel protocol fails startup and is killed", async () => {
  const h = harness(false, { proto: 2 });
  await assert.rejects(h.table.open(h.a, { sessionId: SAVED, launch }), {
    code: "host_process_exited",
  });
  assert.deepEqual(h.children[0].kills, [true]);
  assert.deepEqual(
    h.children[0].writes,
    [],
    "no setting is sent to a child of an unknown protocol",
  );
  assert.equal(h.table.size, 0);
  await h.table.stop();
});

test("a message_update the snapshot cannot apply moves the child to full updates once", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  const orphan = {
    type: "message_update",
    messageId: "m",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
  };
  ev(h.children[0], orphan);
  ev(h.children[0], orphan);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    h.children[0].writes
      .filter((frame) => frame.op === "set_event_filter")
      .map((frame) => frame.args.messageUpdates),
    ["delta", "full"],
  );
  await h.table.stop();
});

test("closing one membership neither kills the child nor broadcasts its late reply", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  h.table.release(h.b, a.ch);
  h.table.stdin(h.a, a.ch, cmd("old", "get_messages"));
  h.table.stdin(h.b, a.ch, cmd("old", "get_messages")); // The other link's own numbering never collides.
  const [first] = own(h.children[0]);
  h.table.close(h.a, a.ch);
  h.children[0].emit({ t: "res", id: first.id, ok: true, data: {} });
  assert.deepEqual(h.output, []);
  assert.equal(h.table.size, 1);
  assert.equal(
    (await h.table.open(h.a, { sessionId: SAVED, launch })).joined,
    true,
  );
  await h.table.stop();
});

test("delete fence waits for exit and prevents a concurrent reopen until the mutation completes", async () => {
  const h = harness();
  await h.table.open(h.a, { sessionId: SAVED, launch });
  const gate = Promise.withResolvers<void>();
  let entered = false,
    reopened = false;
  const deletion = h.table.mutateSession(SAVED, async (canonical) => {
    assert.equal(canonical, SAVED);
    assert.equal(h.table.size, 0);
    entered = true;
    await gate.promise;
    return "deleted";
  });
  const opening = h.table.open(h.b, { sessionId: SAVED, launch }).then(() => {
    reopened = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(entered, true);
  assert.equal(reopened, false);
  gate.resolve();
  assert.equal(await deletion, "deleted");
  await opening;
  assert.equal(h.children.length, 2);
  await h.table.stop();
});

test("recovery and two server opens share one spawn and one daemon-owned resume prompt", async () => {
  const h = harness();
  await Promise.all([
    h.table.recover([{ sessionId: SAVED, launch }]),
    h.table.open(h.a, { sessionId: SAVED, launch }),
    h.table.open(h.b, { sessionId: SAVED, launch }),
  ]);
  assert.equal(h.children.length, 1);
  const prompts = h.children[0].writes.filter((frame) => frame.op === "prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].args.message, RESUME_PROMPT);
  assert.deepEqual(h.output, []);
  await h.table.stop();
});

test("only the chosen callback executor receives the request but both members receive the committed result", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  h.table.release(h.b, a.ch);
  for (const link of [h.a, h.b])
    h.table.setTools(link, a.ch, [{ name: "open_url" }], []);
  await new Promise((resolve) => setImmediate(resolve)); // omp answers set_host_tools before it can call the tool
  h.table.stdin(h.b, a.ch, cmd("p", "prompt", { message: "open" }));
  h.children[0].emit({
    t: "host_tool_call",
    id: 7,
    toolName: "open_url",
    arguments: {},
  });
  // The non-prompting member sees only the daemon's peer-admission marker, never the callback.
  assert.deepEqual(
    h.output.map((item) => [item.id, JSON.parse(line(item)).t]),
    [
      ["l1", "peer_message_command"],
      ["l2", "host_tool_call"],
    ],
  );
  h.table.stdin(
    h.a,
    a.ch,
    JSON.stringify({ t: "host_tool_result", id: 7, result: "no" }),
  );
  h.table.stdin(
    h.b,
    a.ch,
    JSON.stringify({ t: "host_tool_result", id: 7, result: "yes" }),
  );
  assert.deepEqual(
    h.children[0].writes
      .filter((frame) => frame.t === "host_tool_result")
      .map(({ id, result }) => ({ id, result })),
    [{ id: 7, result: "yes" }],
  );
  ev(h.children[0], {
    type: "tool_execution_end",
    toolCallId: 7,
    toolName: "open_url",
    result: "yes",
  });
  assert.deepEqual(
    h.output
      .filter(
        (item) => JSON.parse(line(item)).event?.type === "tool_execution_end",
      )
      .map((item) => item.id),
    ["l1", "l2"],
  );
  await h.table.stop();
});

test("a prompt_result returns under the sending link's own id, to that link only", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  h.table.release(h.b, a.ch);
  h.table.stdin(h.a, a.ch, cmd(1000, "prompt", { message: "hi" }));
  const [sent] = own(h.children[0]);
  assert.notEqual(sent.id, 1000);
  h.children[0].emit({
    t: "res",
    id: sent.id,
    ok: true,
    data: { agentInvoked: true },
  });
  h.children[0].emit({ t: "prompt_result", id: sent.id, text: "done" });
  const results = h.output.filter(
    (item) =>
      item.body.type === "stdout" &&
      ["res", "prompt_result"].includes(JSON.parse(item.body.line).t),
  );
  assert.deepEqual(
    results.map((item) => [
      item.id,
      JSON.parse(line(item)).t,
      JSON.parse(line(item)).id,
    ]),
    [
      ["l1", "res", 1000],
      ["l1", "prompt_result", 1000],
    ],
  );
  await h.table.stop();
});

test("a prompt's outcome reaches the other members uncorrelated, so the elected notifier sees a peer's failure", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  h.table.release(h.b, a.ch);
  h.table.stdin(h.a, a.ch, cmd(1000, "prompt", { message: "hi" }));
  h.table.stdin(h.a, a.ch, cmd(1001, "prompt", { message: "again" }));
  const [first, second] = own(h.children[0]);
  h.children[0].emit({
    t: "prompt_result",
    id: first.id,
    agentInvoked: true,
    status: "error",
    error: { message: "boom" },
  });
  h.children[0].emit({
    t: "prompt_error",
    id: second.id,
    command: "prompt",
    error: "No API key",
  });
  const outcomes = (frames: { t: string; id?: string | number }[]) =>
    frames.filter((frame) =>
      ["prompt_result", "prompt_error", "peer_prompt_outcome"].includes(
        frame.t,
      ),
    );
  assert.deepEqual(
    outcomes(stdoutFrames(h, "l1")).map((frame) => [frame.t, frame.id]),
    [
      ["prompt_result", 1000],
      ["prompt_error", 1001],
    ],
  );
  assert.deepEqual(outcomes(stdoutFrames(h, "l2")), [
    {
      t: "peer_prompt_outcome",
      outcome: {
        t: "prompt_result",
        agentInvoked: true,
        status: "error",
        error: { message: "boom" },
      },
    },
    {
      t: "peer_prompt_outcome",
      outcome: { t: "prompt_error", command: "prompt", error: "No API key" },
    },
  ]);
  await h.table.stop();
});

test("an adopted channel has no idle stop and is never recorded as running", async () => {
  const saved = process.env.KEYLIME_DISCONNECT_DESTROY_MS;
  process.env.KEYLIME_DISCONNECT_DESTROY_MS = "1"; // an unattended spawned child stops after 1 ms
  try {
    const control = harness(),
      first = await control.table.open(control.a, { sessionId: SAVED, launch });
    assert.ok(first.ch);
    const h = harness(),
      spawned = await h.spawn(launch);
    const ch = await h.table.adopt(spawned, launch);
    assert.deepEqual(h.changed, [ch]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      control.children[0].kills,
      [false],
      "the same unattended child is stopped when the daemon spawned it",
    );
    assert.deepEqual(
      h.children[0].kills,
      [],
      "a lifecycle stop never kills a TUI's runner",
    );
    assert.equal(h.table.size, 1);
    ev(h.children[0], { type: "agent_start" });
    assert.equal(h.table.activeTurns, 1);
    assert.deepEqual(h.table.running(), []);
    await control.table.stop();
    await h.table.stop();
  } finally {
    if (saved === undefined) delete process.env.KEYLIME_DISCONNECT_DESTROY_MS;
    else process.env.KEYLIME_DISCONNECT_DESTROY_MS = saved;
  }
});

test("shared removal never kills; permanent removal during spawn cannot attach a dead shared member", async () => {
  const removed = harness();
  await removed.table.open(removed.a, { sessionId: SAVED, launch });
  removed.table.linkGone(removed.a);
  assert.equal(removed.table.size, 1);
  await removed.table.stop();
  const shared = harness();
  const a = shared.table.open(shared.a, { sessionId: SAVED, launch });
  const b = shared.table.open(shared.b, { sessionId: SAVED, launch });
  shared.table.linkGone(shared.a);
  await assert.rejects(
    a,
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "host_link_closed",
  );
  const opened = await b;
  assert.deepEqual(
    shared.table.members(opened.ch).map((link) => link.id),
    ["l2"],
  );
  assert.equal(shared.children.length, 1);
  await shared.table.stop();
});

test("concurrent opens by one member release live output only after both results are published", async () => {
  const h = harness();
  const [first, second] = await Promise.all([
    h.table.open(h.a, { sessionId: SAVED, launch }),
    h.table.open(h.a, { sessionId: SAVED, launch }),
  ]);
  ev(h.children[0], {
    type: "message_start",
    messageId: "m",
    message: { role: "assistant", content: [] },
  });
  h.table.release(h.a, first.ch);
  assert.deepEqual(h.output, []);
  h.table.release(h.a, second.ch);
  assert.equal(h.output.length, 1);
  await h.table.stop();
});

for (const operation of ["open", "delete"]) {
  test(`a fork keeps its parent independent when the parent is ${operation}d`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-fork-identity-"));
    const parent = join(dir, "parent.jsonl"),
      fork = join(dir, "fork.jsonl");
    for (const [file, id] of [
      [parent, SAVED],
      [fork, MOVED],
    ])
      writeFileSync(
        file,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id,
          cwd: "/tmp",
          timestamp: "2026-01-01T00:00:00Z",
        })}\n`,
      );
    const h = harness();
    try {
      const original = await h.table.open(h.a, {
        sessionId: SAVED,
        launch: { ...launch, sessionFile: parent },
      });
      h.children[0].emit({ t: "session", sessionId: MOVED, sessionFile: fork });
      if (operation === "open") {
        const reopened = await h.table.open(h.b, {
          sessionId: SAVED,
          launch: { ...launch, sessionFile: parent },
        });
        assert.notEqual(reopened.ch, original.ch);
        assert.equal(h.children.length, 2);
      } else {
        await h.table.mutateSession(SAVED, async (canonical) => {
          assert.equal(
            canonical,
            SAVED,
            "deleting the parent must never target the fork",
          );
          assert.equal(h.table.size, 1, "the fork's process must remain alive");
        });
      }
    } finally {
      await h.table.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a native copy-on-write move retains aliases even while the original file still exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-native-move-"));
  const parent = join(dir, "original.jsonl"),
    moved = join(dir, "moved.jsonl");
  writeFileSync(
    parent,
    `${JSON.stringify({ type: "session", version: 3, id: SAVED, cwd: "/tmp" })}\n`,
  );
  const h = harness();
  try {
    const opened = await h.table.open(h.a, {
      sessionId: SAVED,
      launch: { ...launch, sessionFile: parent },
    });
    ev(h.children[0], {
      type: "notice",
      source: "session-persistence",
      level: "info",
      message: "Session moved",
    });
    h.children[0].emit({ t: "session", sessionId: MOVED, sessionFile: moved });
    assert.equal(
      (
        await h.table.open(h.b, {
          sessionId: SAVED,
          launch: { ...launch, sessionFile: parent },
        })
      ).ch,
      opened.ch,
    );
    assert.equal(
      (
        await h.table.open(h.b, {
          sessionId: MOVED,
          launch: { ...launch, sessionFile: moved },
        })
      ).ch,
      opened.ch,
    );
    assert.equal(h.children.length, 1);
  } finally {
    await h.table.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new source's preparation lease survives startup until its first command owns it", async () => {
  const h = harness();
  const first = await h.table.open(h.a, {
    sessionId: SAVED,
    launch,
    preparing: true,
  });
  const protectedJoin = await h.table.open(h.b, {
    sessionId: SAVED,
    launch: { ...launch, advisor: true },
    replaceAdvisor: true,
  });
  assert.equal(protectedJoin.ch, first.ch);
  assert.deepEqual(h.children[0].kills, []);
  h.table.setInterest(h.a, first.ch, true, false);
  const changed = await h.table.open(h.b, {
    sessionId: SAVED,
    launch: { ...launch, advisor: true },
    replaceAdvisor: true,
  });
  assert.notEqual(changed.ch, first.ch);
  assert.equal(changed.advisorSpawned, true);
  await h.table.stop();
});

test("a passive join for an exited advertised channel never respawns its saved file", async () => {
  const h = harness();
  const first = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.children[0].exit();
  await assert.rejects(
    h.table.open(h.b, { sessionId: SAVED, launch, expectedChannel: first.ch }),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 404 &&
      "code" in error &&
      error.code === "session_not_running",
  );
  assert.equal(h.children.length, 1);
  assert.equal(h.table.size, 0);
  await h.table.stop();
});

test("destructive operations on an old copy-on-write file never retarget its live continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-native-move-delete-"));
  const original = join(dir, "original.jsonl"),
    moved = join(dir, "moved.jsonl");
  writeFileSync(
    original,
    `${JSON.stringify({ type: "session", version: 3, id: SAVED, cwd: "/tmp" })}\n`,
  );
  const h = harness();
  try {
    await h.table.open(h.a, {
      sessionId: SAVED,
      launch: { ...launch, sessionFile: original },
    });
    ev(h.children[0], {
      type: "notice",
      source: "session-persistence",
      level: "info",
      message: "Session moved",
    });
    h.children[0].emit({ t: "session", sessionId: MOVED, sessionFile: moved });
    let requested;
    await h.table.mutateSession(SAVED, async (id) => {
      requested = id;
    });
    assert.equal(requested, SAVED);
    assert.equal(h.table.size, 1);
    assert.deepEqual(
      h.children[0].kills,
      [],
      "the moved session's process still owns only the continuation",
    );
  } finally {
    await h.table.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit close releases only its own preparation handoff, including startup failure cleanup", async () => {
  const h = harness();
  const first = await h.table.open(h.a, {
    sessionId: SAVED,
    launch,
    preparing: true,
  });
  await h.table.open(h.b, { sessionId: SAVED, launch, preparing: true });
  h.table.close(h.a, first.ch);
  const held = await h.table.open(h.a, {
    sessionId: SAVED,
    launch: { ...launch, advisor: true },
    replaceAdvisor: true,
  });
  assert.equal(
    held.ch,
    first.ch,
    "the other member's preparation remains protected",
  );
  h.table.close(h.b, first.ch);
  const replaced = await h.table.open(h.a, {
    sessionId: SAVED,
    launch: { ...launch, advisor: true },
    replaceAdvisor: true,
  });
  assert.notEqual(
    replaced.ch,
    first.ch,
    "closed members leave no residual preparation lease",
  );
  await h.table.stop();
});

test("a recovering run is protected from a competing advisor open before its resume prompt starts", async () => {
  const h = harness();
  const [, joined] = await Promise.all([
    h.table.recover([{ sessionId: SAVED, launch }]),
    h.table.open(h.b, {
      sessionId: SAVED,
      launch: { ...launch, advisor: true },
      replaceAdvisor: true,
    }),
  ]);
  assert.equal(h.children.length, 1);
  assert.equal(joined.advisorSpawned, false);
  assert.deepEqual(h.children[0].kills, []);
  assert.equal(
    h.children[0].writes.filter((frame) => frame.op === "prompt").length,
    1,
  );
  await h.table.stop();
});

test("a session frame updates the listing even in the middle of a run", async () => {
  const h = harness();
  try {
    const opened = await h.table.open(h.a, { sessionId: SAVED, launch });
    h.table.release(h.a, opened.ch);
    const child = h.children[0];
    ev(child, { type: "agent_start" });
    ev(child, {
      type: "notice",
      source: "session-persistence",
      level: "info",
      message: "Session moved",
    });
    child.emit({
      t: "session",
      sessionId: MOVED,
      sessionFile: "/tmp/moved-mid-run.jsonl",
    });
    assert.equal(h.table.listing(h.a)[0].sessionId, MOVED);
    assert.equal(h.children.length, 1);
  } finally {
    await h.table.stop();
  }
});

test("a history-edit lease refuses a competing editor and other links' mutations until released, dropped or closed", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  h.table.release(h.b, a.ch);
  const prompts = () =>
    h.children[0].writes
      .filter((frame) => frame.op === "prompt")
      .map((frame) => frame.args.message);
  h.table.editLease(h.a, a.ch, true);
  assert.throws(
    () => h.table.editLease(h.b, a.ch, true),
    { status: 409, code: "session_busy" },
    "a competing editor fails before its preflight",
  );
  h.table.editLease(h.b, a.ch, false); // Releasing a lease it does not hold changes nothing.
  h.table.stdin(h.b, a.ch, cmd("peer", "prompt", { message: "peer" }));
  h.table.stdin(h.b, a.ch, cmd("read", "get_messages"));
  h.table.stdin(h.a, a.ch, cmd("edit", "prompt", { message: "edit" }));
  assert.deepEqual(prompts(), ["edit"]);
  assert.ok(
    h.children[0].writes.some((frame) => frame.op === "get_messages"),
    "reads are never fenced",
  );
  const refused = stdoutFrames(h, "l2").find((frame) => frame.id === "peer");
  assert.equal(refused?.code, "session_busy");
  h.table.editLease(h.a, a.ch, false);
  h.table.editLease(h.b, a.ch, true);
  h.table.editLease(h.b, a.ch, false); // Free again: B may take it.
  h.table.stdin(h.b, a.ch, cmd("after", "prompt", { message: "after" }));
  h.table.editLease(h.a, a.ch, true);
  h.table.linkDown(h.a); // A restarted server forgets its edit.
  h.table.stdin(h.b, a.ch, cmd("dropped", "prompt", { message: "dropped" }));
  h.table.editLease(h.a, a.ch, true);
  h.table.close(h.a, a.ch);
  h.table.stdin(h.b, a.ch, cmd("closed", "prompt", { message: "closed" }));
  assert.deepEqual(prompts(), ["edit", "after", "dropped", "closed"]);
  await h.table.stop();
});

test("an exit between join and the open result's release still reaches the joining link", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.children[0].exit();
  assert.deepEqual(
    h.output.filter((item) => item.body.type === "exit"),
    [],
  );
  h.table.release(h.a, a.ch);
  assert.deepEqual(
    h.output.filter((item) => item.body.type === "exit").map((item) => item.id),
    ["l1"],
  );
  await h.table.stop();
});

test("a reopen keeps this link's queued command replies and drops output its snapshot supersedes", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.stdin(h.a, a.ch, cmd("q", "get_messages"));
  h.children[0].emit({
    t: "res",
    id: own(h.children[0])[0].id,
    ok: true,
    data: {},
  });
  ev(h.children[0], { type: "notice", message: "stale" });
  await h.table.open(h.a, { sessionId: SAVED, launch, expectedChannel: a.ch });
  h.table.release(h.a, a.ch);
  h.table.release(h.a, a.ch);
  assert.deepEqual(
    stdoutFrames(h).map((frame) => frame.id ?? "output"),
    ["q"],
  );
  await h.table.stop();
});

test("a stop the daemon makes names its reason on the exit; a crash names none", async () => {
  const h = harness(),
    a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  h.table.kill(h.a, a.ch, false);
  assert.deepEqual(
    h.output
      .filter((item) => item.body.type === "exit")
      .map((item) =>
        item.body.type === "exit" ? item.body.reason : undefined,
      ),
    ["asked"],
  );
  const b = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, b.ch);
  h.children[1].exit();
  assert.deepEqual(
    h.output
      .filter((item) => item.body.type === "exit")
      .map((item) =>
        item.body.type === "exit" ? item.body.reason : undefined,
      ),
    ["asked", undefined],
  );
  await h.table.stop();
});

test("a resumed session stays recorded as running between omp's reply and agent_start", async () => {
  const h = harness(),
    entry = { sessionId: SAVED, launch };
  assert.deepEqual(
    await h.table.recover([entry]),
    [],
    "the harness answers the prompt before any agent_start",
  );
  assert.deepEqual(
    h.table.running().map((item) => item.sessionId),
    [SAVED],
    "no gap where a crash would lose the resume",
  );
  ev(h.children[0], { type: "agent_start" });
  ev(h.children[0], { type: "agent_end", isTerminal: true });
  ev(h.children[0], { type: "session_settled" });
  assert.deepEqual(
    h.table.running(),
    [],
    "a finished resumed run is no longer recorded",
  );
  await h.table.stop();
});

test("a pooled creation joins across shared links once and cannot change intent or restart after exit", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  const created = {
    ...launch,
    sessionFile: "",
    creationId: "shared-pool-creation",
  };
  const [first, joined] = await Promise.all([
    h.table.open(h.a, { sessionId: null, launch: created, preparing: true }),
    h.table.open(h.b, { sessionId: null, launch: created, preparing: true }),
  ]);
  assert.equal(h.children.length, 1);
  assert.equal(first.ch, joined.ch);
  assert.equal(h.table.listing(h.b)[0].creationId, created.creationId);
  h.table.release(h.a, first.ch);
  h.table.release(h.b, first.ch);
  ev(h.children[0], { type: "agent_start" });
  assert.equal(
    h.table.activeTurns,
    1,
    "the shared child is counted once, not once per web app",
  );
  ev(h.children[0], { type: "agent_end", isTerminal: true });
  assert.equal(
    h.table.activeTurns,
    0,
    "an unsettled but idle child is not an executing turn",
  );
  await assert.rejects(
    h.table.open(h.a, {
      sessionId: null,
      launch: { ...created, cwd: "/elsewhere" },
    }),
    { code: "creation_conflict" },
  );
  h.children[0].exit();
  await assert.rejects(
    h.table.open(h.a, { sessionId: null, launch: created }),
    { code: "creation_conflict" },
  );
  assert.equal(
    h.children.length,
    1,
    "terminal identities must never launch replacements",
  );
});

test("only the opening link's own flag names the credentials server; a join never respawns", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.a.version = 9;
  h.a.login = { url: "https://a.example", token: "a" };
  h.b.version = 9;
  h.b.login = { url: "https://b.example", token: "b" };
  const first = await h.table.open(h.a, {
    sessionId: SAVED,
    launch: { ...launch, shareCredentials: true },
  });
  assert.equal(h.children[0].request.credentialsServer, "https://a.example");
  assert.equal("shareCredentials" in h.children[0].request, false);
  const joined = await h.table.open(h.b, { sessionId: SAVED, launch });
  assert.equal(joined.ch, first.ch);
  assert.equal(
    h.children.length,
    1,
    "the joining link reuses the sharing process",
  );
});

test("a wire-supplied credentials server never reaches the spawn", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.a.version = 9;
  h.a.login = { url: "https://a.example", token: "a" };
  await h.table.open(h.a, {
    sessionId: SAVED,
    launch: { ...launch, credentialsServer: "https://evil.example" },
  });
  assert.equal("credentialsServer" in h.children[0].request, false);
  assert.equal("shareCredentials" in h.children[0].request, false);
});

test("an advisor replacement opened with sharing starts on the opening link's server", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.a.version = 9;
  h.a.login = { url: "https://a.example", token: "a" };
  h.b.version = 9;
  h.b.login = { url: "https://b.example", token: "b" };
  const first = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, first.ch);
  assert.equal("credentialsServer" in h.children[0].request, false);
  const next = await h.table.open(h.b, {
    sessionId: SAVED,
    launch: { ...launch, advisor: true, shareCredentials: true },
    replaceAdvisor: true,
  });
  assert.notEqual(next.ch, first.ch);
  assert.equal(h.children.length, 2);
  assert.equal(h.children[1].request.credentialsServer, "https://b.example");
  assert.equal("shareCredentials" in h.children[1].request, false);
});

test("an advisor replacement opened without sharing starts on the host's own logins", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.a.version = 9;
  h.a.login = { url: "https://a.example", token: "a" };
  const first = await h.table.open(h.a, {
    sessionId: SAVED,
    launch: { ...launch, shareCredentials: true },
  });
  h.table.release(h.a, first.ch);
  assert.equal(h.children[0].request.credentialsServer, "https://a.example");
  const next = await h.table.open(h.a, {
    sessionId: SAVED,
    launch: { ...launch, advisor: true },
    replaceAdvisor: true,
  });
  assert.notEqual(next.ch, first.ch);
  assert.equal(h.children.length, 2);
  assert.equal("credentialsServer" in h.children[1].request, false);
});

test("a session-file move keeps the credentials server in the recorded launch", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.a.version = 9;
  h.a.login = { url: "https://a.example", token: "a" };
  const opened = await h.table.open(h.a, {
    sessionId: SAVED,
    launch: { ...launch, shareCredentials: true },
  });
  h.table.release(h.a, opened.ch);
  h.children[0].emit({
    t: "session",
    sessionId: MOVED,
    sessionFile: "/tmp/moved.jsonl",
    cwd: "/tmp",
  });
  h.children[0].emit({ t: "event", event: { type: "agent_start" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    h.table
      .running()
      .map(({ sessionId, launch: recorded }) => [
        sessionId,
        recorded.sessionFile,
        recorded.credentialsServer,
      ]),
    [[MOVED, "/tmp/moved.jsonl", "https://a.example"]],
  );
});

test("a start keeps the configuration version only as 64 hex characters", async (t) => {
  const version = "a".repeat(64);
  for (const [given, kept] of [
    ["x", undefined],
    [version.toUpperCase(), undefined],
    [7, undefined],
    [version, version],
  ]) {
    const h = harness();
    t.after(() => h.table.stop());
    h.a.version = LINK_PROTOCOL_VERSION;
    h.a.login = { url: "https://a.example", token: "a" };
    await h.table.open(h.a, {
      sessionId: SAVED,
      launch: {
        ...launch,
        shareCredentials: true,
        configVersion: given as string,
      },
    });
    assert.equal(h.children[0].request.configVersion, kept);
    assert.equal("configVersion" in h.children[0].request, kept !== undefined);
  }
});

test("an omp that exits during startup logs the last 500 bytes of its stderr to the daemon log only", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.hooks.startup = (child) => {
    child.stderr("x".repeat(600));
    child.stderr("auth broker refused\n");
    child.exit();
  };
  await assert.rejects(h.table.open(h.a, { sessionId: SAVED, launch }), {
    code: "host_process_exited",
  });
  const lines = h.logs.filter((line) => line.includes("exited during startup"));
  assert.equal(lines.length, 1, h.logs.join(" | "));
  assert.ok(
    lines[0].includes(
      JSON.stringify("x".repeat(480) + "auth broker refused\n"),
    ),
    lines[0],
  );
  assert.ok(!lines[0].includes("x".repeat(481)), "at most 500 bytes");
  assert.deepEqual(h.output, [], "nothing goes over the link");
});

test("stderr is dropped once startup settles and never logged on a later exit", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.hooks.startup = (child, request) => {
    child.stderr("early text");
    child.emit({
      t: "hello",
      proto: 1,
      pid: 1,
      sessionId: SAVED,
      sessionFile: request.sessionFile,
      cwd: request.cwd,
    });
  };
  const opened = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, opened.ch);
  h.children[0].stderr("late text");
  h.children[0].exit();
  assert.ok(
    !h.logs.some(
      (line) => line.includes("early text") || line.includes("late text"),
    ),
    h.logs.join(" | "),
  );
});

test("workspace deletion fences descendant starts and stops only its own processes", async () => {
  const h = harness();
  const workspace = {
    ...launch,
    cwd: "/work/project/feature",
    sessionFile: "",
  };
  await h.table.open(h.a, { sessionId: null, launch: workspace });
  await h.table.open(h.a, {
    sessionId: null,
    launch: { ...workspace, cwd: "/work/project/feature/subdir" },
  });
  await h.table.open(h.a, {
    sessionId: null,
    launch: { ...workspace, cwd: "/work/project/feature-other" },
  });
  ev(h.children[0], { type: "agent_start" });
  const release = h.table.fenceWorkspace(workspace.cwd);
  try {
    assert.equal((await h.table.inspectWorkspace(workspace.cwd)).length, 1);
    assert.deepEqual(
      h.children.map((child) => child.kills),
      [[], [false], []],
    );
    await assert.rejects(
      h.table.open(h.b, { sessionId: null, launch: workspace }),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "workspace_deleting",
    );
    await h.table.stopWorkspace(workspace.cwd);
    assert.deepEqual(
      h.children.map((child) => child.kills),
      [[false], [false], []],
    );
    assert.deepEqual(await h.table.inspectWorkspace(workspace.cwd), []);
  } finally {
    release();
  }
  await h.table.open(h.b, { sessionId: null, launch: workspace });
  assert.equal(h.children.length, 4);
  await h.table.stop();
});

test("blocking workspace setup fences new starts but permits joining existing channels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-fence-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const h = harness();
  const workspace = { ...launch, cwd: join(dir, "workspace"), sessionFile: "" };
  const setStage = (stage: string) =>
    writeFileSync(
      join(dir, "hierarchy.json"),
      JSON.stringify({
        projects: [
          {
            workspaces: [
              {
                path: workspace.cwd,
                setup: { status: "running", stage, jobId: "job" },
              },
            ],
          },
        ],
      }),
    );
  try {
    const existing = await h.table.open(h.a, {
      sessionId: SAVED,
      launch: { ...workspace, sessionFile: "/tmp/s.jsonl" },
    });
    setStage("postBlocking");
    await h.table.open(h.b, {
      sessionId: SAVED,
      launch: workspace,
      expectedChannel: existing.ch,
    });
    await assert.rejects(
      h.table.open(h.b, {
        sessionId: null,
        launch: { ...workspace, cwd: join(workspace.cwd, "subdir") },
      }),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "workspace_setup_blocking",
    );
    setStage("postNonBlocking");
    await h.table.open(h.b, { sessionId: null, launch: workspace });
    assert.equal(h.children.length, 2);
  } finally {
    await h.table.stop();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser requests use only the exact live session and never spawn one", async () => {
  const h = harness();
  assert.deepEqual(await h.table.browserCommand(SAVED), { tabs: [] });
  await assert.rejects(h.table.browserCommand(SAVED, "tab-1"), { code: "session_not_running" });
  await assert.rejects(h.table.browserControl(SAVED, { id: "tab-1", actions: [{ type: "reload" }] }), { code: "session_not_running" });
  assert.equal(h.children.length, 0);

  const opened = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, opened.ch);
  const child = h.children[0];
  const listing = h.table.browserCommand(SAVED);
  const listCommand = own(child).at(-1)!;
  assert.equal(listCommand.op, "browser_list");
  assert.deepEqual(listCommand.args, {});
  child.emit({ t: "res", id: listCommand.id, ok: true, data: { tabs: [{ id: "tab-1", title: "Page", url: "https://example.org" }] } });
  assert.deepEqual(await listing, { tabs: [{ id: "tab-1", title: "Page", url: "https://example.org" }] });

  const capture = h.table.browserCommand(SAVED, "tab-1");
  const captureCommand = own(child).at(-1)!;
  assert.equal(captureCommand.op, "browser_capture");
  assert.deepEqual(captureCommand.args, { id: "tab-1" });
  await assert.rejects(h.table.browserCommand(SAVED, "tab-1"), { code: "browser_request_busy" });
  child.emit({ t: "res", id: captureCommand.id, ok: true, data: { mimeType: "image/jpeg", data: "/9j/2Q==" } });
  assert.deepEqual(await capture, { mimeType: "image/jpeg", data: "/9j/2Q==" });
  const controlArgs = { id: "tab-1", actions: [{ type: "reload" as const }] };
  const control = h.table.browserControl(SAVED, controlArgs);
  const controlCommand = own(child).at(-1)!;
  assert.equal(controlCommand.op, "browser_control");
  assert.deepEqual(controlCommand.args, controlArgs);
  child.emit({ t: "res", id: controlCommand.id, ok: true, data: {} });
  assert.deepEqual(await control, {});
  await assert.rejects(h.table.browserControl(MOVED, controlArgs), { code: "session_not_running" });
  assert.deepEqual(await h.table.browserCommand(MOVED), { tabs: [] });
  await h.table.stop();
});
