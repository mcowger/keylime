import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type {
  TerminalEvent,
  TerminalSnapshot,
  WorkspaceTerminal,
} from "../terminal-types";
import { readHierarchy } from "./project-hierarchy";
import { HostOpError } from "./link-protocol";
import { createChildProcessEnvironment } from "../project-command-env";

const invalid = () =>
  new HostOpError(400, "invalid_request", "Invalid terminal request");
const missing = () =>
  new HostOpError(404, "terminal_not_found", "Terminal not found");
function dimensions(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    cols > 500 ||
    rows < 2 ||
    rows > 300
  )
    throw invalid();
}
function contains(root: string, cwd: string): boolean {
  const rel = relative(resolve(root), resolve(cwd));
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))
  );
}
type RGB = [number, number, number];
const ansiDefaults = [
  0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a,
  0xd3d7cf, 0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8,
  0x34e2e2, 0xeeeeec,
].map((c): RGB => [c >> 16, (c >> 8) & 255, c & 255]);
const levels = [0, 95, 135, 175, 215, 255];
for (let i = 0; i < 216; i++)
  ansiDefaults.push([
    levels[Math.floor(i / 36)],
    levels[Math.floor(i / 6) % 6],
    levels[i % 6],
  ]);
for (let i = 0; i < 24; i++)
  ansiDefaults.push([8 + i * 10, 8 + i * 10, 8 + i * 10]);
const specialDefaults: RGB[] = [
  [255, 255, 255],
  [0, 0, 0],
  [255, 255, 255],
];

// Match xterm.js XParseColor, including its distinct #RGB and rgb:R/G/B scaling.
function parseColor(spec: string): RGB | undefined {
  let parts: string[];
  let rgb = false;
  if (/^rgb:/i.test(spec)) {
    parts = spec.slice(4).split("/");
    rgb = true;
    if (
      parts.length !== 3 ||
      !parts.every(
        (p) => /^[\da-f]{1,4}$/i.test(p) && p.length === parts[0].length,
      )
    )
      return;
  } else if (
    /^#[\da-f]+$/i.test(spec) &&
    [4, 7, 10, 13].includes(spec.length)
  ) {
    const width = (spec.length - 1) / 3;
    parts = [
      spec.slice(1, 1 + width),
      spec.slice(1 + width, 1 + width * 2),
      spec.slice(1 + width * 2),
    ];
  } else return;
  return parts.map((part) => {
    const value = parseInt(part, 16);
    return rgb
      ? Math.round((value * 255) / (16 ** part.length - 1))
      : part.length === 1
        ? value << 4
        : part.length === 2
          ? value
          : value >> (4 * (part.length - 2));
  }) as RGB;
}
function colorReply(color: RGB): string {
  return (
    "rgb:" +
    color.map((c) => c.toString(16).padStart(2, "0").repeat(2)).join("/")
  );
}

function installColorHandlers(
  screen: Terminal,
  reply: (data: string) => void,
): void {
  const palette = ansiDefaults.slice();
  const special = specialDefaults.slice();
  screen.parser.registerOscHandler(4, (data) => {
    const parts = data.split(";");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if (!/^\d+$/.test(parts[i])) continue;
      const index = Number(parts[i]);
      if (index > 255) continue;
      if (parts[i + 1] === "?")
        reply(`\x1b]4;${index};${colorReply(palette[index])}\x1b\\`);
      else {
        const color = parseColor(parts[i + 1]);
        if (color) palette[index] = color;
      }
    }
    return true;
  });
  for (let id = 10; id <= 12; id++) {
    screen.parser.registerOscHandler(id, (data) => {
      const parts = data.split(";");
      for (let i = 0; i < parts.length && id + i <= 12; i++) {
        const index = id + i - 10;
        if (parts[i] === "?")
          reply(`\x1b]${id + i};${colorReply(special[index])}\x1b\\`);
        else {
          const color = parseColor(parts[i]);
          if (color) special[index] = color;
        }
      }
      return true;
    });
    screen.parser.registerOscHandler(id + 100, () => {
      special[id - 10] = specialDefaults[id - 10];
      return true;
    });
  }
  screen.parser.registerOscHandler(104, (data) => {
    if (!data) for (let i = 0; i < 256; i++) palette[i] = ansiDefaults[i];
    else
      for (const part of data.split(";")) {
        const index = Number(part);
        if (/^\d+$/.test(part) && index <= 255)
          palette[index] = ansiDefaults[index];
      }
    return true;
  });
}
/** A PTY shell owns its session; foreground jobs use different process groups within it. */
function signalSession(pid: number, signal: NodeJS.Signals): void {
  const rows = execFileSync("ps", ["-A", "-o", "pid=", "-o", "sess="], {
    encoding: "utf8",
    timeout: 3000,
  });
  for (const row of rows.split("\n")) {
    const [child, session] = row.trim().split(/\s+/).map(Number);
    if (
      session !== pid ||
      !Number.isSafeInteger(child) ||
      child <= 1 ||
      child === globalThis.process.pid
    )
      continue;
    try {
      globalThis.process.kill(child, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

type Entry = {
  terminal: WorkspaceTerminal;
  screen: Terminal;
  serializer: SerializeAddon;
  process: Bun.Subprocess;
  cursor: number;
  decoder: TextDecoder;
  closed: boolean;
  pending: number;
  viewers: Map<string, NodeJS.Timeout>;
  focusReported: boolean | null;
};

/** Processes and screen state belong to the daemon, not to a web link. */
export class TerminalManager {
  private entries = new Map<string, Entry>();
  private fences = new Set<string>();
  constructor(private emit: (id: string, event: TerminalEvent) => void) {}
  private registered(cwd: string): string {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw invalid();
    let canonical: string;
    try {
      canonical = realpathSync(cwd);
    } catch {
      throw new HostOpError(404, "workspace_not_found", "Workspace not found");
    }
    if (
      !readHierarchy().projects.some((p) =>
        p.workspaces.some((w) => w.path === canonical),
      )
    )
      throw new HostOpError(
        403,
        "workspace_not_registered",
        "Workspace is not registered",
      );
    return canonical;
  }
  private get(id: string): Entry {
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw invalid();
    const entry = this.entries.get(id);
    if (!entry) throw missing();
    this.registered(entry.terminal.cwd);
    return entry;
  }
  list(cwd: string): WorkspaceTerminal[] {
    const directory = this.registered(cwd);
    return [...this.entries.values()]
      .filter((e) => e.terminal.cwd === directory)
      .map((e) => ({ ...e.terminal }));
  }
  create(cwd: string, cols: number, rows: number): WorkspaceTerminal {
    dimensions(cols, rows);
    const directory = this.registered(cwd);
    if ([...this.fences].some((root) => contains(root, directory)))
      throw new HostOpError(
        409,
        "workspace_deleting",
        "Workspace is being deleted",
      );
    if (this.entries.size >= 32)
      throw new HostOpError(
        409,
        "terminal_limit",
        "Too many terminals on this host",
      );
    const id = randomUUID();
    const terminal = {
      id,
      cwd: directory,
      title: basename(directory),
      cols,
      rows,
    };
    const screen = new Terminal({
      cols,
      rows,
      scrollback: 2000,
      allowProposedApi: true,
      windowOptions: { getWinSizeChars: true },
    });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const decoder = new TextDecoder();
    let entry: Entry;
    const process = Bun.spawn(
      [globalThis.process.env.SHELL || "/bin/sh", "-i"],
      {
        detached: true,
        cwd: directory,
        env: createChildProcessEnvironment({
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        }),
        terminal: {
          cols,
          rows,
          data: (_pty, bytes) => {
            const data = decoder.decode(bytes, { stream: true });
            if (!data || !entry || entry.closed) return;
            entry.pending += data.length;
            if (entry.pending > 16 * 1024 * 1024) {
              signalSession(entry.process.pid, "SIGKILL");
              entry.process.terminal?.close();
              return;
            }
            screen.write(data, () => {
              entry.pending -= data.length;
              if (!entry.closed) this.syncFocus(entry);
              if (!entry.closed)
                this.emit(id, { type: "output", data, cursor: ++entry.cursor });
            });
          },
        },
      },
    );
    entry = {
      terminal,
      screen,
      serializer,
      process,
      cursor: 0,
      decoder,
      closed: false,
      pending: 0,
      viewers: new Map(),
      focusReported: null,
    };
    this.entries.set(id, entry);
    installColorHandlers(screen, (data) => {
      if (!entry.closed) entry.process.terminal?.write(data);
    });
    screen.onData((data) => {
      if (!entry.closed) entry.process.terminal?.write(data);
    });
    void process.exited.then(() => this.remove(entry));
    return { ...terminal };
  }
  async snapshot(id: string): Promise<TerminalSnapshot> {
    const entry = this.get(id);
    const { promise, resolve } = Promise.withResolvers<void>();
    entry.screen.write("", resolve);
    await promise;
    if (entry.closed) throw missing();
    return {
      terminal: { ...entry.terminal },
      snapshot: entry.serializer.serialize(),
      cursor: entry.cursor,
    };
  }
  private syncFocus(entry: Entry): void {
    if (!entry.screen.modes.sendFocusMode) {
      entry.focusReported = null;
      return;
    }
    const focused = entry.viewers.size > 0;
    if (focused !== entry.focusReported) {
      entry.focusReported = focused;
      entry.process.terminal?.write(focused ? "\x1b[I" : "\x1b[O");
    }
  }
  focus(id: string, viewer: string, focused: boolean): void {
    if (
      typeof viewer !== "string" ||
      viewer.length < 1 ||
      viewer.length > 128 ||
      typeof focused !== "boolean"
    )
      throw invalid();
    const entry = this.get(id);
    if (focused && !entry.viewers.has(viewer) && entry.viewers.size >= 128)
      throw new HostOpError(
        409,
        "terminal_viewer_limit",
        "Too many terminal viewers",
      );
    clearTimeout(entry.viewers.get(viewer));
    if (focused) {
      entry.viewers.set(
        viewer,
        setTimeout(() => {
          entry.viewers.delete(viewer);
          if (!entry.closed) this.syncFocus(entry);
        }, 15000),
      );
    } else entry.viewers.delete(viewer);
    this.syncFocus(entry);
  }
  input(id: string, data: string): void {
    if (typeof data !== "string" || data.length > 65536) throw invalid();
    this.get(id).process.terminal!.write(data);
  }
  async resize(id: string, cols: number, rows: number): Promise<void> {
    dimensions(cols, rows);
    const entry = this.get(id);
    const { promise, resolve } = Promise.withResolvers<void>();
    entry.screen.write("", resolve);
    await promise;
    if (entry.closed) throw missing();
    entry.screen.resize(cols, rows);
    entry.process.terminal!.resize(cols, rows);
    entry.terminal.cols = cols;
    entry.terminal.rows = rows;
    this.emit(id, { type: "resize", cols, rows, cursor: ++entry.cursor });
  }
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw missing();
    signalSession(entry.process.pid, "SIGTERM");
    await Bun.sleep(100);
    signalSession(entry.process.pid, "SIGKILL");
    entry.process.terminal?.close();
    const result = await Promise.race([
      entry.process.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!result)
      throw new HostOpError(
        409,
        "workspace_process_stop_failed",
        "Terminal did not exit",
      );
    this.remove(entry);
  }
  private remove(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    for (const timer of entry.viewers.values()) clearTimeout(timer);
    entry.viewers.clear();
    this.entries.delete(entry.terminal.id);
    entry.screen.dispose();
    this.emit(entry.terminal.id, { type: "closed" });
  }
  fence(directory: string): () => void {
    this.fences.add(directory);
    return () => this.fences.delete(directory);
  }
  inspect(directory: string): Array<{ id: string; cwd: string }> {
    return [...this.entries.values()]
      .filter((e) => contains(directory, e.terminal.cwd))
      .map((e) => ({ id: e.terminal.id, cwd: e.terminal.cwd }));
  }
  async stopWorkspace(directory: string): Promise<void> {
    await Promise.all(this.inspect(directory).map((e) => this.close(e.id)));
  }
  async stop(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }
}
