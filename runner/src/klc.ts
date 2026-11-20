#!/usr/bin/env bun
import { StringDecoder } from "node:string_decoder";
import {
  Input,
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@oh-my-pi/pi-tui";
import type { Static } from "@sinclair/typebox";
import type {
  SessionInfoSchema,
  ArchivedSessionInfoSchema,
} from "../../lib/api-contracts/domain";
import type {
  HierarchySnapshot,
  HierarchyWorkspace,
} from "../../lib/project-hierarchy-types";

type Session = Static<typeof SessionInfoSchema>;
type Archive = Static<typeof ArchivedSessionInfoSchema>;
type Target = { id: string; hostId: string; live?: boolean };
type Entry = {
  target: Target;
  title: string;
  detail: string;
  search: string;
  preview?: string;
  archive?: Archive;
  workspace?: HierarchyWorkspace;
};
type Tab = "running" | "registered" | "archived" | "all" | "workspaces";

export function serverUrl(value: string, insecure: boolean): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Server URL must be an HTTP(S) origin without credentials or a path",
    );
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !insecure
  )
    throw new Error(
      "Remote HTTP exposes credentials and terminal data; pass --insecure to allow it",
    );
  return url;
}

export class Api {
  cookie = "";
  constructor(readonly base: URL) {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.base), {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400)
    )
      throw new Error("Authentication required");
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (!response.ok)
      throw new Error(data.error || `Request failed (${response.status})`);
    return data as T;
  }
  async login(password: string): Promise<void> {
    const response = await fetch(new URL("/api/web-auth/session", this.base), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Incorrect password"
          : `Login failed (${response.status})`,
      );
    const cookie = response.headers.get("set-cookie");
    if (!cookie) throw new Error("Login did not return a session cookie");
    this.cookie = cookie.split(";", 1)[0]!;
  }
}

function clean(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
export function matches(entry: Entry, query: string): boolean {
  const haystack = entry.search.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

export function isPickerExit(data: string): boolean {
  return (
    data === "\x1d" ||
    matchesKey(data, "ctrl+]") ||
    matchesKey(data, "ctrl+c") ||
    matchesKey(data, "escape")
  );
}

class Picker implements Component {
  readonly input = new Input();
  selected = 0;
  tab: Tab = "registered";
  constructor(
    readonly entries: Record<Tab, Entry[]>,
    readonly notice: string,
    readonly done: (entry: Entry | null) => void,
  ) {
    this.input.prompt = "Search: ";
  }
  invalidate() {}
  filtered() {
    return this.entries[this.tab].filter((entry) =>
      matches(entry, this.input.getValue()),
    );
  }
  handleInput(data: string) {
    if (isPickerExit(data)) return this.done(null);
    if (matchesKey(data, "ctrl+n")) {
      this.tab = this.tab === "workspaces" ? "registered" : "workspaces";
      this.selected = 0;
      return;
    }
    if (matchesKey(data, "tab")) {
      const tabs: Tab[] = ["running", "registered", "archived", "all"];
      this.tab = tabs[(tabs.indexOf(this.tab) + 1) % tabs.length]!;
      this.selected = 0;
      return;
    }
    const list = this.filtered();
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = Math.min(list.length - 1, this.selected + 1);
      return;
    }
    if (matchesKey(data, "enter")) {
      const entry = list[this.selected];
      if (entry) this.done(entry);
      return;
    }
    this.input.handleInput(data);
    this.selected = 0;
  }
  render(width: number): string[] {
    const list = this.filtered();
    this.selected = Math.max(0, Math.min(this.selected, list.length - 1));
    const rows = process.stdout.rows || 24;
    const inner = Math.max(1, width - 4);
    const count = Math.max(1, Math.floor((rows - 11) / 3));
    const start = Math.max(
      0,
      Math.min(this.selected - count + 1, list.length - count),
    );
    const tabs: Tab[] = ["running", "registered", "archived", "all"];
    const contents = [
      `\x1b[1mKeylime · ${this.tab}\x1b[0m`,
      tabs
        .map((t) => (t === this.tab ? `\x1b[1;36m[${t}]\x1b[0m` : ` ${t} `))
        .join(" "),
      {
        running: "Live terminal sessions",
        registered: "Unarchived sessions registered to a workspace",
        archived: "All archived sessions, including removed workspaces",
        all: "All discovered sessions and live terminals",
        workspaces: "Registered workspaces",
      }[this.tab],
      ...this.input.render(inner),
      "",
    ];
    for (let i = start; i < Math.min(list.length, start + count); i++) {
      const entry = list[i]!;
      contents.push(
        `${i === this.selected ? "\x1b[36m❯\x1b[0m" : " "} \x1b[1m${clean(entry.title)}\x1b[0m`,
      );
      contents.push(`  ${clean(entry.preview || "")}`);
      contents.push(`  \x1b[2m${clean(entry.detail)}\x1b[0m`);
    }
    if (!list.length) contents.push("  No matching entries");
    contents.push(
      "",
      this.notice ? clean(this.notice) : "Tab: filter  Ctrl-N: new session",
      "↑/↓: select  Enter: open  Ctrl-]: quit",
    );
    const border = "─".repeat(Math.max(0, width - 2));
    return [
      `┌${border}┐`,
      ...contents.map((line) => {
        const text = truncateToWidth(line, inner);
        return `│ ${text}\x1b[0m${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`;
      }),
      `└${border}┘`,
    ];
  }
}

async function choose(
  entries: Record<Tab, Entry[]>,
  notice = "",
): Promise<Entry | null> {
  const { promise, resolve } = Promise.withResolvers<Entry | null>();
  const tui = new TUI(new ProcessTerminal());
  let finished = false;
  const finish = (entry: Entry | null) => {
    if (finished) return;
    finished = true;
    process.stdin.off("data", onRawInput);
    tui.stop();
    resolve(entry);
  };
  // Observe Ctrl-] before terminal probe/paste parsing can hold it. Stop after
  // the current stdin dispatch so the TUI's own listener can finish safely.
  const onRawInput = (chunk: Buffer | string) => {
    if (
      (typeof chunk === "string" ? chunk : chunk.toString("utf8")).includes(
        "\x1d",
      )
    )
      queueMicrotask(() => finish(null));
  };
  const picker = new Picker(entries, notice, finish);
  tui.addChild(picker);
  tui.setFocus(picker);
  tui.start();
  process.stdin.prependListener("data", onRawInput);
  return promise;
}

async function password(): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error("A terminal is required to enter the web password");
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let value = "";
  const previous = process.stdin.isRaw;
  process.stderr.write("Keylime password: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const done = (error?: Error) => {
    process.stdin.off("data", onData);
    process.stdin.setRawMode(previous);
    process.stdin.pause();
    process.stderr.write("\n");
    error ? reject(error) : resolve(value);
  };
  const decoder = new StringDecoder("utf8");
  const onData = (chunk: Buffer | string) => {
    for (const char of typeof chunk === "string"
      ? chunk
      : decoder.write(chunk)) {
      if (char === "\u0003") return done(new Error("Cancelled"));
      if (char === "\r" || char === "\n") return done();
      if (char === "\u007f" || char === "\b")
        value = Array.from(value).slice(0, -1).join("");
      else if (char >= " ") value += char;
    }
  };
  process.stdin.on("data", onData);
  return promise;
}

type Inventory = { entries: Record<Tab, Entry[]>; notice: string };
export async function inventory(api: Api, hostId?: string): Promise<Inventory> {
  const scope = hostId ? `?${new URLSearchParams({ hostId })}` : "";
  const [sessions, archives, hosts] = await Promise.all([
    api.request<{ sessions: Session[] }>(`/api/sessions${scope}`),
    api.request<{
      archives: Archive[];
      unavailableHosts: { id: string; label: string }[];
    }>(`/api/sessions/archive${scope}`),
    api.request<{ hosts: { id: string; label: string; status?: string }[] }>(
      "/api/hosts",
    ),
  ]);
  const selectedHosts = hosts.hosts.filter(
    (host) => !hostId || host.id === hostId,
  );
  if (hostId && !selectedHosts.length)
    throw new Error(`Unknown host: ${hostId}`);
  const names = new Map(hosts.hosts.map((host) => [host.id, host.label]));
  const hostName = (id: string) => names.get(id) || id;
  const inventories = await Promise.all(
    selectedHosts.map(async (host) => {
      try {
        const result = await api.request<{ sessionIds: string[] }>(
          `/api/hosts/${encodeURIComponent(host.id)}/terminal-sessions`,
        );
        return { host, ids: result.sessionIds, unavailable: false };
      } catch {
        return { host, ids: [] as string[], unavailable: true };
      }
    }),
  );
  const hierarchies = await Promise.all(
    selectedHosts.map(async (host) => {
      try {
        const snapshot = await api.request<HierarchySnapshot>(
          `/api/hierarchy?host=${encodeURIComponent(host.id)}`,
        );
        return { host, snapshot, unavailable: false };
      } catch {
        return { host, snapshot: null, unavailable: true };
      }
    }),
  );
  const live = new Set(
    inventories.flatMap(({ host, ids }) =>
      ids.map((id) => `${host.id}\0${id}`),
    ),
  );
  const all = sessions.sessions.map((s): Entry => {
    const hostId = s.hostId || "local";
    const title = s.name || s.firstMessage || s.id;
    const detail = `${hostName(hostId)} · ${s.cwd} · ${s.modified} · ${s.messageCount} messages${live.has(`${hostId}\0${s.id}`) ? " · running" : ""}`;
    return {
      target: { id: s.id, hostId, live: live.has(`${hostId}\0${s.id}`) },
      title,
      detail,
      preview: s.name ? s.firstMessage : "",
      search: `${title} ${s.firstMessage} ${detail} ${s.id} ${s.worktreeBranch || ""}`,
    };
  });
  const archived = archives.archives.map((s): Entry => {
    const hostId = s.hostId || "local";
    const title = s.name || s.firstMessage || s.id;
    const detail = `${hostName(hostId)} · ${s.cwd} · archived ${s.archivedAt}${s.restorePending ? " · restore pending" : ""}`;
    return {
      target: { id: s.id, hostId },
      title,
      detail,
      preview: s.name ? s.firstMessage : "",
      search: `${title} ${s.firstMessage} ${detail} ${s.id}`,
      archive: s,
    };
  });
  const workspaces = hierarchies.flatMap(({ host, snapshot }) =>
    (snapshot?.projects ?? []).flatMap((project) =>
      project.workspaces.map((workspace): Entry => {
        const projectName = project.alias || project.name || project.path;
        const title = `${projectName} · ${workspace.name}`;
        const detail = `${hostName(host.id)} · ${workspace.path}${workspace.branch ? ` · ${workspace.branch}` : ""}${workspace.unavailable ? " · unavailable" : ""}`;
        return {
          target: { id: "", hostId: host.id },
          title,
          detail,
          search: `${title} ${detail} ${project.path} ${workspace.id}`,
          workspace,
        };
      }),
    ),
  );
  const registeredIds = new Set(
    hierarchies.flatMap(({ host, snapshot }) =>
      (snapshot?.projects ?? []).flatMap((project) =>
        project.workspaces.flatMap((workspace) =>
          workspace.sessionIds.map((id) => `${host.id}\0${id}`),
        ),
      ),
    ),
  );
  const registered = all.filter((entry) =>
    registeredIds.has(`${entry.target.hostId}\0${entry.target.id}`),
  );
  const running = all.filter((entry) => entry.target.live);
  for (const { host, ids } of inventories)
    for (const id of ids) {
      if (
        !running.some(
          (entry) => entry.target.hostId === host.id && entry.target.id === id,
        )
      ) {
        const detail = `${host.label} · live session`;
        running.push({
          target: { id, hostId: host.id, live: true },
          title: id,
          detail,
          search: `${id} ${detail}`,
        });
      }
    }
  const unavailable = inventories
    .filter((item) => item.unavailable)
    .map((item) => item.host.label);
  const unavailableHierarchies = hierarchies
    .filter((item) => item.unavailable)
    .map((item) => hostName(item.host.id));
  const notices = [
    unavailable.length
      ? `Terminal inventory unavailable: ${unavailable.join(", ")}`
      : "",
    archives.unavailableHosts.length
      ? `Archives unavailable: ${archives.unavailableHosts.map((h) => h.label).join(", ")}`
      : "",
    unavailableHierarchies.length
      ? `Workspaces unavailable: ${unavailableHierarchies.join(", ")}`
      : "",
  ].filter(Boolean);
  return {
    entries: {
      running,
      registered,
      archived,
      all: [
        ...all,
        ...running.filter(
          (entry) =>
            !all.some(
              (item) =>
                item.target.id === entry.target.id &&
                item.target.hostId === entry.target.hostId,
            ),
        ),
        ...archived,
      ],
      workspaces,
    },
    notice: notices.join(" · "),
  };
}

export const terminalCleanup =
  "\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?1016l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b[?6l\x1b[4l\x1b[?7h\x1b[r\x1b>\x1b[?25h\x1b[?1049l";

export function terminalFrameOutput(
  frame: { type: string; data?: string },
  ready: boolean,
): string | undefined {
  // The snapshot serializes the daemon's normal buffer, including scrollback.
  // Leave the picker's alternate screen before replaying it so subsequent TUI
  // history and alternate-screen transitions have the same buffer semantics.
  if (frame.type === "snapshot")
    return terminalCleanup + "\x1b[2J\x1b[H" + (frame.data || "");
  if (frame.type === "output" && ready) return frame.data || "";
  return undefined;
}

// The overlay occupies the last row only until a fresh daemon snapshot restores it.
export function terminalStatus(
  message: string,
  columns: number,
  rows: number,
): string {
  const text = truncateToWidth(clean(message), Math.max(1, columns - 1));
  return `\x1b7\x1b[${Math.max(1, rows)};1H\x1b[0m\x1b[7m${text}\x1b[K\x1b[0m\x1b8`;
}

async function attach(
  api: Api,
  target: Target,
): Promise<{ action: "picker" | "exit"; notice: string }> {
  const url = new URL("/api/terminal/attach", api.base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("hostId", target.hostId);
  url.searchParams.set("sessionId", target.id);
  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRaw = stdin.isRaw;
  let decoder = new StringDecoder("utf8");
  let socket: WebSocket | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let notice = "";
  stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    const send = (message: object) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const onInput = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      const index = text.indexOf("\x1d");
      if (index !== -1) {
        if (index && ready) send({ type: "input", data: text.slice(0, index) });
        cleanup("picker");
        return;
      }
      if (ready && text) send({ type: "input", data: text });
    };
    const cleanup = (action: "picker" | "exit") => {
      if (stopped) return;
      stopped = true;
      clearTimeout(retry);
      clearTimeout(statusTimer);
      send({ type: "detach" });
      socket?.close();
      stdin.off("data", onInput);
      stdout.off("resize", onResize);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdout.write(terminalCleanup);
      resolve({ action, notice });
    };
    const onResize = () => {
      if (ready)
        send({
          type: "resize",
          cols: stdout.columns || 80,
          rows: stdout.rows || 24,
        });
    };
    const onSignal = () => cleanup("exit");
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);
    stdin.on("data", onInput);
    stdout.on("resize", onResize);
    const connect = () => {
      if (stopped) return;
      ready = false;
      // DOM's WebSocket overload hides Bun's documented headers option when lib.dom is enabled.
      const BunWebSocket = WebSocket as unknown as {
        new (url: string | URL, options: Bun.WebSocketOptions): WebSocket;
      };
      socket = new BunWebSocket(url, {
        headers: api.cookie ? { cookie: api.cookie } : {},
      });
      socket.onopen = () =>
        send({
          type: "hello",
          version: 1,
          cols: stdout.columns || 80,
          rows: stdout.rows || 24,
        });
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as {
            type: string;
            data?: string;
            message?: string;
            code?: number;
          };
          const output = terminalFrameOutput(frame, ready);
          if (output !== undefined) stdout.write(output);
          if (frame.type === "snapshot") {
            ready = true;
            notice = "";
            clearTimeout(statusTimer);
          } else if (frame.type === "notice") {
            notice = clean(frame.message || "");
            stdout.write(
              terminalStatus(notice, stdout.columns || 80, stdout.rows || 24),
            );
            clearTimeout(statusTimer);
            // A new snapshot restores the row without guessing what the PTY drew there.
            statusTimer = setTimeout(() => {
              if (!stopped) socket?.close();
            }, 3000);
          } else if (frame.type === "error") {
            notice = clean(frame.message || "Terminal error");
            cleanup("picker");
          } else if (frame.type === "exit") cleanup("picker");
        } catch {
          cleanup("picker");
        }
      };
      socket.onclose = () => {
        if (!stopped) {
          ready = false;
          decoder = new StringDecoder("utf8");
          stdout.write(
            terminalStatus(
              "Disconnected; reconnecting (Ctrl-] to leave)",
              stdout.columns || 80,
              stdout.rows || 24,
            ),
          );
          retry = setTimeout(connect, 1000);
        }
      };
      socket.onerror = () => {};
    };
    connect();
  });
}

async function main() {
  const args = process.argv.slice(2);
  let base = process.env.KEYLIME_URL || "http://127.0.0.1:30177";
  let insecure = false;
  let id: string | undefined;
  let hostId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: klc [--url URL] [--insecure] [--host HOST] [SESSION_ID]\n\nConnect to Keylime, select a session or workspace, and attach. Ctrl-] returns to the picker.\nA SESSION_ID without --host targets the local host.\nKEYLIME_URL sets the server URL (default http://127.0.0.1:30177).",
      );
      return;
    }
    if (arg === "--url" || arg === "--host") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--url") base = value;
      else hostId = value;
    } else if (arg === "--insecure") insecure = true;
    else if (arg?.startsWith("-") || id)
      throw new Error(`Unexpected argument: ${arg}`);
    else id = arg;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("klc requires an interactive terminal");
  const api = new Api(serverUrl(base, insecure));
  const targetHost = hostId ?? "local";
  const initialInventory = async () =>
    id
      ? {
          sessionIds: (
            await api.request<{ sessionIds: string[] }>(
              `/api/hosts/${encodeURIComponent(targetHost)}/terminal-sessions`,
            )
          ).sessionIds,
        }
      : await inventory(api, hostId);
  let snapshot: Inventory | { sessionIds: string[] };
  try {
    snapshot = await initialInventory();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Authentication required"
    )
      throw error;
    if (process.env.KEYLIME_PASSWORD !== undefined) {
      await api.login(process.env.KEYLIME_PASSWORD);
    } else {
      for (;;) {
        try {
          await api.login(await password());
          break;
        } catch (loginError) {
          if (
            !(loginError instanceof Error) ||
            loginError.message !== "Incorrect password"
          )
            throw loginError;
          console.error(loginError.message);
        }
      }
    }
    snapshot = await initialInventory();
  }
  let target: Target | undefined = id
    ? {
        id,
        hostId: targetHost,
        live: "sessionIds" in snapshot && snapshot.sessionIds.includes(id),
      }
    : undefined;
  let notice = "";
  let pickerSnapshot = "entries" in snapshot ? snapshot : undefined;
  for (;;) {
    if (!target) {
      const picker = pickerSnapshot ?? (await inventory(api, hostId));
      pickerSnapshot = undefined;
      const entry = await choose(picker.entries, notice || picker.notice);
      notice = "";
      if (!entry) return;
      try {
        if (entry.archive) {
          if (entry.archive.restorePending)
            throw new Error(
              "This archive has a pending restore and cannot be opened",
            );
          const restored = await api.request<{ sessionId: string }>(
            "/api/sessions/archive",
            { key: entry.archive.key, hostId: entry.target.hostId },
          );
          target = { ...entry.target, id: restored.sessionId };
        } else if (entry.workspace) {
          const created = await api.request<{ sessionId: string }>(
            "/api/agent/new",
            {
              type: "ensure_session",
              cwd: entry.workspace.path,
              hostId: entry.target.hostId,
            },
          );
          target = { ...entry.target, id: created.sessionId, live: true };
        } else target = entry.target;
      } catch (error) {
        notice = error instanceof Error ? error.message : String(error);
        continue;
      }
    }
    try {
      if (!target.live)
        await api.request(
          `/api/agent/${encodeURIComponent(target.id)}?${new URLSearchParams({ hostId: target.hostId })}`,
          { type: "get_state" },
        );
      const attached = await attach(api, target);
      if (attached.action === "exit") return;
      notice = attached.notice;
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }
    target = undefined;
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(
      `klc: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
