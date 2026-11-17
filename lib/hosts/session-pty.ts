import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

// Hold incomplete control sequences across chunks. Only complete sequences are passed
// to the predicate, so a query can never leak to an attached physical terminal.
class ControlFilter {
  private pending = "";
  private inPaste = false;
  constructor(private drop: (sequence: string) => boolean, private preservePaste = false, private onPasteControl?: (char: string) => boolean) {}
  flushEscape(): string {
    if (this.inPaste || this.pending !== "\x1b") return "";
    this.pending = "";
    return "\x1b";
  }
  push(data: string): string {
    const text = this.pending + data;
    this.pending = "";
    let result = "";
    for (let i = 0; i < text.length;) {
      if (this.inPaste) {
        const end = "\x1b[201~";
        const remaining = text.slice(i);
        if (remaining.length < end.length && end.startsWith(remaining)) { this.pending = remaining; break; }
        if (text.startsWith(end, i)) { result += end; i += end.length; this.inPaste = false; continue; }
        if (!this.onPasteControl?.(text[i])) result += text[i];
        i++;
        continue;
      }
      if (text[i] !== "\x1b") { result += text[i++]; continue; }
      const start = i++;
      if (i === text.length) { this.pending = text.slice(start); break; }
      const kind = text[i++];
      if (kind === "[" || kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
        let complete = false;
        while (i < text.length) {
          const c = text.charCodeAt(i++);
          if (kind === "[" ? c >= 0x40 && c <= 0x7e : c === 7 || (c === 0x5c && text.charCodeAt(i - 2) === 0x1b)) { complete = true; break; }
        }
        if (!complete) {
          this.pending = text.slice(start);
          // A malformed unbounded control string must not consume unlimited memory.
          if (this.pending.length > 1024 * 1024) this.pending = "";
          break;
        }
      } else if (kind >= " " && kind <= "/") {
        while (i < text.length && text[i] >= " " && text[i] <= "/") i++;
        if (i === text.length) { this.pending = text.slice(start); break; }
        i++;
      }
      const sequence = text.slice(start, i);
      if (this.preservePaste && sequence === "\x1b[200~") this.inPaste = true;
      if (!this.drop(sequence)) result += sequence;
    }
    return result;
  }
}

function outputQuery(s: string): boolean {
  if (s.startsWith("\x1b]")) return /^\x1b\](?:4|10|11|12);/.test(s) && s.includes("?");
  if (s.startsWith("\x1bP")) return s.startsWith("\x1bP$q") || s.startsWith("\x1bP+q");
  if (!s.startsWith("\x1b[")) return s === "\x1bZ";
  const body = s.slice(2, -1), final = s.at(-1);
  return final === "c" || final === "n" || (final === "t" && /^(?:11|13|14|15|16|18|19|20|21)(?:;.*)?$/.test(body)) ||
    (final === "p" && body.endsWith("$")) ||
    (final === "q" && body.startsWith(">")) ||
    // xterm-headless does not implement kitty keyboard protocol or modifyOtherKeys.
    (final === "u" && /^[>?=]/.test(body)) ||
    (final === "m" && body.startsWith(">4;"));
}
function inputReply(s: string): boolean {
  if (s.startsWith("\x1b]") || s.startsWith("\x1bP")) return true;
  if (!s.startsWith("\x1b[")) return false;
  const body = s.slice(2, -1), final = s.at(-1);
  return (final === "R" && /^\d+;\d+$/.test(body)) ||
    (final === "c" && /^[?>=\d;]*$/.test(body)) ||
    (final === "n" && /^[?\d;]*$/.test(body)) ||
    (final === "y" && body.includes("$")) ||
    (final === "t" && /^\d+(;\d+)+$/.test(body)) ||
    (final === "u" && body.startsWith("?"));
}

function installColorReplies(screen: Terminal, reply: (data: string) => void): void {
  const defaults = [0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf, 0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) defaults.push((levels[Math.floor(i / 36)] << 16) | (levels[Math.floor(i / 6) % 6] << 8) | levels[i % 6]);
  for (let i = 0; i < 24; i++) defaults.push((8 + i * 10) * 0x010101);
  const palette = defaults.slice(), special = [0xffffff, 0, 0xffffff];
  const parse = (value: string): number | undefined => {
    let parts: string[];
    if (/^rgb:/i.test(value)) parts = value.slice(4).split("/");
    else if (/^#[\da-f]+$/i.test(value) && [4, 7, 10, 13].includes(value.length)) {
      const width = (value.length - 1) / 3;
      parts = [value.slice(1, 1 + width), value.slice(1 + width, 1 + 2 * width), value.slice(1 + 2 * width)];
    } else return;
    if (parts.length !== 3 || !parts.every((part) => /^[\da-f]{1,4}$/i.test(part))) return;
    return parts.reduce((color, part) => (color << 8) | Math.round(parseInt(part, 16) * 255 / (16 ** part.length - 1)), 0);
  };
  const color = (value: number) => [value >> 16, (value >> 8) & 255, value & 255].map((n) => n.toString(16).padStart(2, "0").repeat(2)).join("/");
  screen.parser.registerOscHandler(4, (data) => {
    const parts = data.split(";");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const index = Number(parts[i]);
      if (!/^\d+$/.test(parts[i]) || index > 255) continue;
      if (parts[i + 1] === "?") reply(`\x1b]4;${index};rgb:${color(palette[index])}\x1b\\`);
      else { const value = parse(parts[i + 1]); if (value !== undefined) palette[index] = value; }
    }
    return true;
  });
  for (let id = 10; id <= 12; id++) {
    screen.parser.registerOscHandler(id, (data) => {
      for (const [offset, part] of data.split(";").entries()) {
        const index = id - 10 + offset; if (index > 2) break;
        if (part === "?") reply(`\x1b]${10 + index};rgb:${color(special[index])}\x1b\\`);
        else { const value = parse(part); if (value !== undefined) special[index] = value; }
      }
      return true;
    });
    screen.parser.registerOscHandler(id + 100, () => { special[id - 10] = id === 11 ? 0 : 0xffffff; return true; });
  }
  screen.parser.registerOscHandler(104, (data) => { if (!data) defaults.forEach((value, i) => { palette[i] = value; }); else for (const part of data.split(";")) { const i = Number(part); if (/^\d+$/.test(part) && i < 256) palette[i] = defaults[i]; } return true; });
}

type Entry = {
  runtimeId: string; process: Bun.Subprocess; screen: Terminal; serializer: SerializeAddon;
  decoder: TextDecoder; filter: ControlFilter; clients: Set<Socket>; ready: Set<Socket>; cursor: number; closed: boolean;
  lastInterrupt?: number;
};
const send = (socket: Socket, message: object) => { if (socket.writable) socket.write(JSON.stringify(message) + "\n"); };

export class SessionPtyManager {
  private server: Server | undefined;
  private entries = new Map<string, Entry>();
  private sessions = new Map<string, string>();
  private sockets = new Set<Socket>();
  private closed = false;
  constructor(private socketPath: string, private onAttachmentChange: (runtimeId: string, attached: boolean) => void, private now: () => number = () => performance.now()) {}

  async start(): Promise<void> {
    if (this.closed || this.server) throw new Error("PTY manager is closed or already started");
    const dir = dirname(this.socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error(`Unsafe socket directory: ${dir}`);
    chmodSync(dir, 0o700);
    try {
      const existing = lstatSync(this.socketPath);
      if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error(`Unsafe socket path: ${this.socketPath}`);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const probe = createConnection(this.socketPath);
      probe.once("connect", () => { probe.destroy(); reject(new Error(`Socket already in use: ${this.socketPath}`)); });
      probe.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
      await promise;
      unlinkSync(this.socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const server = createServer((socket) => this.connect(socket));
    this.server = server;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once("error", reject);
    server.listen(this.socketPath, () => { server.removeListener("error", reject); chmodSync(this.socketPath, 0o600); resolve(); });
    await promise;
  }

  spawn(options: { runtimeId: string; argv: string[]; cwd: string; env: Record<string, string> }): { pid: number; exited: Promise<number>; kill(force?: boolean): void } {
    if (this.closed || !this.server || this.entries.has(options.runtimeId)) throw new Error("PTY manager unavailable or runtime already exists");
    const screen = new Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true, windowOptions: { getWinSizeChars: true } });
    const serializer = new SerializeAddon(); screen.loadAddon(serializer);
    let entry: Entry;
    const child = Bun.spawn(options.argv, {
      cwd: options.cwd, env: { ...options.env, TERM: "xterm-256color", COLORTERM: "truecolor" }, detached: true,
      terminal: { cols: 80, rows: 24, data: (_terminal, bytes) => {
        const data = entry.decoder.decode(bytes, { stream: true });
        if (!data || entry.closed) return;
        const visible = entry.filter.push(data);
        screen.write(data, () => {
          if (entry.closed) return;
          if (visible) { const cursor = ++entry.cursor; for (const socket of entry.ready) send(socket, { type: "output", data: visible, cursor }); }
        });
      } },
    });
    entry = { runtimeId: options.runtimeId, process: child, screen, serializer, decoder: new TextDecoder(), filter: new ControlFilter(outputQuery), clients: new Set(), ready: new Set(), cursor: 0, closed: false };
    this.entries.set(options.runtimeId, entry);
    screen.onData((data) => { if (!entry.closed) child.terminal?.write(data); });
    installColorReplies(screen, (data) => { if (!entry.closed) child.terminal?.write(data); });
    const exited = child.exited.then((code) => {
      // Drain xterm's asynchronous write queue before reporting exit.
      const { promise, resolve } = Promise.withResolvers<number>();
      screen.write("", () => {
        for (const socket of entry.clients) { send(socket, { type: "exit", code }); socket.end(); }
        entry.closed = true; child.terminal?.close(); screen.dispose();
        this.entries.delete(options.runtimeId);
        for (const [session, runtime] of this.sessions) if (runtime === options.runtimeId) this.sessions.delete(session);
        resolve(code);
      });
      return promise;
    });
    return { pid: child.pid, exited, kill: (force = false) => { if (!entry.closed) { const signal = force ? "SIGKILL" : "SIGTERM"; try { process.kill(-child.pid, signal); } catch { child.kill(signal); } } } };
  }

  bind(runtimeId: string, sessionId: string): void {
    if (!this.entries.has(runtimeId)) throw new Error(`Unknown PTY runtime: ${runtimeId}`);
    for (const [session, runtime] of this.sessions) if (runtime === runtimeId && session !== sessionId) this.sessions.delete(session);
    this.sessions.set(sessionId, runtimeId);
  }

  listSessions(): string[] {
    return [...this.sessions].filter(([, runtime]) => {
      const entry = this.entries.get(runtime);
      return entry !== undefined && !entry.closed;
    }).map(([session]) => session);
  }

  private connect(socket: Socket): void {
    this.sockets.add(socket);
    const lines = createInterface({ input: socket });
    let entry: Entry | undefined;
    let blockedPasteEof = false, blockedPasteInterrupt = false;
    const inputFilter = new ControlFilter(inputReply, true, (char) => {
      if (char === "\x04") { blockedPasteEof = true; return true; }
      if (char === "\x03") { blockedPasteInterrupt = true; return true; }
      return false;
    });
    let escapeTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => socket.destroy(), 10000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer); this.sockets.delete(socket); lines.close();
      clearTimeout(escapeTimer);
      entry?.ready.delete(socket);
      if (entry?.clients.delete(socket) && entry.clients.size === 0) this.onAttachmentChange(entry.runtimeId, false);
    });
    lines.on("line", (line) => {
      try {
        if (line.length > 1024 * 1024) throw new Error("Message too large");
        const message = JSON.parse(line);
        if (!entry) {
          if (message.type !== "hello" || typeof message.sessionId !== "string") throw new Error("Expected hello with session ID");
          const runtime = this.sessions.get(message.sessionId);
          entry = runtime ? this.entries.get(runtime) : undefined;
          if (!entry || entry.closed) throw new Error("Session has no running terminal");
          clearTimeout(timer);
          const target = entry;
          if (target.clients.size === 0) this.onAttachmentChange(target.runtimeId, true);
          // Count attachment immediately; output starts at the snapshot boundary.
          target.clients.add(socket);
          target.screen.write("", () => {
            if (socket.destroyed || target.closed) return;
            if (Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 1000 && message.rows >= 2 && message.rows <= 1000) {
              target.screen.resize(message.cols, message.rows); target.process.terminal?.resize(message.cols, message.rows);
            }
            send(socket, { type: "snapshot", data: target.serializer.serialize(), cols: target.screen.cols, rows: target.screen.rows, cursor: target.cursor });
            target.ready.add(socket);
          });
        } else if (message.type === "input" && typeof message.data === "string") {
          clearTimeout(escapeTimer);
          blockedPasteEof = false; blockedPasteInterrupt = false;
          const filtered = inputFilter.push(message.data);
          let data = "", blockedEof = false, blockedInterrupt = false;
          for (const char of filtered) {
            if (char === "\x04") { blockedEof = true; continue; }
            if (char === "\x03") {
              const now = this.now();
              const repeated = entry.lastInterrupt !== undefined && now - entry.lastInterrupt <= 500;
              entry.lastInterrupt = now;
              if (repeated) { blockedInterrupt = true; continue; }
            }
            data += char;
          }
          if (data) entry.process.terminal?.write(data);
          if (blockedEof || blockedPasteEof) send(socket, { type: "notice", message: "Ctrl-D is blocked. Press Ctrl-] to detach or use /quit to end the session." });
          if (blockedInterrupt) send(socket, { type: "notice", message: "Repeated Ctrl-C is blocked. Press Ctrl-] to detach or use /quit to end the session." });
          if (blockedPasteInterrupt) send(socket, { type: "notice", message: "Ctrl-C in pasted text is blocked. Press Ctrl-] to detach or use /quit to end the session." });
          const target = entry;
          escapeTimer = setTimeout(() => { const escape = inputFilter.flushEscape(); if (escape && !target.closed) target.process.terminal?.write(escape); }, 50);
        } else if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 1000 && message.rows >= 2 && message.rows <= 1000) {
          const target = entry;
          target.screen.write("", () => {
            if (target.closed) return;
            target.screen.resize(message.cols, message.rows); target.process.terminal?.resize(message.cols, message.rows);
          });
        } else if (message.type === "detach") socket.end();
        else throw new Error("Invalid terminal message");
      } catch (error) { send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }); socket.end(); }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    const entries = [...this.entries.values()];
    for (const entry of entries) { try { process.kill(-entry.process.pid, "SIGTERM"); } catch { try { entry.process.kill(); } catch {} } }
    const escalation = setTimeout(() => {
      for (const entry of entries) if (!entry.closed) { try { process.kill(-entry.process.pid, "SIGKILL"); } catch { try { entry.process.kill("SIGKILL"); } catch {} } }
    }, 1000);
    await Promise.all(entries.map((entry) => entry.process.exited));
    clearTimeout(escalation);
    if (this.server) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.server.close(() => resolve());
      await promise;
      try { unlinkSync(this.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
