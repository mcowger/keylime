import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { captureExpectedConsole } from "../../tests/expected-console.ts";
import { fakeRunnerSocket } from "../../tests/fake-runner-socket.ts";
import {
  encodeBlobFrame,
  encodeLine,
  LINK_PROTOCOL_VERSION,
  PartJoiner,
} from "./link-protocol.ts";

const scratch = mkdtempSync(join(os.tmpdir(), "daemon-multi-runtime-"));
const old = {
  agent: process.env.PI_CODING_AGENT_DIR,
  bin: process.env.KEYLIME_OMP_BIN,
};
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const fakeOmp = join(scratch, "omp");
const spawns = join(scratch, "spawns");
const envs = join(scratch, "envs");
const LINK_TOKEN = "link-token-that-must-never-reach-a-child";
// Record host-local configuration and check for link-token leakage without logging secrets.
const source = (
  version: string,
) => `if (process.argv.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(spawns)}, process.pid + "\\n");
fs.appendFileSync(${JSON.stringify(envs)}, JSON.stringify({ localBroker: process.env.OMP_AUTH_BROKER_URL === "https://host-local.example" && process.env.OMP_AUTH_BROKER_TOKEN === "host-local-test-token",
  localAuth: process.env.OPENAI_API_KEY === "host-local-test-key",
  leaked: JSON.stringify([process.env, process.argv]).includes(${JSON.stringify(LINK_TOKEN)}) }) + "\\n");
const file = process.argv[process.argv.indexOf("--resume") + 1];
const id = JSON.parse(fs.readFileSync(file, "utf8").split("\\n")[0]).id;
${fakeRunnerSocket}
const emit = frame => rpcSocket.write(JSON.stringify(frame) + "\\n");
require("node:readline").createInterface({input:rpcSocket}).on("line", line => {
  const command = JSON.parse(line);
  if (command.t === "cmd") emit({t:"res",id:command.id,ok:true,data:{}});
  if (command.t === "cmd" && command.op === "prompt") emit({t:"event",event:{type:"agent_start"}});
});
setImmediate(() => emit({t:"hello",proto:1,pid:process.pid,sessionId:id,sessionFile:file,cwd:process.cwd()}));
`;
// Rewriting the binary changes its fingerprint, so the daemon probes the new version.
function writeFakeOmp(version: string) {
  writeFileSync(fakeOmp, `#!${process.execPath}\n${source(version)}`, {
    mode: 0o755,
  });
}
writeFakeOmp("99.0.0-fake");
process.env.KEYLIME_OMP_BIN = fakeOmp;
const { runHostDaemon } = await import("./daemon.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");
test.after(() => {
  for (const [key, value] of [
    ["PI_CODING_AGENT_DIR", old.agent],
    ["KEYLIME_OMP_BIN", old.bin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => unknown) {
  const end = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("daemon runtime timeout");
    await sleep(10);
  }
}
type HubMessage = {
  type: string;
  id: string;
  on: boolean;
  done: boolean;
  ch: string;
  line: string;
  channels: { sessionId: string }[];
  ok: boolean;
  error: { code: string; message: string; status: number };
  result: {
    ch: string;
    joined: boolean;
    ok: boolean;
    value: { id: string };
  };
};
/** A fake server. `version` is the link protocol it welcomes. */
function hub(
  t: TestContext,
  autoWelcome = true,
  { version = LINK_PROTOCOL_VERSION }: { version?: number } = {},
) {
  const hellos: {
      link: { id: string; notifier: boolean };
      channels: unknown[];
    }[] = [],
    messages: HubMessage[] = [],
    closed: number[] = [],
    joiner = new PartJoiner();
  let socket: Bun.ServerWebSocket<unknown>,
    ack = 0,
    seq = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      return server.upgrade(req)
        ? undefined
        : new Response("", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        if (typeof data !== "string")
          throw new Error("Unexpected binary result");
        for (const line of data.split("\n").filter(Boolean)) {
          const message = JSON.parse(line);
          if (message.type === "hello") {
            socket = ws;
            hellos.push(message);
            if (autoWelcome)
              ws.send(
                encodeLine({ type: "welcome", v: version, hostId: "fixture" }),
              );
          } else if (typeof message.seq === "number") {
            ack = Math.max(ack, message.seq);
            if (message.type === "part") {
              const whole = joiner.add(message);
              if (whole) messages.push(JSON.parse(whole));
            } else messages.push(message);
          }
        }
        ws.send(encodeLine({ type: "ack", ack }));
      },
      close(_ws, code) {
        closed.push(code);
      },
    },
  });
  t.after(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    hellos,
    messages,
    closed,
    send(
      message:
        | { type: "req"; id: string; op: string; args: unknown }
        | { type: "stdin"; ch: string; line: string },
    ) {
      socket.send(encodeLine({ ...message, seq: ++seq }));
    },
    welcome() {
      socket.send(
        encodeLine({ type: "welcome", v: version, hostId: "fixture" }),
      );
    },
    bytes(id: string, text: string) {
      socket.send(encodeBlobFrame(id, Buffer.from(text)));
    },
    close(code: number) {
      socket.close(code);
    },
    result(id: string) {
      return messages.find(
        (message) => message.type === "res" && message.id === id,
      )!;
    },
  };
}

test("configuration reload, source ops/uploads and peer-only deletion preserve other links and one process", async (t) => {
  captureExpectedConsole(
    t,
    "error",
    (message) =>
      typeof message === "string" &&
      message.startsWith("[keylime host] could not reload host.json: ") &&
      message.endsWith("/host.json is not valid host link configuration"),
  );
  const a = hub(t),
    b = hub(t),
    c = hub(t);
  const dir = join(process.env.PI_CODING_AGENT_DIR!, "keylime"),
    root = join(process.env.PI_CODING_AGENT_DIR!, "sessions", "-project");
  mkdirSync(dir, { recursive: true });
  mkdirSync(root, { recursive: true });
  const config = join(dir, "host.json"),
    file = join(root, "2026-11-06_fixture.jsonl"),
    id = "11111111-1111-4111-8111-111111111111";
  const session = () =>
    writeFileSync(
      file,
      [
        {
          type: "session",
          version: 3,
          id,
          cwd: scratch,
          timestamp: "2026-11-06T00:00:00.000Z",
        },
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-11-06T00:00:01.000Z",
          message: { role: "user", content: "hello" },
        },
      ]
        .map((frame) => JSON.stringify(frame))
        .join("\n") + "\n",
    );
  const save = (servers: ReturnType<typeof hub>[]) =>
    writeFileSync(
      config,
      JSON.stringify({
        url: a.url,
        token: "a",
        links: servers.map((server) => ({ url: server.url, token: "token" })),
      }),
    );
  session();
  save([a, b]);
  const daemon = runHostDaemon({ allowHttp: false });
  t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && b.hellos.length === 1);
  assert.notEqual(a.hellos[0].link.id, b.hellos[0].link.id);
  await until(() =>
    a.messages.some((message) => message.type === "notifier" && message.on),
  );
  assert.equal(a.hellos[0].link.notifier, false);
  assert.equal(b.hellos[0].link.notifier, false);
  const launch = {
    cwd: scratch,
    recordedCwd: scratch,
    sessionFile: file,
    advisor: false,
  };
  a.send({
    type: "req",
    id: "open-a",
    op: "open",
    args: { sessionId: id, launch },
  });
  await until(() => a.result("open-a"));
  assert.equal(a.result("open-a").ok, true);
  const firstCh = a.result("open-a").result.ch;
  const changes = (server: ReturnType<typeof hub>) =>
    server.messages.filter((message) => message.type === "sessions_changed")
      .length;
  await until(() => changes(a) > 0 && changes(b) > 0);
  const beforeA = changes(a),
    beforeB = changes(b);
  b.send({
    type: "req",
    id: "rename",
    op: "renameSessionFile",
    args: { id, title: "Shared title", source: "user" },
  });
  await until(
    () => b.result("rename") && changes(a) > beforeA && changes(b) > beforeB,
  );
  assert.equal(b.result("rename").result.ok, true);
  // B has no membership or wrapper: the daemon, not B's live-id snapshot, must stop A's child.
  b.send({
    type: "req",
    id: "delete",
    op: "deleteSession",
    args: { id, liveSessionIds: [] },
  });
  await until(
    () =>
      b.result("delete") &&
      a.messages.some(
        (message) => message.type === "exit" && message.ch === firstCh,
      ),
  );
  assert.equal(b.result("delete").result.ok, true);
  assert.equal(existsSync(file), false);
  assert.equal(
    b.messages.some((message) => message.type === "exit"),
    false,
  );
  session();
  a.send({
    type: "req",
    id: "open-again",
    op: "open",
    args: { sessionId: id, launch },
  });
  await until(() => a.result("open-again"));
  const ch = a.result("open-again").result.ch;
  writeFileSync(config, "{bad");
  await sleep(300);
  a.send({
    type: "req",
    id: "same",
    op: "sessionFileExists",
    args: { path: file },
  });
  b.send({
    type: "req",
    id: "same",
    op: "sessionFileExists",
    args: { path: join(root, "missing.jsonl") },
  });
  await until(() => a.result("same") && b.result("same"));
  assert.equal(a.result("same").result, true);
  assert.equal(b.result("same").result, false);
  const upload = "33333333-3333-4333-8333-333333333333",
    attempt = "44444444-4444-4444-8444-444444444444";
  const args = {
    id: upload,
    attempt,
    name: "file.txt",
    size: 3,
    type: "text/plain",
  };
  a.send({ type: "req", id: "upload", op: "uploadStart", args });
  await until(() => a.result("upload"));
  b.send({
    type: "req",
    id: "collision",
    op: "uploadStart",
    args: { ...args, attempt: "55555555-5555-4555-8555-555555555555" },
  });
  await until(() => b.result("collision"));
  assert.equal(b.result("collision").error.status, 409);
  b.bytes(upload, "bad");
  a.bytes(upload, "yes");
  await until(() =>
    a.messages.some((message) => message.type === "upload_ack" && message.done),
  );
  assert.equal(
    b.messages.some((message) => message.type === "upload_ack"),
    false,
  );
  assert.equal(
    readFileSync(join(dir, "uploads", upload + ".part"), "utf8"),
    "yes",
  );
  save([a, b, c]);
  await until(() => c.hellos.length === 1);
  assert.equal(a.hellos.length, 1);
  assert.equal(b.hellos.length, 1);
  save([a, c]);
  await until(() => b.closed.length > 0);
  assert.equal(a.closed.length, 0);
  assert.equal(c.closed.length, 0);
  a.close(4409);
  await until(() =>
    c.messages.some((message) => message.type === "notifier" && message.on),
  );
  assert.equal(
    daemon.control("status").linked,
    true,
    "ending one link must not hide a still-linked secondary server",
  );
  assert.throws(
    () => daemon.control("drain"),
    { code: "host_busy" },
    "another link's native child still prevents maintenance",
  );
  c.send({
    type: "req",
    id: "join-c",
    op: "open",
    args: { sessionId: id, launch },
  });
  await until(() => c.result("join-c"));
  assert.equal(c.result("join-c").result.ch, ch);
  assert.equal(c.result("join-c").result.joined, true);
  c.send({
    type: "stdin",
    ch,
    line:
      JSON.stringify({ t: "cmd", id: 4242, op: "get_messages", args: {} }) +
      "\n",
  });
  await until(() =>
    c.messages.some(
      (message) =>
        message.type === "stdout" &&
        JSON.parse(message.line).t === "res" &&
        JSON.parse(message.line).id === 4242,
    ),
  );
  assert.equal(
    readFileSync(spawns, "utf8").trim().split("\n").length,
    2,
    "only the explicitly deleted session was respawned",
  );
  c.close(1000);
  assert.equal(await daemon.done, 1);
});

test("a channel created during another link's handshake is announced when that link comes up", async (t) => {
  const a = hub(t),
    b = hub(t, false);
  const dir = join(process.env.PI_CODING_AGENT_DIR!, "keylime");
  const sessions = join(
    process.env.PI_CODING_AGENT_DIR!,
    "sessions",
    "-handshake",
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const id = "77777777-7777-4777-8777-777777777777";
  const file = join(sessions, "handshake.jsonl");
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, cwd: scratch })}\n`,
  );
  writeFileSync(
    join(dir, "host.json"),
    JSON.stringify({
      url: a.url,
      token: "a",
      links: [
        { url: a.url, token: "a" },
        { url: b.url, token: "b" },
      ],
    }),
  );
  const daemon = runHostDaemon({ allowHttp: false });
  t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && b.hellos.length === 1);
  assert.equal(b.hellos[0].channels.length, 0);
  a.send({
    type: "req",
    id: "during-handshake",
    op: "open",
    args: {
      sessionId: id,
      launch: {
        cwd: scratch,
        recordedCwd: scratch,
        sessionFile: file,
        advisor: false,
      },
    },
  });
  await until(() => a.result("during-handshake"));
  assert.equal(a.result("during-handshake").ok, true);
  b.welcome();
  await until(() =>
    b.messages.some(
      (m) =>
        m.type === "channels_changed" &&
        m.channels.some((c) => c.sessionId === id),
    ),
  );
});

test("a removed link stops owning its uploads while an active link keeps exclusion", async (t) => {
  const a = hub(t),
    b = hub(t),
    dir = join(process.env.PI_CODING_AGENT_DIR!, "keylime");
  mkdirSync(dir, { recursive: true });
  const save = (servers: ReturnType<typeof hub>[]) =>
    writeFileSync(
      join(dir, "host.json"),
      JSON.stringify({
        url: a.url,
        token: "a",
        links: servers.map((server) => ({ url: server.url, token: "token" })),
      }),
    );
  save([a, b]);
  const daemon = runHostDaemon({ allowHttp: false });
  t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && b.hellos.length === 1);
  const upload = "66666666-6666-4666-8666-666666666666",
    args = {
      id: upload,
      attempt: "88888888-8888-4888-8888-888888888888",
      name: "file.txt",
      size: 3,
      type: "text/plain",
    };
  b.send({ type: "req", id: "own", op: "uploadStart", args });
  await until(() => b.result("own"));
  assert.equal(b.result("own").ok, true);
  a.send({
    type: "req",
    id: "blocked",
    op: "uploadStart",
    args: { ...args, attempt: "99999999-9999-4999-8999-999999999999" },
  });
  await until(() => a.result("blocked"));
  assert.equal(a.result("blocked").error.status, 409);
  save([a]);
  await until(() => b.closed.length > 0);
  a.send({
    type: "req",
    id: "take",
    op: "uploadStart",
    args: { ...args, attempt: "99999999-9999-4999-8999-999999999999" },
  });
  await until(() => a.result("take"));
  assert.equal(a.result("take").ok, true);
  a.bytes(upload, "yes");
  await until(() =>
    a.messages.some((message) => message.type === "upload_ack" && message.done),
  );
});

test("local maintenance accounts for workspace reads and uploads on every native link", async (t) => {
  const a = hub(t),
    b = hub(t);
  const daemon = runHostDaemon({
    allowHttp: false,
    links: [
      { url: a.url, token: "a" },
      { url: b.url, token: "b" },
    ],
  });
  t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1 && b.hellos.length === 1);
  const file = join(scratch, "maintenance-read.txt");
  writeFileSync(file, "native secondary read");
  const owner = {
    sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    cwd: scratch,
  };
  b.send({
    type: "req",
    id: "read",
    op: "openFile",
    args: { input: { segments: [file], sessionId: owner.sessionId, owner } },
  });
  await until(() => b.result("read"));
  assert.equal(b.result("read").result.ok, true);
  assert.throws(() => daemon.control("drain"), { code: "host_busy" });
  a.send({ type: "req", id: "home-while-read", op: "home", args: {} });
  await until(() => a.result("home-while-read"));
  assert.equal(a.result("home-while-read").result.ok, true);
  b.send({
    type: "req",
    id: "close-read",
    op: "closeFile",
    args: { id: b.result("read").result.value.id },
  });
  await until(() => b.result("close-read"));
  await until(() => {
    try {
      return daemon.control("drain").drained;
    } catch (error) {
      if ((error as { code?: string }).code !== "host_busy") throw error;
      return false;
    }
  });
  a.send({
    type: "req",
    id: "read-drained",
    op: "openFile",
    args: { input: { segments: [file], sessionId: owner.sessionId, owner } },
  });
  await until(() => a.result("read-drained"));
  assert.equal(a.result("read-drained").error.code, "host_drained");
  daemon.control("resume");
  const id = "99999999-9999-4999-8999-999999999990";
  b.send({
    type: "req",
    id: "upload-maintenance",
    op: "uploadStart",
    args: {
      id,
      attempt: "99999999-9999-4999-8999-999999999991",
      name: "native.bin",
      type: "application/octet-stream",
      size: 3,
    },
  });
  await until(() => b.result("upload-maintenance"));
  assert.equal(b.result("upload-maintenance").ok, true);
  assert.throws(() => daemon.control("drain"), { code: "host_busy" });
  b.send({
    type: "req",
    id: "abort-maintenance",
    op: "uploadAbort",
    args: { id },
  });
  await until(() => b.result("abort-maintenance"));
  await until(() => {
    try {
      return daemon.control("drain").drained;
    } catch (error) {
      if ((error as { code?: string }).code !== "host_busy") throw error;
      return false;
    }
  });
  assert.equal(daemon.control("status").linked, true);
  daemon.control("resume");
});

const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    : [];
function sessionFile(name: string, id: string) {
  const dir = join(process.env.PI_CODING_AGENT_DIR!, "sessions", "-local-auth");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name + ".jsonl");
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, cwd: scratch })}\n`,
  );
  return file;
}

function configureHostAuth(t: TestContext): void {
  saveWebServerSettings({
    agentEnv: {
      OPENAI_API_KEY: "host-local-test-key",
      OMP_AUTH_BROKER_URL: "https://host-local.example",
      OMP_AUTH_BROKER_TOKEN: "host-local-test-token",
    },
  });
  t.after(() => saveWebServerSettings({ agentEnv: {} }));
}

const hostAuth = { localBroker: true, localAuth: true, leaked: false };

test("legacy credential fields on an open do not override host-local auth or gate the runner version", async (t) => {
  writeFakeOmp("15.13.0");
  t.after(() => writeFakeOmp("99.0.0-fake"));
  configureHostAuth(t);
  const a = hub(t),
    id = "12121212-1212-4121-8121-121212121212",
    file = sessionFile("old-omp", id);
  const daemon = runHostDaemon({
    allowHttp: false,
    links: [{ url: a.url, token: LINK_TOKEN }],
  });
  t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  const before = lines(envs).length;
  a.send({
    type: "req",
    id: "open",
    op: "open",
    args: {
      sessionId: id,
      launch: {
        cwd: scratch,
        recordedCwd: scratch,
        sessionFile: file,
        advisor: false,
        shareCredentials: true,
        credentialsServer: "https://gone.example",
      },
    },
  });
  await until(() => a.result("open"));
  assert.equal(a.result("open").ok, true);
  assert.deepEqual(
    lines(envs).slice(before).map((line) => JSON.parse(line)),
    [hostAuth],
  );
});

test("a legacy session resumes with host-local auth even when its former credential owner is gone", async (t) => {
  configureHostAuth(t);
  const id = "15151515-1515-4151-8151-151515151515";
  const dir = join(process.env.PI_CODING_AGENT_DIR!, "keylime");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "host-running.json"),
    JSON.stringify([
      {
        sessionId: id,
        launch: {
          cwd: scratch,
          recordedCwd: scratch,
          sessionFile: sessionFile("recovered-gone", id),
          advisor: false,
          credentialsServer: "https://gone.example",
        },
      },
    ]),
  );
  saveWebServerSettings({ autoResumeSessions: true });
  t.after(() => saveWebServerSettings({ autoResumeSessions: false }));
  const before = lines(envs).length;
  const daemon = runHostDaemon({ allowHttp: false, links: [] });
  t.after(() => daemon.stop());
  await daemon.started;
  assert.deepEqual(
    lines(envs).slice(before).map((line) => JSON.parse(line)),
    [hostAuth],
  );
});
