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
import { fakeRunnerSocket } from "../../tests/fake-runner-socket.ts";
import { Value } from "@sinclair/typebox/value";
import { ChatRolesSchema } from "../api-contracts/configuration-models";
import {
  encodeBlobFrame,
  encodeLine,
  LINK_PROTOCOL_VERSION,
  PartJoiner,
} from "./link-protocol.ts";
import { loginHost, removeHostLink } from "./host-login";

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
if (!process.argv.includes("--resume")) {
  const emit = frame => console.log(JSON.stringify(frame));
  require("node:readline").createInterface({input:process.stdin}).on("line", line => {
    const command = JSON.parse(line);
    if (command.t === "cmd" && command.op === "get_chat_roles") {
      const available = process.env.OPENAI_API_KEY === "host-local-test-key";
      emit({t:"res",id:command.id,ok:true,data:{roles:[{id:"default",provider:available ? "host-provider" : null,modelId:available ? "host-model" : null,modelName:available ? "Host model" : null,thinkingLevel:null,effectiveThinkingLevel:null}]}});
    }
  });
  setImmediate(() => emit({t:"hello",proto:1,pid:process.pid,cwd:process.cwd()}));
} else {
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
}
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
const { saveHostSettings } = await import("../web-settings.ts");
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

test("replacing the saved controller retires the old link", async (t) => {
  const a = hub(t),
    b = hub(t);
  await loginHost({ url: a.url, token: LINK_TOKEN });
  const daemon = runHostDaemon({ allowHttp: false });
  t.after(async () => {
    await daemon.stop();
    await removeHostLink(b.url);
  });
  await until(() => daemon.control("status").linked);
  await loginHost({ url: b.url, token: "replacement" });
  await until(
    () =>
      a.closed.length > 0 &&
      b.hellos.length > 0 &&
      daemon.control("status").linked,
  );
  await removeHostLink(b.url);
  await until(() => !daemon.control("status").linked);
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
  const path = join(process.env.PI_CODING_AGENT_DIR!, "keylime-settings.json");
  mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      agentEnv: {
        OPENAI_API_KEY: "host-local-test-key",
        OMP_AUTH_BROKER_URL: "https://host-local.example",
        OMP_AUTH_BROKER_TOKEN: "host-local-test-token",
      },
    }),
  );
  t.after(() => rmSync(path, { force: true }));
}

const hostAuth = { localBroker: true, localAuth: true, leaked: false };

test("workspace role discovery uses the daemon's agent environment", async (t) => {
  configureHostAuth(t);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "inherited-key";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const a = hub(t);
  const daemon = runHostDaemon({ allowHttp: false, url: a.url, token: LINK_TOKEN });
  t.after(() => daemon.stop());
  await until(() => a.hellos.length === 1);
  a.send({ type: "req", id: "roles", op: "chatRolesList", args: { cwd: scratch } });
  await until(() => a.result("roles"));
  const result = a.result("roles");
  assert.equal(result.ok, true);
  assert.ok(Value.Check(ChatRolesSchema, result.result));
  assert.deepEqual(result.result.roles, [{
    id: "default", provider: "host-provider", modelId: "host-model", modelName: "Host model",
    thinkingLevel: null, effectiveThinkingLevel: null,
  }]);
});

test("legacy credential fields on an open do not override host-local auth or gate the runner version", async (t) => {
  writeFakeOmp("15.13.0");
  t.after(() => writeFakeOmp("99.0.0-fake"));
  configureHostAuth(t);
  const a = hub(t),
    id = "12121212-1212-4121-8121-121212121212",
    file = sessionFile("old-omp", id);
  const daemon = runHostDaemon({
    allowHttp: false,
    url: a.url,
    token: LINK_TOKEN,
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
    lines(envs)
      .slice(before)
      .map((line) => JSON.parse(line)),
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
  saveHostSettings({ autoResumeSessions: true });
  t.after(() => saveHostSettings({ autoResumeSessions: false }));
  const before = lines(envs).length;
  const daemon = runHostDaemon({ allowHttp: false });
  t.after(() => daemon.stop());
  await daemon.started;
  assert.deepEqual(
    lines(envs)
      .slice(before)
      .map((line) => JSON.parse(line)),
    [hostAuth],
  );
});
