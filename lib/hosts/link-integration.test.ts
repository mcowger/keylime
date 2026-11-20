import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { POST as startShipRequest } from "../../app/api/ship/route.ts";
import { POST as stopShipRequest } from "../../app/api/ship/monitor/stop/route.ts";
import { insertShipMonitorGrant } from "../message-outbox.ts";
import type { ChildProcess } from "node:child_process";
import { captureExpectedConsole } from "../../tests/expected-console.ts";
import { fakeRunnerSocket } from "../../tests/fake-runner-socket.ts";
import type { AgentEvent } from "../rpc-manager.ts";
import type { LinkSocket, LinkSocketData } from "./hub.ts";
import { LINK_PROTOCOL_VERSION } from "./link-protocol.ts";

type OmpLogEntry = {
  pid: number;
  kind: string;
  sessionId: string;
  line: string;
  n: number;
  hasBrokerEnv?: boolean;
  config?: {
    agentDir: string;
    home: string;
    settings: string | null;
    skill: string | null;
    marker?: string;
    usesHostProviderKey: boolean;
  };
  command?: {
    t?: string;
    op?: string;
    id?: string | number;
    args?: { message?: string };
    isError: boolean;
    result: { content: { text: string }[] };
  };
};
const messageText = (event: AgentEvent) =>
  (event.message as { content: { text: string }[] }).content[0].text;
const transportOf = (session: InstanceType<typeof AgentSessionWrapper>) =>
  (
    session as unknown as {
      proc: {
        transport: {
          ch: string;
          write(data: string, callback: (error?: Error | null) => void): void;
        };
      };
    }
  ).proc.transport;
function host() {
  const result = hub.getHost(hostId);
  assert.ok(result);
  return result;
}

// A real `keylime host` process with its own HOME (a second "machine") linked
// over a loopback WebSocket to the link route and the hub's socket handler, served here through Bun.serve.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const hostBin = join(repoRoot, "bin", "keylime-host.ts");
const scratch = mkdtempSync(join(tmpdir(), "keylime-link-it-"));
const mainAgentDir = join(scratch, "main-agent");
const daemonHome = join(scratch, "laptop");
const daemonAgentDir = join(daemonHome, ".omp", "agent");
const sessionsDir = join(daemonAgentDir, "sessions");
const projectDir = join(daemonHome, "project");
mkdirSync(join(sessionsDir, "-project"), { recursive: true });
mkdirSync(projectDir, { recursive: true });

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousOmpBin = process.env.KEYLIME_OMP_BIN;
process.env.PI_CODING_AGENT_DIR = mainAgentDir;

const linkRoute = await import("../../app/api/hosts/link/route.ts");
const hub = await import("./hub.ts");
const { createHost, revokeHost } = await import("./registry.ts");
const {
  AgentSessionWrapper,
  getRpcSession,
  resumeInterruptedSessions,
  startRpcSession,
} = await import("../rpc-manager.ts");
const { RESUME_PROMPT } = await import("./host-resume.ts");
const { saveWebServerSettings } = await import("../web-settings.ts");
const { closeNotificationStore } = await import("../notification-store.ts");

function writeFakeOmp(file: string, source: string) {
  writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
}

const FRAMES = 200;
// "slow": the first half at once, the rest one by one once the test creates slowGo(sessionId).
const SLOW_HALF = 20;
const SLOW_FRAMES = 80;
const slowGo = (sessionId: string) => join(scratch, `go-${sessionId}`);
// Every omp child appends {pid, kind: "start" | "stdin" | "out" | "pad", ...} here.
const ompLogFile = join(scratch, "omp.log");
const ompLog = (file = ompLogFile): OmpLogEntry[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
/** Whether omp children have sent socket frames containing each of `parts`. */
const ompSaid = (...parts: string[]) => {
  const lines = ompLog()
    .filter((entry) => entry.kind === "out")
    .map((entry) => entry.line);
  return parts.every((part) => lines.some((line) => line.includes(part)));
};
const fakeOmp = join(scratch, "fake-omp");
process.env.KEYLIME_OMP_BIN = fakeOmp;
writeFakeOmp(
  fakeOmp,
  `if (process.argv.includes("--version")) { console.log("15.13.0"); process.exit(0); }
${fakeRunnerSocket}
const fs = require("node:fs");
const path = require("node:path");
const log = (entry) => fs.appendFileSync(process.env.LINK_TEST_LOG_FILE ?? ${JSON.stringify(ompLogFile)}, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
const out = (frame) => {
  const line = JSON.stringify(frame);
  log({ kind: "out", line });
  rpcSocket.write(line + "\\n");
};
const resumeAt = process.argv.indexOf("--resume");
const resumed = resumeAt === -1 ? null : process.argv[resumeAt + 1];
// As omp does, a new session's file is written only once its first assistant message ends.
const sessionId = resumed ? JSON.parse(fs.readFileSync(resumed, "utf8").split("\\n")[0]).id : require("node:crypto").randomUUID();
const sessionRoot = process.env.LINK_TEST_LOG_FILE ? path.join(process.env.PI_CODING_AGENT_DIR, "sessions") : ${JSON.stringify(sessionsDir)};
const sessionFile = resumed ?? path.join(sessionRoot, "-project", sessionId + ".jsonl");
let prompt = null;
let streaming = false;
let text = "";
const update = (next) => {
  text = String(next);
  out({ t: "event", event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } } });
};
const end = () => {
  streaming = false;
  if (!fs.existsSync(sessionFile)) {
    const at = new Date().toISOString();
    const lines = [
      { type: "session", version: 3, id: sessionId, cwd: ${JSON.stringify(projectDir)}, timestamp: at },
      { type: "message", id: "m0", parentId: null, timestamp: at, message: { role: "user", content: prompt } },
      { type: "message", id: "m1", parentId: "m0", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } },
    ];
    fs.writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
  }
  out({ t: "event", event: { type: "agent_end", isTerminal: true, messages: [] } });
};
const configSnapshot = () => {
  const agentDir = process.env.OMP_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
  const home = require("node:os").homedir();
  const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  return {
    agentDir,
    home,
    settings: agentDir ? read(path.join(agentDir, "config.yml")) : null,
    skill: read(path.join(home, ".agents", "skills", "link-test", "SKILL.md")),
    marker: process.env.LINK_TEST_MARKER,
    usesHostProviderKey: process.env.OPENAI_API_KEY === "test-laptop-provider-key",
  };
};
log({ kind: "start", sessionId,
  hasBrokerEnv: process.env.OMP_AUTH_BROKER_URL !== undefined || process.env.OMP_AUTH_BROKER_TOKEN !== undefined,
  config: process.env.LINK_TEST_LOG_FILE ? configSnapshot() : undefined,
});
out({ t: "hello", proto: 1, pid: process.pid, sessionId, sessionFile, cwd: process.cwd() });
require("node:readline").createInterface({ input: rpcSocket }).on("line", (line) => {
  const command = JSON.parse(line);
  // Bulk stdin (the backpressure test): logged without its padding.
  if (command.op === "pad") return log({ kind: "pad", n: command.args.n });
  log({ kind: "stdin", sessionId, command });
  const reply = (data) => out({ t: "res", id: command.id, ok: true, data });
  // A dialog answer and a host tool result are frames: omp sends no res to them.
  if (command.t === "ui_response") {
    update("answered " + command.value.results[0].selectedOptions[0]);
    return end();
  }
  if (command.t === "host_tool_result") {
    update("tool " + command.result.content[0].text);
    return end();
  }
  if (command.t !== "cmd") return;
  if (command.op === "get_state") return reply({ sessionId, sessionFile, isStreaming: streaming, isCompacting: false, supportsClientMessageIds: true, queuedMessages: [] });
  if (command.op === "follow_up") {
    reply({});
    const { message: text, clientMessageId } = command.args;
    const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    out({ t: "event", event: { type: "agent_start" } });
    out({ t: "event", event: { type: "message_start", messageId: "ship-feedback", message, clientMessageId } });
    out({ t: "event", event: { type: "message_end", messageId: "ship-feedback", message, clientMessageId } });
    return end();
  }
  if (command.op !== "prompt") return reply({});
  reply({ agentInvoked: true });
  prompt = command.args.message;
  streaming = true;
  out({ t: "event", event: { type: "agent_start" } });
  if (command.args.message === "ask") return out({ t: "ui_request", id: 1, method: "askDialog", args: [[{ id: "q", question: "Pick", options: [{ label: "A" }] }]] });
  if (command.args.message === "tool") {
    // A host tool call, then one more frame once the test creates the go file.
    out({ t: "host_tool_call", id: "h1", toolCallId: "c1", toolName: "browser_open", arguments: { url: "https://a.test" } });
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(${JSON.stringify(scratch)}, "go-" + sessionId))) return;
      clearInterval(timer);
      update("while stopping");
    }, 25);
    return;
  }
  if (command.args.message === "late") {
    // An ask and an agent tool call, once the test creates the go file.
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(${JSON.stringify(scratch)}, "go-" + sessionId))) return;
      clearInterval(timer);
      out({ t: "ui_request", id: 2, method: "askDialog", args: [[{ id: "q", question: "Late", options: [{ label: "B" }] }]] });
      out({ t: "host_tool_call", id: "h2", toolCallId: "c2", toolName: "send_to_session", arguments: { sessionId: ${JSON.stringify("11111111-2222-4333-8444-000000000001")}, message: "hi" } });
    }, 25);
    return;
  }
  if (command.args.message === "slow") {
    for (let i = 1; i <= ${SLOW_HALF}; i++) update(i);
    let sent = ${SLOW_HALF};
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(${JSON.stringify(scratch)}, "go-" + sessionId))) return;
      update(++sent);
      if (sent === ${SLOW_FRAMES}) {
        clearInterval(timer);
        end();
      }
    }, 25);
    return;
  }
  for (let i = 1; i <= ${FRAMES}; i++) update(i);
  end();
});
`,
);

function writeSession(
  name: string,
  id: string,
  messages: string[],
  cwd = projectDir,
) {
  const lines: object[] = [
    {
      type: "session",
      version: 3,
      id,
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  ];
  let parentId: string | null = null;
  messages.forEach((content, i) => {
    const entryId = `${id}-m${i}`;
    lines.push({
      type: "message",
      id: entryId,
      parentId,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: i % 2 ? [{ type: "text", text: content }] : content,
      },
    });
    parentId = entryId;
  });
  const file = join(sessionsDir, "-project", name);
  writeFileSync(
    file,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  return file;
}
// Session ids are UUIDs; main drops list entries with any other id.
const SMALL_ID = "11111111-2222-4333-8444-000000000001";
const BIG_ID = "11111111-2222-4333-8444-000000000002";
const ASK_ID = "11111111-2222-4333-8444-000000000003";
const TOOL_ID = "11111111-2222-4333-8444-000000000004";
const LATE_ID = "11111111-2222-4333-8444-000000000005";
const smallFile = writeSession("2026-01-01_small.jsonl", SMALL_ID, [
  "hello",
  "hi",
]);
const askFile = writeSession("2026-01-03_ask.jsonl", ASK_ID, [
  "ask me",
  "sure",
]);
const toolFile = writeSession("2026-01-04_tool.jsonl", TOOL_ID, [
  "use a tool",
  "ok",
]);
const lateFile = writeSession("2026-01-05_late.jsonl", LATE_ID, ["late", "ok"]);
writeSession(
  "2026-01-02_big.jsonl",
  BIG_ID,
  Array.from({ length: 200 }, (_, i) => `${i} ${"x".repeat(10_000)}`),
);
assert.ok(
  statSync(join(sessionsDir, "-project", "2026-01-02_big.jsonl")).size >
    2_000_000,
);

// Faults the bridge injects once each, and what it observed.
const faults = {
  loseStdin: false,
  cutUplinkBeforeApply: false,
  cutUplinkAfterApply: false,
  loseShipReceipt: false,
};
// `kills`: the channel of each `kill` main sent down to the daemon; `refusedUpgrades`: link GETs answered 503.
const seen: {
  cuts: string[];
  binaryFrames: number;
  kills: string[];
  refusedUpgrades: number;
} = { cuts: [], binaryFrames: 0, kills: [], refusedUpgrades: 0 };
const shipOffers: { hostId: string; id: string }[] = [];
const shipReceipts: string[] = [];

// The open link sockets, and the one stand-in the hub sees for each (it keys its state on socket identity).
const sockets = new Set<Bun.ServerWebSocket<LinkSocketData>>();
const wrappers = new WeakMap<Bun.ServerWebSocket<LinkSocketData>, LinkSocket>();
/** An open socket whose hello the hub took (Bun runs `close` within terminate(), so a cut socket is already gone). */
const linked = () =>
  sockets.size === 1 && [...sockets].some((ws) => ws.data.hello);
// On while the hub applies a frame whose answer must be lost.
let dropSends = false;

function wrap(ws: Bun.ServerWebSocket<LinkSocketData>): LinkSocket {
  let wrapper = wrappers.get(ws);
  if (wrapper) return wrapper;
  wrapper = {
    data: ws.data,
    send(frame) {
      if (dropSends) return 0;
      if (typeof frame === "string") {
        for (const [, id] of frame.matchAll(
          /"type":"ship_pr_digest_receipt","id":"([^"]+)"/g,
        )) {
          shipReceipts.push(id);
          if (faults.loseShipReceipt) return Buffer.byteLength(frame);
        }
        if (faults.loseStdin && frame.includes('"type":"stdin"')) {
          // The downlink drops with this stdin line still in flight.
          faults.loseStdin = false;
          seen.cuts.push("downlink");
          ws.terminate();
          return 0;
        }
        for (const [, ch] of frame.matchAll(/"type":"kill","ch":"([^"]+)"/g))
          seen.kills.push(ch);
      }
      return ws.send(frame);
    },
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  };
  wrappers.set(ws, wrapper);
  return wrapper;
}

const server: Bun.Server<LinkSocketData> = Bun.serve<LinkSocketData>({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/api/hosts/link": {
      GET(req: Request) {
        const response = linkRoute.GET(req, {
          upgrade: (data) => server.upgrade(req, { data }),
        });
        if (response?.status === 503) seen.refusedUpgrades += 1;
        return response;
      },
      POST: (req: Request) => linkRoute.POST(req),
    },
  },
  websocket: {
    ...hub.hostLinkSocket,
    open(ws) {
      sockets.add(ws);
    },
    message(ws, data) {
      if (typeof data === "string") {
        for (const [, id] of data.matchAll(
          /"type":"ship_pr_digest","id":"([^"]+)"/g,
        ))
          shipOffers.push({ hostId: ws.data.hostId, id });
      }
      const carriesFrames =
        typeof data === "string" && data.includes('"message_update');
      if (faults.cutUplinkBeforeApply && carriesFrames) {
        // The connection breaks before this frame arrives.
        faults.cutUplinkBeforeApply = false;
        seen.cuts.push("uplink-before-apply");
        ws.terminate();
        return;
      }
      if (typeof data !== "string") seen.binaryFrames += 1;
      if (faults.cutUplinkAfterApply && carriesFrames) {
        // Applied, but the ack never reaches the daemon: it must resend.
        faults.cutUplinkAfterApply = false;
        seen.cuts.push("uplink-after-apply");
        // The hub's handlers never throw: it contains a throw by closing that socket.
        dropSends = true;
        hub.hostLinkSocket.message(wrap(ws), data);
        dropSends = false;
        ws.terminate();
        return;
      }
      hub.hostLinkSocket.message(wrap(ws), data);
    },
    drain(ws) {
      hub.hostLinkSocket.drain(wrap(ws));
    },
    close(ws) {
      sockets.delete(ws);
      hub.hostLinkSocket.close(wrap(ws));
    },
  },
});

let hostId: string;
let primaryLogin: { url: string; token: string };
let daemon: ChildProcess;
let daemonLog = "";

/** A restart of the web server as the daemon sees it: the old process runs its shutdown
 * handlers (then `whileStopping`), which close the daemon's link with 1001, then the hub, the
 * sessions and the resume state start over, while the daemon and its omp children run on. */
async function restartWeb({
  whileStopping,
}: { whileStopping?: () => Promise<void> } = {}) {
  // A deploy stops the service: SIGTERM freezes the hub, which closes every link socket.
  process.emit("SIGTERM");
  await whileStopping?.();
  // The frozen hub answers upgrades 503, so no socket opens until the globals reset.
  await waitFor(() => sockets.size === 0, "the frozen hub to close the link");
  for (const link of globalThis.__ompHostHub!.links.values()) {
    clearInterval(link.pingTimer);
    clearTimeout(link.offlineTimer);
  }
  globalThis.__ompHostHub = undefined;
  globalThis.__ompHostLists = undefined;
  globalThis.__ompSessions = undefined;
  globalThis.__ompStartLocks = undefined;
  globalThis.__ompExitedSessions = undefined;
  globalThis.__ompResumeTracker = undefined;
}

function waitFor(predicate: () => unknown, what: string, timeoutMs = 20_000) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${what}\n${daemonLog}`));
      }
    }, 20);
  });
}

before(async () => {
  const url = `http://127.0.0.1:${server.port}`;
  const { host, token } = createHost("Laptop");
  primaryLogin = { url, token };
  hostId = host.id;
  const preload = join(scratch, "ship-test-preload.ts");
  writeFileSync(
    preload,
    `
import { refreshShipPrs } from ${JSON.stringify(pathToFileURL(join(repoRoot, "lib/hosts/workspace-ship.ts")).href)};
import { registerCreatedWorkspace, registerCreatedSession } from ${JSON.stringify(pathToFileURL(join(repoRoot, "lib/hosts/project-hierarchy.ts")).href)};
process.on("message", async ({ requestId, worktree }) => {
  try {
    if (worktree) {
      registerCreatedWorkspace(worktree.project, worktree.path, "feature");
      registerCreatedSession(worktree.path, worktree.sessionId);
    } else {
      await refreshShipPrs();
    }
    process.send({ requestId });
  } catch (error) {
    process.send({ requestId, error: String(error) });
  }
});
`,
  );
  writeFileSync(
    join(scratch, "gh"),
    `#!/bin/sh
case "$1 $2" in
  'pr view') printf '{"state":"OPEN","url":"%s","number":42,"autoMergeRequest":null,"statusCheckRollup":[]}\\n' "$3";;
  'api --hostname') echo '[[]]';;
  *) exit 1;;
esac
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: daemonHome,
    PI_CODING_AGENT_DIR: daemonAgentDir,
    KEYLIME_OMP_BIN: fakeOmp,
    PATH: `${scratch}:${process.env.PATH}`,
    KEYLIME_HOST_SOCKET: join(scratch, "host.sock"),
  };

  const login = spawnSync(process.execPath, [hostBin, "login", "--url", url], {
    env,
    input: `${token}\n`,
    encoding: "utf8",
  });
  assert.equal(login.status, 0, login.stderr);
  const saved = join(daemonAgentDir, "keylime", "host.json");
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(saved, "utf8")), {
    url,
    token,
    links: [{ url, token }],
  });
  assert.ok(!login.stdout.includes(token) && !login.stderr.includes(token));

  daemon = spawn(process.execPath, ["--preload", preload, hostBin], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  daemon.stdout!.on("data", (chunk) => {
    daemonLog += chunk;
  });
  daemon.stderr!.on("data", (chunk) => {
    daemonLog += chunk;
  });
  await waitFor(
    () => hub.getHost(hostId)?.status() === "online",
    "the daemon to link",
  );
  const registration = await hub.getHost(hostId)!.workspaceOps.hierarchy({
    action: "registerProject",
    path: projectDir,
  });
  assert.ok(registration.ok);
  assert.ok(
    registration.value.projects.some((project) =>
      project.workspaces.some(
        (workspace) => workspace.path === realpathSync(projectDir),
      ),
    ),
    "the project directory is a managed workspace for fresh sessions",
  );
});

after(async () => {
  // This run's wrappers only: those of a server restartWeb replaced died with it.
  await Promise.all(
    [...new Set(globalThis.__ompSessions?.values() ?? [])].map((session) =>
      session.destroyAndWait(),
    ),
  );
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((resolve) => daemon.once("exit", resolve));
    daemon.kill("SIGTERM");
    await exited;
  }
  await server.stop(true);
  closeNotificationStore();
  // The hub's held link samples go to this file's agent dir, before it is gone.
  hub.flushLinkSamples();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousOmpBin === undefined) delete process.env.KEYLIME_OMP_BIN;
  else process.env.KEYLIME_OMP_BIN = previousOmpBin;
  rmSync(scratch, { recursive: true, force: true });
});

test("two cold links launch runners with host-local configuration and credentials", async (t) => {
  const root = join(scratch, "cold-start");
  mkdirSync(root, { mode: 0o700 });
  const coldLog = join(root, "omp.log");
  const laptop = join(root, "laptop");
  const laptopAgent = join(laptop, ".omp", "agent");
  const skillDir = join(".agents", "skills", "link-test");
  const skillPath = join(skillDir, "SKILL.md");
  const localSettings = "# Keep these local bytes\ndefaultModel: local-model\n";
  const localWebSettings = `${JSON.stringify({
    agentEnv: {
      LINK_TEST_MARKER: "local",
      OPENAI_API_KEY: "test-laptop-provider-key",
    },
  })}\n`;
  const localSkill = "# Local skill\n";
  mkdirSync(join(laptopAgent, "keylime"), { recursive: true });
  mkdirSync(join(laptopAgent, "sessions", "-project"), { recursive: true });
  mkdirSync(join(laptop, skillDir), { recursive: true });
  writeFileSync(join(laptopAgent, "config.yml"), localSettings);
  const localWebSettingsFile = join(laptopAgent, "keylime-settings.json");
  writeFileSync(localWebSettingsFile, localWebSettings);
  writeFileSync(join(laptop, skillPath), localSkill);

  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children.reverse()) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  const links = await Promise.all(
    ["alpha", "beta"].map(async (marker) => {
      const home = join(root, marker);
      const agentDir = join(home, ".omp", "agent");
      const project = join(laptop, marker);
      mkdirSync(project, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(join(home, skillDir), { recursive: true });
      writeFileSync(
        join(agentDir, "config.yml"),
        `defaultModel: ${marker}-model\n`,
      );
      writeFileSync(join(home, skillPath), `# ${marker} skill\n`);
      const fixture = new URL(
        "./link-integration-server.fixture.ts",
        import.meta.url,
      );
      const web = spawn(
        process.execPath,
        [fileURLToPath(fixture), project, marker],
        {
          env: {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: agentDir,
            OMP_CODING_AGENT_DIR: agentDir,
          },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      children.push(web);
      const signal = AbortSignal.timeout(10_000);
      const [login] = await Promise.race([
        once(web, "message", { signal }) as Promise<[{ url: string; token: string }]>,
        once(web, "exit", { signal }).then(([code]) => {
          throw new Error(`${marker} fixture exited before startup: ${code}`);
        }),
      ]);
      return { marker, login };
    }),
  );
  // Neither server fixture serves broker or mirror endpoints.
  writeFileSync(
    join(laptopAgent, "keylime", "host.json"),
    JSON.stringify({ ...links[0].login, links: links.map(({ login }) => login) }),
    { mode: 0o600 },
  );
  const daemonEnv = { ...process.env };
  delete daemonEnv.OMP_AUTH_BROKER_URL;
  delete daemonEnv.OMP_AUTH_BROKER_TOKEN;
  const coldDaemon = spawn(process.execPath, [hostBin], {
    env: {
      ...daemonEnv,
      HOME: laptop,
      PI_CODING_AGENT_DIR: laptopAgent,
      OMP_CODING_AGENT_DIR: laptopAgent,
      KEYLIME_HOST_SOCKET: join(root, "host.sock"),
      LINK_TEST_LOG_FILE: coldLog,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(coldDaemon);

  await Promise.all(
    links.map(async ({ marker, login }) => {
      const launch = await fetch(`${login.url}/launch`, {
        method: "POST",
        signal: AbortSignal.timeout(4_000),
      });
      const body = await launch.text();
      assert.ok(launch.ok, `${marker} launch: ${body}`);
      const { sessionId } = JSON.parse(body) as { sessionId: string };
      const entry = ompLog(coldLog).find(
        (entry) => entry.kind === "start" && entry.sessionId === sessionId,
      );
      assert.ok(
        entry?.config,
        `${marker} runner recorded its config before hello`,
      );
      assert.equal(entry.hasBrokerEnv, false);
      assert.deepEqual(entry.config, {
        agentDir: laptopAgent,
        home: laptop,
        settings: localSettings,
        skill: localSkill,
        marker: "local",
        usesHostProviderKey: true,
      });

      const response = await fetch(`${login.url}/api/hosts`);
      assert.equal(response.status, 200);
      const snapshot = (await response.json()) as {
        hosts: { label: string }[];
      };
      assert.equal("masterConfigError" in snapshot, false);
      assert.ok(snapshot.hosts.some((row) => row.label === marker));
      for (const row of snapshot.hosts)
        assert.equal("clusterConfig" in row, false);
    }),
  );
  assert.equal(readFileSync(join(laptopAgent, "config.yml"), "utf8"), localSettings);
  assert.equal(readFileSync(localWebSettingsFile, "utf8"), localWebSettings);
  assert.equal(readFileSync(join(laptop, skillPath), "utf8"), localSkill);
});

test("the linked host reports itself and lists its sessions", async () => {
  const listed = hub.listHosts().find((h) => h.id === hostId);
  assert.ok(listed);
  assert.equal(listed.status, "online");
  assert.equal(listed.ompVersion, "15.13.0");
  assert.equal(listed.platform, process.platform);
  const ids = (await host().sessionOps.listSessions()).map((s) => s.id);
  assert.ok(ids.includes(SMALL_ID) && ids.includes(BIG_ID), ids.join(","));
});

test("a 2 MB session read arrives in binary frames of one piece each", async () => {
  const before = seen.binaryFrames;
  const result = await host().sessionOps.readSession(BIG_ID, {
    deferThinking: true,
    deferMedia: true,
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok("info" in result.value);
  assert.equal(result.value.info.id, BIG_ID);
  assert.equal(result.value.context.messages.length, 200);
  // 256 KiB pieces: about eight frames.
  assert.ok(
    seen.binaryFrames - before >= 4,
    `${seen.binaryFrames - before} frames`,
  );
});

test("the host refuses session paths outside its sessions directory", async () => {
  const remote = host();
  assert.equal(await remote.sessionFileExists(smallFile), true);
  assert.equal(
    await remote.sessionFileExists(
      join(sessionsDir, "-project", "not-yet.jsonl"),
    ),
    false,
  );
  const outside = join(scratch, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.jsonl"), "{}\n");
  symlinkSync(outside, join(sessionsDir, "escape"));
  // `${sessionsDir}-evil` shares the sessions directory's name as a prefix.
  mkdirSync(`${sessionsDir}-evil`);
  writeFileSync(join(`${sessionsDir}-evil`, "x.jsonl"), "{}\n");
  for (const path of [
    "/etc/passwd",
    join(sessionsDir, "..", "keylime", "host.json"),
    join(sessionsDir, "escape", "secret.jsonl"),
    join(`${sessionsDir}-evil`, "x.jsonl"),
    "relative.jsonl",
  ]) {
    await assert.rejects(
      remote.sessionFileExists(path),
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 403,
      path,
    );
  }
  await assert.rejects(
    remote.spawnRpc({
      cwd: projectDir,
      recordedCwd: projectDir,
      sessionFile: join(sessionsDir, "escape", "secret.jsonl"),
      advisor: false,
    }),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 403,
  );
});

/** The new session the streaming test starts; it stays live, idle, on the daemon. */
let countSessionId: string;

test("a remote session streams a reply with no frame lost or duplicated across link breaks", async (t) => {
  let sessionId: string | undefined;
  captureExpectedConsole(
    t,
    "warn",
    (message) =>
      sessionId !== undefined &&
      message ===
        `[keylime] could not title session ${sessionId}: Laptop is offline`,
  );
  const remote = host();
  const { session, realSessionId } = await startRpcSession(
    "",
    "",
    projectDir,
    undefined,
    false,
    null,
    undefined,
    remote,
  );
  sessionId = realSessionId;
  countSessionId = realSessionId;
  assert.equal(session.host, remote);
  assert.ok(
    ompLog().some(
      (entry) => entry.kind === "start" && entry.sessionId === realSessionId,
    ),
  );
  const texts: number[] = [];
  let ended = false;
  session.onEvent((event) => {
    if (event.type === "message_update") texts.push(Number(messageText(event)));
    if (event.type === "agent_end") ended = true;
  });
  faults.loseStdin = true;
  faults.cutUplinkBeforeApply = true;
  faults.cutUplinkAfterApply = true;
  await session.send({ type: "prompt", message: "count" });
  await waitFor(() => ended, "agent_end");
  assert.deepEqual(seen.cuts, [
    "downlink",
    "uplink-before-apply",
    "uplink-after-apply",
  ]);
  assert.deepEqual(
    texts,
    Array.from({ length: FRAMES }, (_, i) => i + 1),
  );
  // The last cut can end the socket that brought agent_end; until the daemon redials, ops fail host_offline.
  await waitFor(linked, "the daemon to relink");
  assert.equal(
    getRpcSession(realSessionId),
    session,
    "the shared channel stays open after relinking",
  );
});

test("a restarted web server adopts its running omp children, resumed or new: each pid streams on with no gap or duplicate, no kill reaches the daemon, nothing resumes them", async (t) => {
  saveWebServerSettings({ autoResumeSessions: true });
  const adopt = AgentSessionWrapper.prototype.adopt;
  t.after(() => {
    AgentSessionWrapper.prototype.adopt = adopt;
    saveWebServerSettings({ autoResumeSessions: false });
  });
  const remote = host();
  // A resumed session, and a new one (no --resume) in its first reply: it names itself only in
  // its hello, and no session list has it until that reply ends and omp writes its file.
  const runs = [
    await startRpcSession(
      SMALL_ID,
      smallFile,
      projectDir,
      undefined,
      false,
      projectDir,
      undefined,
      remote,
    ),
    await startRpcSession(
      "",
      "",
      projectDir,
      undefined,
      false,
      null,
      undefined,
      remote,
    ),
  ].map(({ session, realSessionId }) => ({
    session,
    id: realSessionId,
    texts: [] as number[],
  }));
  for (const run of runs) {
    run.session.onEvent((event) => {
      if (event.type === "message_update")
        run.texts.push(Number(messageText(event)));
    });
    await run.session.send({ type: "prompt", message: "slow" });
  }
  await waitFor(
    () => runs.every((run) => run.texts.length === SLOW_HALF),
    "the first half of each run",
  );
  // A shared host's daemon owns the runs' lifecycle: the web server records none of them for its own resume.
  const interrupted = join(
    mainAgentDir,
    `keylime-interrupted-sessions-${process.pid}.json`,
  );
  assert.equal(
    existsSync(interrupted),
    false,
    "the web server records no run of a lifecycle-owning host",
  );
  const newSessionFile = join(sessionsDir, "-project", `${runs[1].id}.jsonl`);
  assert.equal(
    existsSync(newSessionFile),
    false,
    "the new session has no file yet",
  );
  // Live on the daemon too: the earlier test's idle new session.
  const ids = [...runs.map((run) => run.id), countSessionId];
  const killsBefore = seen.kills.length;

  // Watch each next wrapper from its first frame: frames held across the restart are applied during adopt().
  const adopted = new Map<
    InstanceType<typeof AgentSessionWrapper>,
    AgentEvent[]
  >();
  AgentSessionWrapper.prototype.adopt = function (replay) {
    const events: AgentEvent[] = [];
    this.onEvent((event) => events.push(event), { internal: true });
    adopted.set(this, events);
    return adopt.call(this, replay);
  };
  await restartWeb();
  // As instrumentation does when the new server starts.
  await resumeInterruptedSessions();
  for (const run of runs) writeFileSync(slowGo(run.id), "");
  await waitFor(() => ids.every((id) => getRpcSession(id)), "the adoptions");
  for (const run of runs) {
    const events = adopted.get(getRpcSession(run.id)!);
    assert.ok(events);
    await waitFor(
      () => events.some((event) => event.type === "agent_end"),
      "the run to end",
    );
    for (const event of events)
      if (event.type === "message_update")
        run.texts.push(Number(messageText(event)));
    assert.deepEqual(
      run.texts,
      Array.from({ length: SLOW_FRAMES }, (_, i) => i + 1),
      run.id,
    );
  }
  assert.deepEqual(
    seen.kills.slice(killsBefore),
    [],
    "no kill reached the daemon",
  );
  // The first reply completed in the adopted child, which then wrote the session.
  assert.equal(
    JSON.parse(readFileSync(newSessionFile, "utf8").split("\n")[0]).id,
    runs[1].id,
  );

  const log = ompLog();
  for (const id of ids) {
    const starts = log.filter(
      (entry) => entry.kind === "start" && entry.sessionId === id,
    );
    assert.equal(starts.length, 1, `no second child was spawned for ${id}`);
    // The daemon subscribes once when it starts the child; an adopting server joins it and never subscribes again.
    const handshakes = log.filter(
      (entry) =>
        entry.pid === starts[0].pid &&
        entry.command?.op === "set_subagent_subscription",
    );
    assert.equal(
      handshakes.length,
      1,
      `the daemon alone set up the same child of ${id}`,
    );
  }
  assert.equal(
    log.some((entry) => entry.command?.args?.message === RESUME_PROMPT),
    false,
    "no resume prompt",
  );
});

test("a run waiting on an ask shows the dialog again after a web restart, and the answer reaches the same omp child", async () => {
  const { session } = await startRpcSession(
    ASK_ID,
    askFile,
    projectDir,
    undefined,
    false,
    projectDir,
    undefined,
    host(),
  );
  let asked = false;
  session.onEvent((event) => {
    if (event.type === "ui_request" && event.id === 1) asked = true;
  });
  await session.send({ type: "prompt", message: "ask" });
  await waitFor(() => asked, "the ask");

  const killsBefore = seen.kills.length;
  await restartWeb();
  await waitFor(() => getRpcSession(ASK_ID), "the adoption");
  // A tab opening the session after the restart.
  const events: AgentEvent[] = [];
  const adopted = getRpcSession(ASK_ID);
  assert.ok(adopted);
  adopted.onEvent((event) => events.push(event));
  assert.equal(
    events.find((event) => event.type === "ui_request" && event.id === 1)
      ?.method,
    "askDialog",
  );
  await adopted.send({
    type: "ui_response",
    id: 1,
    value: {
      kind: "submit",
      results: [
        {
          id: "q",
          question: "Pick",
          options: ["A"],
          multi: false,
          selectedOptions: ["A"],
        },
      ],
    },
  });
  await waitFor(
    () => events.some((event) => event.type === "agent_end"),
    "the answered run to end",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "message_update" && messageText(event) === "answered A",
    ),
  );

  const log = ompLog();
  const starts = log.filter(
    (entry) => entry.kind === "start" && entry.sessionId === ASK_ID,
  );
  assert.equal(starts.length, 1, "no second child was spawned");
  assert.ok(
    log.some(
      (entry) =>
        entry.pid === starts[0].pid &&
        entry.command?.t === "ui_response" &&
        entry.command.id === 1,
    ),
  );
  assert.deepEqual(
    seen.kills
      .slice(killsBefore)
      .filter((ch) => ch === transportOf(getRpcSession(ASK_ID)!).ch),
    [],
    "no kill reached the asking child",
  );
});

test("a stopping web server sends nothing more and takes nothing in: a closing tab rejects no host tool call, and output waits for the next server", async (t) => {
  const adopt = AgentSessionWrapper.prototype.adopt;
  t.after(() => {
    AgentSessionWrapper.prototype.adopt = adopt;
  });
  const { session } = await startRpcSession(
    TOOL_ID,
    toolFile,
    projectDir,
    undefined,
    false,
    projectDir,
    undefined,
    host(),
  );
  await session.send({
    type: "set_host_tools",
    tools: [
      {
        name: "browser_open",
        description: "Open a page",
        parameters: { type: "object" },
      },
    ],
  });
  const before: AgentEvent[] = [];
  const leave = session.onEvent((event) => before.push(event));
  await session.send({ type: "prompt", message: "tool" });
  await waitFor(
    () =>
      before.some(
        (event) => event.type === "host_tool_call" && event.id === "h1",
      ),
    "the host tool call",
  );

  const adopted = new Map<
    InstanceType<typeof AgentSessionWrapper>,
    AgentEvent[]
  >();
  AgentSessionWrapper.prototype.adopt = function (replay) {
    const events: AgentEvent[] = [];
    this.onEvent((event) => events.push(event), { internal: true });
    adopted.set(this, events);
    return adopt.call(this, replay);
  };
  const refusedBefore = seen.refusedUpgrades;
  await restartWeb({
    async whileStopping() {
      // The tab's connection closes with the server: a live server answers its open call with an error.
      leave();
      // omp sends more output while the server stops.
      writeFileSync(slowGo(TOOL_ID), "");
      await waitFor(
        () => ompSaid("while stopping") && seen.refusedUpgrades > refusedBefore,
        "output while stopping, and a redial refused",
      );
    },
  });
  assert.equal(
    ompLog().some((entry) => entry.command?.t === "host_tool_result"),
    false,
    "no rejection reached omp",
  );
  assert.equal(
    before.some((event) => event.type === "message_update"),
    false,
    "the stopping server applied none of it",
  );

  await waitFor(() => getRpcSession(TOOL_ID), "the adoption");
  const next = getRpcSession(TOOL_ID);
  assert.ok(next);
  const events = adopted.get(next);
  assert.ok(events);
  const stopping = () =>
    events.filter(
      (event) =>
        event.type === "message_update" &&
        messageText(event) === "while stopping",
    );
  await waitFor(
    () => stopping().length > 0,
    "the refused output to reach the next server",
  );
  // A shared host never reopens the call for a tab: the adopting server settles it as an unknown outcome, once.
  const tab: AgentEvent[] = [];
  next.onEvent((event) => tab.push(event));
  assert.equal(
    tab.some((event) => event.type === "host_tool_call"),
    false,
    "a replayed call is not reopened",
  );
  await waitFor(
    () => events.some((event) => event.type === "agent_end"),
    "the run to end",
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "message_update" &&
        /outcome is unknown/.test(messageText(event)),
    ),
  );
  assert.equal(stopping().length, 1, "delivered once");
  const results = ompLog()
    .filter((entry) => entry.command?.t === "host_tool_result")
    .map((entry) => entry.command);
  assert.equal(results.length, 1);
  assert.ok(results[0]);
  assert.equal(results[0].id, "h1");
  assert.equal(results[0].isError, true);
  assert.match(results[0].result.content[0].text, /outcome is unknown/);
});

test("a request omp opens while the web server stops reaches the next server once: one dialog, one agent tool result", async (t) => {
  const adopt = AgentSessionWrapper.prototype.adopt;
  // A shared host routes an agent tool call only to a server that registered the tool.
  saveWebServerSettings({ agentToolsEnabled: true });
  t.after(() => {
    AgentSessionWrapper.prototype.adopt = adopt;
    saveWebServerSettings({ agentToolsEnabled: false });
  });
  const { session } = await startRpcSession(
    LATE_ID,
    lateFile,
    projectDir,
    undefined,
    false,
    projectDir,
    undefined,
    host(),
  );
  let started = false;
  session.onEvent((event) => {
    if (event.type === "agent_start") started = true;
  });
  await session.send({ type: "prompt", message: "late" });
  await waitFor(() => started, "the run");

  const adopted = new Map<
    InstanceType<typeof AgentSessionWrapper>,
    AgentEvent[]
  >();
  AgentSessionWrapper.prototype.adopt = function (replay) {
    const events: AgentEvent[] = [];
    this.onEvent((event) => events.push(event), { internal: true });
    adopted.set(this, events);
    return adopt.call(this, replay);
  };
  const refusedBefore = seen.refusedUpgrades;
  await restartWeb({
    async whileStopping() {
      writeFileSync(slowGo(LATE_ID), "");
      // The stopping server takes neither line in: the daemon keeps both for the next server.
      await waitFor(
        () =>
          ompSaid('"id":2,"method":"askDialog"', "send_to_session") &&
          seen.refusedUpgrades > refusedBefore,
        "both requests sent while stopping, and a redial refused",
      );
    },
  });

  await waitFor(() => getRpcSession(LATE_ID), "the adoption");
  const events = adopted.get(getRpcSession(LATE_ID)!);
  assert.ok(events);
  const results = () =>
    ompLog().filter(
      (entry) =>
        entry.command?.t === "host_tool_result" && entry.command.id === "h2",
    );
  await waitFor(() => results().length > 0, "the agent tool result");
  // Room for a second delivery to show up.
  await sleep(300);
  assert.equal(
    events.filter((event) => event.type === "ui_request" && event.id === 2)
      .length,
    1,
    "one dialog",
  );
  assert.equal(results().length, 1, "one agent tool result");
});

test("a daemon that stops reading is paced, not closed: the hub sends its outbox as the socket drains, and each line reaches omp once", async () => {
  const { session } = await startRpcSession(
    "",
    "",
    projectDir,
    undefined,
    false,
    null,
    undefined,
    host(),
  );
  assert.equal(sockets.size, 1);
  const [socket] = sockets;
  // 48 MiB of stdin: three times the hub's 16 MiB backpressure limit.
  const count = 8;
  const pad = "x".repeat(6 * 1024 * 1024);
  daemon.kill("SIGSTOP");
  try {
    for (let n = 1; n <= count; n++)
      transportOf(session).write(
        `${JSON.stringify({ t: "cmd", id: n, op: "pad", args: { n, pad } })}\n`,
        assert.ifError,
      );
    // Room for a close at the limit to show up.
    await sleep(300);
    assert.deepEqual(
      [...sockets],
      [socket],
      "the socket stays open while the daemon reads nothing",
    );
  } finally {
    daemon.kill("SIGCONT");
  }
  const pads = () =>
    ompLog()
      .filter((entry) => entry.kind === "pad")
      .map((entry) => entry.n);
  await waitFor(() => pads().length >= count, "every line to reach omp");
  // Room for a second delivery to show up.
  await sleep(300);
  assert.deepEqual(
    pads(),
    Array.from({ length: count }, (_, i) => i + 1),
  );
  assert.deepEqual([...sockets], [socket], "no redial");
});

async function shipTestTick(worktree?: {
  project: string;
  path: string;
  sessionId: string;
}) {
  const requestId = randomUUID();
  let reply: { requestId: string; error?: string } | undefined;
  const received = (message: typeof reply) => {
    if (message?.requestId === requestId) reply = message;
  };
  daemon.on("message", received);
  try {
    daemon.send({ requestId, worktree });
    await waitFor(() => reply, "daemon's Ship tick to finish");
    assert.equal(reply?.error, undefined);
  } finally {
    daemon.off("message", received);
  }
}

test("Ship offers only to its initiating server, retries a lost receipt, and never retargets to a replacement token", async (t) => {
  const id = randomUUID(),
    sessionId = randomUUID();
  const project = realpathSync(daemonHome) + "/ship-repo";
  const path = realpathSync(daemonHome) + "/ship-worktree";
  execFileSync("git", ["init", "-q", project]);
  execFileSync("git", [
    "-C",
    project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "base",
  ]);
  execFileSync("git", [
    "-C",
    project,
    "worktree",
    "add",
    "-qb",
    "feature",
    path,
  ]);
  const registration = await host().workspaceOps.hierarchy({
    action: "registerProject",
    path: project,
  });
  assert.ok(registration.ok);
  writeSession("2026-02-01_ship.jsonl", sessionId, ["ship context"], path);
  host().invalidateSessionLists();
  await shipTestTick({ project, path, sessionId });

  type PeerData = { token: string };
  let peer: Bun.ServerWebSocket<PeerData> | undefined;
  let peerAck = 0,
    peerInvalidations = 0;
  const peerOffers: unknown[] = [];
  const other = Bun.serve<PeerData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (req.headers.get("authorization") !== "Bearer other-token")
        return new Response(null, { status: 401 });
      if (server.upgrade(req, { data: { token: "other-token" } })) return;
      return new Response(null, { status: 426 });
    },
    websocket: {
      message(ws, data) {
        assert.equal(typeof data, "string");
        for (const line of String(data).split("\n").filter(Boolean)) {
          const frame = JSON.parse(line);
          if (frame.type === "hello") {
            peer = ws;
            ws.send(
              JSON.stringify({
                type: "welcome",
                v: LINK_PROTOCOL_VERSION,
                hostId: "peer",
              }),
            );
          } else if (frame.type === "ack") {
            peerAck = frame.ack;
          } else if (frame.seq !== undefined) {
            if (frame.type === "ship_pr_digest") peerOffers.push(frame);
            if (frame.type === "sessions_changed") peerInvalidations++;
            ws.send(JSON.stringify({ type: "ack", ack: frame.seq }));
          }
        }
      },
    },
  });
  const loginFile = join(daemonAgentDir, "keylime", "host.json");
  const secondary = {
    url: `http://127.0.0.1:${other.port}`,
    token: "other-token",
  };
  const configure = (primary = primaryLogin, withPeer = true) =>
    writeFileSync(
      loginFile,
      JSON.stringify({
        ...primary,
        links: withPeer ? [primary, secondary] : [primary],
      }),
    );
  const replacement = createHost("Replacement token");
  t.after(() => {
    faults.loseShipReceipt = false;
    configure(primaryLogin, false);
    other.stop(true);
    revokeHost(replacement.host.id);
  });
  configure();
  await waitFor(() => peer, "second configured server to link");

  const prFile = join(daemonAgentDir, "keylime", "ship", "prs.json");
  mkdirSync(join(prFile, ".."), { recursive: true });
  const url = "https://github.com/test/repo/pull/42";
  const monitorId = randomUUID();
  insertShipMonitorGrant({
    monitorId,
    hostId,
    credential: createHash("sha256").update(primaryLogin.token).digest("hex"),
    sessionId,
    projectPath: project,
    path,
  });
  const feedback = [
    { kind: "conversation", id: 123 },
    { kind: "inline", id: 234 },
    { kind: "review", id: 345 },
  ];
  const owner = createHash("sha256")
    .update(
      JSON.stringify([
        "keylime-ship-server-v1",
        primaryLogin.url,
        primaryLogin.token,
      ]),
    )
    .digest("hex");
  const record = {
    projectPath: project,
    path,
    base: "main",
    generation: randomUUID(),
    pr: { url, number: 42, state: "open", cleanup: false },
    monitor: {
      id: monitorId,
      owner,
      sessionId,
      requestedAt: Date.now(),
      seen: [],
      pending: [
        {
          id,
          monitorId,
          sessionId,
          prUrl: url,
          feedback,
          omitted: 0,
          createdAt: Date.now(),
        },
      ],
    },
  };
  const monitor = () => JSON.parse(readFileSync(prFile, "utf8"))[path].monitor;
  writeFileSync(prFile, JSON.stringify({ [path]: record }));

  const poll = async () => {
    const previous = peerInvalidations;
    await shipTestTick();
    await waitFor(
      () => peerInvalidations > previous,
      "invalidation on the second server after the poll",
    );
    assert.deepEqual(
      peerOffers,
      [],
      "list invalidations are shared, not the digest",
    );
  };
  faults.loseShipReceipt = true;
  await poll();
  await waitFor(
    () => shipReceipts.includes(id),
    "durable application receipt generated (but lost)",
  );
  assert.deepEqual(
    shipOffers.filter((offer) => offer.id === id),
    [{ hostId, id }],
  );
  const database = new Database(join(mainAgentDir, "keylime", "outbox.db"), {
    readonly: true,
  });
  t.after(() => database.close());
  const entry = () =>
    database
      .query(
        "SELECT source_host_id, mode, state, error FROM entries WHERE id = ?",
      )
      .get(id) as {
      source_host_id: string;
      mode: string;
      state: string;
      error: string | null;
    } | null;
  await waitFor(
    () => ["delivered", "failed"].includes(entry()?.state ?? ""),
    "the single digest outbox handoff to finish",
  );
  assert.deepEqual(entry(), {
    source_host_id: hostId,
    mode: "followUp",
    state: "delivered",
    error: null,
  });
  assert.equal(
    monitor().pending[0].id,
    id,
    "transport acknowledgement does not retire the digest",
  );
  peer!.send(JSON.stringify({ type: "ship_pr_digest_receipt", seq: 1, id }));
  await waitFor(
    () => peerAck >= 1,
    "transport ACK for a receipt offered by the wrong owner",
  );
  assert.equal(monitor().pending[0].id, id);

  configure({ url: primaryLogin.url, token: replacement.token });
  await waitFor(
    () => hub.getHost(replacement.host.id)?.status() === "online",
    "replacement token on same URL to link",
  );
  await poll();
  assert.deepEqual(
    shipOffers.filter((offer) => offer.id === id),
    [{ hostId, id }],
  );
  assert.equal(monitor().pending[0].id, id);

  // Reset the receiving hub so its original downlink receipt is not replayed; the new receipt must follow the retry.
  await restartWeb({ whileStopping: async () => configure() });
  await waitFor(
    () => hub.getHost(hostId)?.status() === "online",
    "original authenticated owner to reconnect",
  );
  faults.loseShipReceipt = false;
  await poll();
  await waitFor(
    () => monitor()?.pending.length === 0,
    "new durable receipt for the same digest ID",
  );
  assert.deepEqual(
    shipOffers.filter((offer) => offer.id === id),
    [
      { hostId, id },
      { hostId, id },
    ],
  );
  const delivered = ompLog().flatMap((event) => {
    const text = event.command?.args?.message;
    return event.sessionId === sessionId &&
      text?.includes(`${url}#issuecomment-123`)
      ? [text]
      : [];
  });
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0].includes(`${url}#discussion_r234`));
  assert.ok(delivered[0].includes(`${url}#pullrequestreview-345`));

  const archived = await host().sessionOps.archiveSession(sessionId);
  assert.ok(archived.ok);
  assert.equal(
    monitor(),
    undefined,
    "successful archive removes the watch immediately",
  );
});

test("Ship digest admission requires a server grant and never falls back to another host", async (t) => {
  const { host: source, token } = createHost("Host without the session");
  const sessionId = randomUUID();
  writeSession(`2026-02-02_${sessionId}.jsonl`, sessionId, [
    "other host context",
  ]);
  host().invalidateSessionLists();
  assert.ok(
    (await host().sessionOps.listSessions()).some(({ id }) => id === sessionId),
  );
  let socket: LinkSocket | undefined;
  let up = 0;
  let ack = 0;
  let monitorId: string | undefined;
  const statusRequests: unknown[] = [];
  const receipts: string[] = [];
  const prUrl = "https://github.com/test/repo/pull/42";
  const workspace = { projectPath: "/test/repo", path: "/test/work" };
  const jobId = randomUUID();
  const sendUp = (frame: object) =>
    hub.hostLinkSocket.message(socket!, JSON.stringify(frame));
  const request = new Request(`${primaryLogin.url}/api/hosts/link`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(
    linkRoute.GET(request, {
      upgrade(data) {
        socket = {
          data,
          send(message) {
            for (const line of String(message).split("\n").filter(Boolean)) {
              const frame = JSON.parse(line);
              if (frame.type === "ack") ack = frame.ack;
              if (frame.type === "ship_pr_digest_receipt")
                receipts.push(frame.id);
              if (frame.type !== "req") continue;
              let result: unknown;
              if (frame.op === "listSessions") result = [];
              else if (frame.op === "startShip") {
                monitorId = frame.args.input.monitorGrantId;
                result = {
                  ok: true,
                  value: {
                    id: jobId,
                    kind: "ship",
                    ...workspace,
                    mode: "pr",
                    status: "running",
                    steps: [],
                    logs: "",
                  },
                };
              } else if (frame.op === "shipMonitorStatus") {
                statusRequests.push(frame.args.input);
                result = { ok: true, value: { watch: { sessionId, prUrl } } };
              } else if (frame.op === "stopShipMonitor") {
                result = { ok: true, value: { stopped: true } };
              } else continue;
              queueMicrotask(() =>
                sendUp({
                  type: "res",
                  seq: ++up,
                  id: frame.id,
                  ok: true,
                  result,
                }),
              );
            }
            return Buffer.byteLength(String(message));
          },
          close: () => hub.hostLinkSocket.close(socket!),
          terminate: () => hub.hostLinkSocket.close(socket!),
        };
        return true;
      },
    }),
    undefined,
  );
  t.after(() => {
    socket?.close();
    revokeHost(source.id);
  });
  sendUp({
    type: "hello",
    v: LINK_PROTOCOL_VERSION,
    ompVersion: "fake",
    home: "/tmp",
    platform: process.platform,
    autoApproveExtension: false,
    ack: 0,
    channels: [],
    workspaceOps: ["startShip", "shipMonitorStatus", "stopShipMonitor"],
  });
  const requestBody = (url: string, body: object) =>
    new Request(`${primaryLogin.url}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const clientChosenId = randomUUID();
  const accepted = await startShipRequest(
    requestBody("/api/ship", {
      host: source.id,
      input: {
        ...workspace,
        mode: "pr",
        rebase: false,
        cleanup: false,
        monitorSessionId: sessionId,
        monitorGrantId: clientChosenId,
      },
    }),
  );
  assert.equal(accepted.status, 200, await accepted.text());
  assert.ok(monitorId && monitorId !== clientChosenId);
  const offer = {
    type: "ship_pr_digest",
    monitorId,
    sessionId,
    prUrl,
    createdAt: Date.now(),
    feedback: [{ kind: "conversation", id: 456 }],
    omitted: 0,
  };
  function sendDigest(changes: Partial<typeof offer> = {}) {
    const id = randomUUID();
    sendUp({ ...offer, ...changes, seq: ++up, id });
    return id;
  }
  const noGrant = sendDigest({ monitorId: clientChosenId });
  const wrongSession = sendDigest({ sessionId: randomUUID() });
  const wrongPr = sendDigest({ prUrl: "https://github.com/test/repo/pull/43" });
  const id = sendDigest();
  const database = new Database(join(mainAgentDir, "keylime", "outbox.db"), {
    readonly: true,
  });
  t.after(() => database.close());
  const entry = (digestId: string) =>
    database
      .query("SELECT source_host_id, state FROM entries WHERE id = ?")
      .get(digestId);
  await waitFor(
    () => (entry(id) as { state: string } | null)?.state === "failed",
    "missing source-host session to fail",
  );
  assert.deepEqual(entry(id), { source_host_id: source.id, state: "failed" });
  assert.deepEqual(statusRequests, [
    { ...workspace, monitorId },
    { ...workspace, monitorId },
  ]);
  assert.deepEqual(receipts, [id]);
  for (const rejected of [noGrant, wrongSession, wrongPr])
    assert.equal(entry(rejected), null);
  const wrongAfterPin = sendDigest({
    prUrl: "https://github.com/test/repo/pull/44",
  });

  const stopped = await stopShipRequest(
    requestBody("/api/ship/monitor/stop", {
      host: source.id,
      ...workspace,
      monitorId,
    }),
  );
  assert.equal(stopped.status, 200, await stopped.text());
  const afterStop = sendDigest();
  const afterStopSeq = up;
  await waitFor(
    () => ack >= afterStopSeq,
    "transport ACK of a post-stop offer",
  );
  assert.equal(entry(afterStop), null);
  assert.equal(entry(wrongAfterPin), null);
  assert.deepEqual(receipts, [id]);
  assert.equal(statusRequests.length, 2);
  assert.equal(
    ompLog().some((event) =>
      event.command?.args?.message?.includes(`${prUrl}#issuecomment-456`),
    ),
    false,
  );
});

test("revoking the host closes its socket; the daemon is refused 401, stops its omp children and exits 1", async () => {
  const children = [
    ...new Set(
      ompLog()
        .filter((entry) => entry.kind === "start")
        .map((entry) => entry.pid),
    ),
  ];
  assert.equal(revokeHost(hostId), true);
  hub.closeHostLink(hostId);
  await waitFor(() => daemon.exitCode !== null, "the daemon to exit");
  assert.equal(daemon.exitCode, 1, daemonLog);
  assert.match(daemonLog, /revoked/);
  for (const pid of children)
    assert.throws(
      () => process.kill(pid, 0),
      { code: "ESRCH" },
      `omp child ${pid} still runs`,
    );
});
