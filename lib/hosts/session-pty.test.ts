import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionPtyManager } from "./session-pty";

type Message = { type: string; data?: string; message?: string };

class Client {
  readonly messages: Message[] = [];
  readonly socket: Socket;

  constructor(path: string) {
    this.socket = createConnection(path);
    createInterface({ input: this.socket }).on("line", (line) => {
      this.messages.push(JSON.parse(line) as Message);
    });
    this.socket.on("error", () => {});
    this.send({ type: "hello", sessionId: "session" });
  }

  send(message: object): void {
    this.socket.write(JSON.stringify(message) + "\n");
  }

  input(data: string): void {
    this.send({ type: "input", data });
  }

  output(): string {
    return this.messages.filter((message) => message.type === "output" || message.type === "snapshot").map((message) => message.data ?? "").join("");
  }

  notices(): string[] {
    return this.messages.filter((message) => message.type === "notice").map((message) => message.message ?? "");
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for PTY test condition");
    await delay(5);
  }
}

function received(output: string): string {
  return [...output.matchAll(/I([0-9a-f]{2})Z/g)].map((match) => match[1]).join("");
}

test("shared session PTY protects interrupts and EOF across clients and reconnects", { timeout: 15000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "keylime-session-pty-"));
  const socketPath = join(directory, "attach.sock");
  let now = 0;
  const manager = new SessionPtyManager(socketPath, () => {}, () => now);
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.destroy();
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await manager.start();
  const child = manager.spawn({
    runtimeId: "runtime",
    argv: [process.execPath, "-e", `
      process.stdin.setRawMode(true);
      process.stdin.on("data", data => {
        for (const byte of data) process.stdout.write("I" + byte.toString(16).padStart(2, "0") + "Z");
      });
      process.stdout.write("READY\\x1b[6n");
    `],
    cwd: directory,
    env: { PATH: process.env.PATH ?? "" },
  });
  manager.bind("runtime", "session");
  assert.deepEqual(manager.listSessions(), ["session"]);
  const first = new Client(socketPath);
  const second = new Client(socketPath);
  clients.push(first, second);
  await until(() => first.messages.some((message) => message.type === "snapshot") && second.messages.some((message) => message.type === "snapshot") && first.output().includes("READY"));

  // The headless terminal's own response still reaches the process, independently
  // of viewer input filtering. Synchronize subsequent assertions with markers.
  await until(() => received(first.output()).includes("1b5b") && received(first.output()).includes("52"));
  first.input("A\x03B\x04C");
  await until(() => received(first.output()).endsWith("41034243") && first.notices().length === 1);
  assert.match(first.notices()[0], /Ctrl-D.*Ctrl-\].*\/quit/);
  assert.deepEqual(second.notices(), []);

  now = 500;
  second.input("\x03D");
  await until(() => received(first.output()).endsWith("4103424344") && second.notices().length === 1);
  assert.match(second.notices()[0], /Ctrl-C.*Ctrl-\].*\/quit/);
  assert.equal(first.notices().length, 1);

  second.send({ type: "detach" });
  await until(() => second.socket.destroyed);
  const reconnected = new Client(socketPath);
  clients.push(reconnected);
  await until(() => reconnected.messages.some((message) => message.type === "snapshot"));
  now = 1000;
  reconnected.input("\x03E");
  await until(() => received(first.output()).endsWith("410342434445") && reconnected.notices().length === 1);
  now = 1501;
  reconnected.input("\x03F");
  await until(() => received(first.output()).endsWith("4103424344450346"));
  assert.equal(reconnected.notices().length, 1);

  // Split paste delimiters and terminal replies remain framed across messages.
  // Literal control bytes in pasted text receive the same protection as keys.
  now = 1600;
  first.input("\x1b[20");
  first.input("0~x\x04\x03y\x1b[12;40R\x1b[20");
  first.input("1~\x1b[12;");
  first.input("40R\x1b[AQ");
  await until(() => received(first.output()).endsWith("1b5b3230307e78791b5b31323b3430521b5b3230317e1b5b4151") && first.notices().length === 3);
  assert.match(first.notices()[1], /Ctrl-D/);
  assert.match(first.notices()[2], /Ctrl-C/);
  assert.equal(reconnected.notices().length, 1);
  // Pasted Ctrl-C is not an interrupt and must not extend the shared window.
  now = 2002;
  first.input("\x03Z");
  await until(() => received(first.output()).endsWith("51035a"));
  assert.equal(first.notices().length, 3);
  child.kill();
  await child.exited;
  assert.deepEqual(manager.listSessions(), []);
});
