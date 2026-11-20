import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  encodeLine,
  LINK_LIMITS,
  LINK_PROTOCOL_VERSION,
} from "./link-protocol.ts";

const scratch = mkdtempSync(join(tmpdir(), "daemon-links-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(scratch, { recursive: true, force: true });
});
// Import after installing the isolated agent directory.
const { DaemonLink } = await import("./daemon-link.ts");

const until = async (predicate: () => boolean) => {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("link timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
function hub(t: test.TestContext, max = LINK_PROTOCOL_VERSION) {
  const hellos: { link: { id: string }; v: number }[] = [],
    messages: { type: string; seq: number; id?: string }[] = [];
  let socket: ServerWebSocket<unknown> | undefined,
    ack = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, s) {
      return s.upgrade(req) ? undefined : new Response("", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        if (typeof data !== "string") return;
        for (const line of data.split("\n").filter(Boolean)) {
          const m = JSON.parse(line);
          if (m.type === "hello") {
            hellos.push(m);
            socket = ws;
            if (m.v > max) {
              ws.close(4426, JSON.stringify({ serverVersion: max }));
              continue;
            }
            ws.send(encodeLine({ type: "welcome", v: max, hostId: "h" }));
          } else if (m.seq) {
            messages.push(m);
            ack = m.seq;
          }
        }
        if (ws.readyState === 1) ws.send(encodeLine({ type: "ack", ack }));
      },
    },
  });
  t.after(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}`,
    hellos,
    messages,
    close: (code: number) => {
      assert.ok(socket);
      socket.close(code);
    },
  };
}
function link(
  server: { url: string },
  id: string,
  ends: [string, "revoked" | "replaced" | "version"][],
) {
  return new DaemonLink({ url: server.url, token: "test" }, id, {
    allowHttp: false,
    hello: (link) =>
      encodeLine({
        type: "hello",
        v: link.version,
        ompVersion: null,
        platform: "linux",
        home: "/tmp",
        autoApproveExtension: false,
        ack: link.ackedDown,
        channels: [],
      }),
    handleDown() {},
    onEnd: (link, reason) => ends.push([link.id, reason]),
    log() {},
  });
}

test("a v13 controller cannot establish a v14 link", async (t) => {
  const server = hub(t, 13);
  const ends: [string, "revoked" | "replaced" | "version"][] = [];
  const connection = link(server, "controller", ends);
  t.after(() => connection.stop());
  connection.start();
  await until(() => ends.length === 1);
  assert.equal(server.hellos[0].v, 14);
  assert.deepEqual(ends, [["controller", "version"]]);
  assert.equal(connection.isUp(), false);
});

test("overflow preserves numbered sequence records and requests resync", async (t) => {
  const server = hub(t),
    connection = link(server, "controller", []);
  t.after(() => connection.stop());
  connection.start();
  await until(() => connection.isUp());
  const old = LINK_LIMITS.channelBufferBytes;
  LINK_LIMITS.channelBufferBytes = 1000;
  t.after(() => {
    LINK_LIMITS.channelBufferBytes = old;
  });
  connection.output({ type: "stdout", ch: "c", line: "x".repeat(2000) }, "s");
  await until(() => server.messages.some((m) => m.type === "resync"));
  assert.deepEqual(
    server.messages.map((m) => m.seq),
    server.messages.map((_, i) => i + 1),
  );
});

test("a fresh snapshot discards old output without discarding its queued open result", async (t) => {
  const server = hub(t),
    connection = link(server, "l1", []);
  t.after(() => connection.stop());
  connection.start();
  await until(() => connection.isUp());
  connection.result("open", { ch: "c" }, { key: "c" });
  connection.output({ type: "stdout", ch: "c", line: "old delta" }, null);
  connection.discard("c");
  await until(() =>
    server.messages.some(
      (message) => message.type === "res" && message.id === "open",
    ),
  );
  assert.equal(
    server.messages.some((message) => message.type === "stdout"),
    false,
  );
});

test("reliable results hold the link busy until acknowledged", async (t) => {
  const server = hub(t),
    connection = link(server, "controller", []);
  t.after(() => connection.stop());
  connection.start();
  await until(() => connection.isUp());
  connection.result("held-result", { native: true });
  assert.equal(connection.busy(), true);
  await until(
    () =>
      server.messages.some((message) => message.id === "held-result") &&
      !connection.busy(),
  );
});
