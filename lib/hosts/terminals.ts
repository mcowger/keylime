import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type {
  TerminalEvent,
  TerminalSnapshot,
  WorkspaceTerminal,
} from "../terminal-types";
import type { WorkspaceScriptRun } from "../api-contracts/workspace-models";
import { readHierarchy, type RegistryProject } from "./project-hierarchy";
import { HostOpError } from "./link-protocol";
import { createChildProcessEnvironment } from "../project-command-env";

const invalid = () =>
  new HostOpError(400, "invalid_request", "Invalid terminal request");
const missing = () =>
  new HostOpError(404, "terminal_not_found", "Terminal not found");

export type TerminalWorkspaceRegistration = {
  project: RegistryProject;
  workspace: RegistryProject["workspaces"][number];
};

export function resolveTerminalWorkspace(
  cwd: string,
): TerminalWorkspaceRegistration {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw invalid();
  let canonical: string;
  try {
    canonical = realpathSync(cwd);
  } catch {
    throw new HostOpError(404, "workspace_not_found", "Workspace not found");
  }
  for (const project of readHierarchy().projects) {
    const workspace = project.workspaces.find((w) => w.path === canonical);
    if (workspace) return { project, workspace };
  }
  throw new HostOpError(
    403,
    "workspace_not_registered",
    "Workspace is not registered",
  );
}

export function paseoServicePortVariable(name: string): string {
  return `PASEO_SERVICE_${name.replace(/[^a-zA-Z0-9]/gu, "_").toUpperCase()}_PORT`;
}

function allocatePaseoPort(
  fixed: number | undefined,
  claimed: Set<number>,
): number {
  // An unmanaged process can still bind the port after this check and before the child does.
  for (let i = 0; i < (fixed === undefined ? 32 : 1); i++) {
    if (fixed !== undefined && claimed.has(fixed)) break;
    try {
      const probe = Bun.listen({
        hostname: "0.0.0.0",
        port: fixed ?? 0,
        socket: { data() {} },
      });
      const { port } = probe;
      probe.stop(true);
      if (!claimed.has(port)) return port;
    } catch {
      break;
    }
  }
  throw new HostOpError(
    409,
    "paseo_port_unavailable",
    fixed === undefined
      ? "No automatic service port is available"
      : `Port ${fixed} is unavailable on this host`,
  );
}

function executableShell(path: string | null | undefined): path is string {
  if (!path || !isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function loginAccount(): { shell?: string; home?: string } {
  let shell: string | null | undefined;
  let home: string | undefined;
  // Bun's os.userInfo() can report the inherited SHELL, not the account shell.
  try {
    if (globalThis.process.platform === "linux") {
      const uid = globalThis.process.geteuid?.();
      if (uid !== undefined) {
        let record: string | undefined;
        try {
          record = execFileSync("/usr/bin/getent", ["passwd", String(uid)], {
            encoding: "utf8",
            timeout: 1500,
          }).trim();
        } catch {
          // Minimal Linux installations may not provide getent.
          record = readFileSync("/etc/passwd", "utf8")
            .split("\n")
            .find((line) => line.split(":")[2] === String(uid));
        }
        const fields = record?.split(":");
        if (fields?.[2] === String(uid)) {
          home = fields[5];
          shell = fields[6];
        }
      }
    } else if (globalThis.process.platform === "darwin") {
      const options = { encoding: "utf8" as const, timeout: 1500 };
      const name = execFileSync("/usr/bin/id", ["-un"], options).trim();
      if (name && !name.includes("/") && !name.includes("\n")) {
        const record = execFileSync(
          "/usr/bin/dscl",
          [
            "/Search",
            "-read",
            `/Users/${name}`,
            "UserShell",
            "NFSHomeDirectory",
          ],
          options,
        );
        shell = /^UserShell: (.+)$/m.exec(record)?.[1];
        home = /^NFSHomeDirectory: (.+)$/m.exec(record)?.[1];
      }
    }
  } catch {
    // Fall back to the service environment when the account is unavailable.
  }
  if (!home || !isAbsolute(home)) home = undefined;
  else {
    try {
      if (!statSync(home).isDirectory()) home = undefined;
    } catch {
      home = undefined;
    }
  }
  return { shell: executableShell(shell) ? shell : undefined, home };
}

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
function signalSession(
  leader: Bun.Subprocess,
  signal: NodeJS.Signals,
  tty?: string,
): string | undefined {
  const { pid } = leader;
  const leaderRunning = running(leader);
  // Darwin's sess column is a kernel pointer, not the session leader's PID.
  const darwin = globalThis.process.platform === "darwin";
  const table = execFileSync(
    "ps",
    ["-A", "-o", "pid=", "-o", "pgid=", "-o", darwin ? "tty=" : "sess="],
    { encoding: "utf8", timeout: 3000 },
  );
  const rows = table
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/));
  if (darwin && leaderRunning) {
    tty ??= rows.find(([child]) => Number(child) === pid)?.[2];
    // ?? means no controlling terminal; never match other non-terminal processes.
    if (tty === "??") tty = undefined;
  }
  for (const [childPid, group, session] of rows) {
    const child = Number(childPid);
    const owned =
      child === pid
        ? leaderRunning
        : darwin
          ? Number(group) === pid || (tty !== undefined && session === tty)
          : Number(session) === pid;
    if (
      !owned ||
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
  return tty;
}

type NamedScript = {
  name: string;
  kind: "script" | "service";
  port?: number;
  stopRequested?: true;
};

export type WorkspaceScriptObservation = Pick<NamedScript, "name" | "kind"> & {
  run: WorkspaceScriptRun;
};

type Entry = {
  terminal: WorkspaceTerminal;
  screen: Terminal;
  serializer: SerializeAddon;
  process: Bun.Subprocess;
  cursor: number;
  stopping?: Promise<void>;
  script?: NamedScript;
  closed: boolean;
  pending: number;
  viewers: Map<string, NodeJS.Timeout>;
  focusReported: boolean | null;
};

function running(process: Bun.Subprocess): boolean {
  return process.exitCode === null && process.signalCode === null;
}

function activePty(entry: Entry): Bun.Terminal | undefined {
  const pty = entry.process.terminal;
  return !entry.closed && pty && !pty.closed && running(entry.process)
    ? pty
    : undefined;
}

/** Processes and screen state belong to the daemon, not to a web link. */
export class TerminalManager {
  private entries = new Map<string, Entry>();
  private fences = new Set<string>();
  private stopped = false;
  constructor(
    private emit: (id: string, event: TerminalEvent) => void,
    private workspaceDeleting: (cwd: string) => boolean = () => false,
    private resolveAccount: () => {
      shell?: string;
      home?: string;
    } = loginAccount,
  ) {}
  private registered(cwd: string): string {
    return resolveTerminalWorkspace(cwd).workspace.path;
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
    if (this.registered(entry.terminal.cwd) !== entry.terminal.cwd)
      throw missing();
    return entry;
  }
  /** Retained output has a terminal ID even after the process exits. */
  has(id: string): boolean {
    return this.entries.has(id);
  }
  /** Whether the terminal's foreground process is still running, not whether it is ready. */
  isRunning(id: string): boolean {
    const entry = this.entries.get(id);
    return entry !== undefined && running(entry.process);
  }
  hasLiveProcesses(): boolean {
    for (const entry of this.entries.values())
      if (running(entry.process)) return true;
    return false;
  }
  list(cwd: string): WorkspaceTerminal[] {
    const directory = this.registered(cwd);
    return [...this.entries.values()]
      .filter((e) => e.terminal.cwd === directory)
      .map((e) => ({ ...e.terminal }));
  }
  create(cwd: string, cols: number, rows: number): WorkspaceTerminal {
    return this.launch(this.registered(cwd), cols, rows);
  }
  /** Run a saved service in the foreground; keep its screen after the command exits. */
  async startService(input: {
    cwd: string;
    command: string;
    env: Record<string, string>;
  }): Promise<WorkspaceTerminal> {
    return this.launchCommand(
      this.registered(input.cwd),
      input.command,
      input.env,
    );
  }
  startWorkspaceScript(input: {
    cwd: string;
    name: string;
    kind: "script" | "service";
    command: string;
    env: Record<string, string>;
    port?: number;
  }): WorkspaceTerminal {
    const directory = this.registered(input.cwd);
    const env = { ...input.env };
    let previous: Entry | undefined;
    let port: number | undefined;
    const claimed = new Set<number>();
    for (const entry of this.entries.values()) {
      const script = entry.script;
      if (!script) continue;
      const live = running(entry.process);
      const sameDirectory = directory === entry.terminal.cwd;
      if (sameDirectory && script.name === input.name) {
        if (live || entry.stopping)
          throw new HostOpError(
            409,
            "paseo_script_running",
            "This script is already running or stopping",
          );
        previous = entry;
      }
      if (input.kind === "service" && live && script.port !== undefined) {
        claimed.add(script.port);
        if (sameDirectory)
          env[paseoServicePortVariable(script.name)] = String(script.port);
      }
    }
    if (input.kind === "service") {
      port = allocatePaseoPort(input.port, claimed);
      env.PASEO_PORT = String(port);
      env[paseoServicePortVariable(input.name)] = String(port);
    }
    return this.launchCommand(directory, input.command, env, {
      script: { name: input.name, kind: input.kind, port },
      previous,
    });
  }
  listWorkspaceScriptRuns(cwd: string): WorkspaceScriptObservation[] {
    const directory = this.registered(cwd);
    const runs: WorkspaceScriptObservation[] = [];
    for (const entry of this.entries.values()) {
      const script = entry.script;
      if (!script || entry.terminal.cwd !== directory) continue;
      const { process } = entry;
      const live = running(process);
      runs.push({
        name: script.name,
        kind: script.kind,
        run: {
          terminalId: entry.terminal.id,
          status: live
            ? "running"
            : script.stopRequested
              ? "stopped"
              : "exited",
          port: live ? (script.port ?? null) : null,
          exitCode: process.exitCode,
          signal:
            process.signalCode === null ? null : String(process.signalCode),
        },
      });
    }
    return runs;
  }
  async stopWorkspaceScript(cwd: string, terminalId: string): Promise<void> {
    const directory = this.registered(cwd);
    const entry = this.entries.get(terminalId);
    if (!entry?.script || entry.terminal.cwd !== directory) throw missing();
    await this.stopScriptEntry(entry, entry.script);
  }
  private stopScriptEntry(
    entry: Entry,
    script: NamedScript,
  ): Promise<void> | undefined {
    if (running(entry.process)) {
      script.stopRequested = true;
      return this.stopEntry(entry);
    }
    return entry.stopping;
  }
  private launchCommand(
    directory: string,
    command: string,
    env: Record<string, string>,
    named?: { script: NamedScript; previous?: Entry },
  ): WorkspaceTerminal {
    return this.launch(
      directory,
      80,
      24,
      ["/bin/sh", "-c", command],
      env,
      named,
    );
  }
  private launch(
    directory: string,
    cols: number,
    rows: number,
    argv?: string[],
    serviceEnv?: Record<string, string>,
    named?: { script: NamedScript; previous?: Entry },
  ): WorkspaceTerminal {
    if (this.stopped)
      throw new HostOpError(503, "host_stopping", "This host is stopping");
    dimensions(cols, rows);
    if (
      this.workspaceDeleting(directory) ||
      [...this.fences].some((root) => contains(root, directory))
    )
      throw new HostOpError(
        409,
        "workspace_deleting",
        "Workspace is being deleted",
      );
    if (this.entries.size >= 32 && !named?.previous)
      throw new HostOpError(
        409,
        "terminal_limit",
        "Too many terminals on this host",
      );
    const account = !argv || named ? this.resolveAccount() : undefined;
    const envShell = globalThis.process.env.SHELL;
    const shell =
      account?.shell || (executableShell(envShell) ? envShell : "/bin/sh");
    const id = randomUUID();
    const terminal = {
      id,
      cwd: directory,
      title: named?.script.name ?? basename(directory),
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
    let entry: Entry | undefined;
    const output = (data: string) => {
      const target = entry;
      if (!data || !target || target.closed) return;
      if (target.pending + data.length > 16 * 1024 * 1024) {
        if (running(target.process)) signalSession(target.process, "SIGKILL");
        target.process.terminal?.close();
        return;
      }
      target.pending += data.length;
      screen.write(data, () => {
        target.pending -= data.length;
        if (target.closed) return;
        this.syncFocus(target);
        this.emit(id, { type: "output", data, cursor: ++target.cursor });
      });
    };
    let baseEnv = globalThis.process.env;
    if (named) {
      baseEnv = { ...baseEnv };
      for (const key of Object.keys(baseEnv)) {
        if (
          /^PASEO_(?:PORT|URL|SERVICE_.*_(?:PORT|URL))$/.test(key) ||
          /^(?:OMP|PASEO)_(?:BASE_REF|BRANCH_MODE|CREATE_RESULT)$/.test(key)
        )
          delete baseEnv[key];
      }
    }
    let process: Bun.Subprocess;
    try {
      // csh login mode requires argv[0] to begin with '-' when passing a command.
      const csh = /^(?:tcsh|csh)$/.test(basename(shell));
      process = Bun.spawn(
        named
          ? csh
            ? [shell, "-i", "-c", argv![2]]
            : [shell, "-i", "-l", "-c", argv![2]]
          : (argv ?? (csh ? [shell, "-l"] : [shell, "-i", "-l"])),
        {
          ...(named && csh ? { argv0: `-${basename(shell)}` } : {}),
          detached: true,
          cwd: directory,
          env: createChildProcessEnvironment(
            {
              ...serviceEnv,
              ...(!argv || named
                ? {
                    SHELL: shell,
                    ...(!globalThis.process.env.HOME && account?.home
                      ? { HOME: account.home }
                      : {}),
                  }
                : {}),
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
            },
            baseEnv,
          ),
          terminal: {
            cols,
            rows,
            data: (_pty, bytes) =>
              output(decoder.decode(bytes, { stream: true })),
            exit: () => output(decoder.decode()),
          },
        },
      );
    } catch (error) {
      screen.dispose();
      throw error;
    }
    const created: Entry = {
      terminal,
      screen,
      serializer,
      process,
      script: named?.script,
      cursor: 0,
      closed: false,
      pending: 0,
      viewers: new Map(),
      focusReported: null,
    };
    entry = created;
    this.entries.set(id, created);
    const reply = (data: string) => activePty(created)?.write(data);
    installColorHandlers(screen, reply);
    screen.onData(reply);
    void process.exited.then(() => {
      if (created.stopping) return;
      if (serviceEnv) this.clearViewers(created);
      else this.remove(created);
    });
    if (named?.previous) this.remove(named.previous);
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
    const pty = activePty(entry);
    if (!pty) return;
    if (!entry.screen.modes.sendFocusMode) {
      entry.focusReported = null;
      return;
    }
    const focused = entry.viewers.size > 0;
    if (focused !== entry.focusReported) {
      entry.focusReported = focused;
      pty.write(focused ? "\x1b[I" : "\x1b[O");
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
    if (!activePty(entry)) return;
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
    activePty(this.get(id))?.write(data);
  }
  async resize(id: string, cols: number, rows: number): Promise<void> {
    dimensions(cols, rows);
    const entry = this.get(id);
    const { promise, resolve } = Promise.withResolvers<void>();
    entry.screen.write("", resolve);
    await promise;
    if (entry.closed) throw missing();
    entry.screen.resize(cols, rows);
    activePty(entry)?.resize(cols, rows);
    entry.terminal.cols = cols;
    entry.terminal.rows = rows;
    this.emit(id, { type: "resize", cols, rows, cursor: ++entry.cursor });
  }
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw missing();
    await this.stopEntry(entry);
    this.remove(entry);
  }
  private stopEntry(entry: Entry): Promise<void> {
    entry.stopping ??= this.terminate(entry).finally(() => {
      delete entry.stopping;
    });
    return entry.stopping;
  }
  private async terminate(entry: Entry): Promise<void> {
    const pty = entry.process.terminal;
    if (!running(entry.process)) {
      pty?.close();
      return;
    }
    const tty = signalSession(entry.process, "SIGTERM");
    await Bun.sleep(100);
    signalSession(
      entry.process,
      "SIGKILL",
      pty && !pty.closed ? tty : undefined,
    );
    pty?.close();
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
  }
  private clearViewers(entry: Entry): void {
    for (const timer of entry.viewers.values()) clearTimeout(timer);
    entry.viewers.clear();
  }
  private remove(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    this.clearViewers(entry);
    this.entries.delete(entry.terminal.id);
    // Let any queued snapshot/resize barriers settle before disposing the screen.
    entry.screen.write("", () => entry.screen.dispose());
    this.emit(entry.terminal.id, { type: "closed" });
  }
  fence(directory: string): () => void {
    this.fences.add(directory);
    return () => this.fences.delete(directory);
  }
  inspect(directory: string): Array<{ id: string; cwd: string }> {
    return [...this.entries.values()]
      .filter((e) => running(e.process) && contains(directory, e.terminal.cwd))
      .map((e) => ({ id: e.terminal.id, cwd: e.terminal.cwd }));
  }
  async stopWorkspace(directory: string): Promise<void> {
    const stops: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (!contains(directory, entry.terminal.cwd)) continue;
      const stop = entry.script
        ? this.stopScriptEntry(entry, entry.script)
        : this.close(entry.terminal.id);
      if (stop) stops.push(stop);
    }
    await Promise.all(stops);
  }
  discardWorkspaceScreens(directory: string): void {
    for (const entry of this.entries.values()) {
      if (contains(directory, entry.terminal.cwd) && !running(entry.process)) {
        entry.process.terminal?.close();
        this.remove(entry);
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }
}
