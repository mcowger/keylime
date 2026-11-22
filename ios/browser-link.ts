import type { components } from "./generated/browser-link";
import { normalizeOrigin } from "./keylime-http";
import {
  nativeRequest,
  openNativeWebSocket,
  type NativeWebSocket,
} from "./native-network";

type Schemas = components["schemas"];
export type BrowserChannel = Schemas["BrowserSubscribe"]["channel"];
export type BrowserCommand = Schemas["BrowserCommand"]["command"];
export type BrowserReply = Schemas["BrowserReply"];
export type BrowserLinkStatus =
  "connecting" | "open" | "disconnected" | "unauthorized";
export type BrowserLinkHandlers = {
  onEvent(data: unknown): void;
  /** Called for every fresh server subscription, including after a resync. */
  onOpen?(): void;
  onEnd?(reason: string): void;
};
export type BrowserLinkOptions = {
  onStatus?(status: BrowserLinkStatus): void;
};

/** An interrupted command may have run. Reconcile its session before issuing another mutation. */
export class BrowserLinkError extends Error {
  constructor(
    readonly code: "transport_unavailable" | "transport_lost",
    message: string,
  ) {
    super(message);
    this.name = "BrowserLinkError";
  }
}

type Subscription = {
  id: string;
  channel: BrowserChannel;
  handlers: BrowserLinkHandlers;
  retry?: ReturnType<typeof setTimeout>;
};
type PendingCommand = {
  rid: string;
  session: string;
  hostId: string;
  command: BrowserCommand;
  sentAt: number | null;
  timer?: ReturnType<typeof setTimeout>;
  resolve(reply: BrowserReply): void;
  reject(error: BrowserLinkError): void;
};
type QueueItem = {
  json: string;
  at: number;
  joined?: string;
  command?: PendingCommand;
};
type Sent = { seq: number; line: string; bytes: number };

const PIECE_BYTES = 256 * 1024;
const WINDOW_BYTES = 2 * PIECE_BYTES;
const DEDUPE_MS = 600_000;
const REPEATABLE: Record<string, true> = {
  predict_word: true,
  predict_word_feedback: true,
  set_host_tools: true,
  set_host_uri_schemes: true,
  outbox_add: true,
  outbox_remove: true,
  outbox_scope: true,
};

// Hermes does not universally provide TextEncoder. Count UTF-8 bytes without a native dependency.
function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function withSeq(json: string, seq: number): string {
  return `${json.slice(0, -1)},"seq":${seq}}`;
}

/** One owner-bound, multiplexed Browser Link using the native origin-isolated cookie store. */
export class BrowserLink {
  private readonly origin: string;
  private readonly options: BrowserLinkOptions;
  private ws: NativeWebSocket | null = null;
  private active = false;
  private welcomed = false;
  private token: string | null = null;
  private serverId: string | null = null;
  private downSeq = 0;
  private upSeq = 0;
  private sentSeq = 0;
  private unacked = 0;
  private outbox: Sent[] = [];
  private queues = new Map<string, QueueItem[]>();
  private partialKey: string | null = null;
  private parts: string[] | null = null;
  private partsAt = 0;
  private subscriptions = new Map<string, Subscription>();
  private pending = new Map<string, PendingCommand>();
  private nextSub = 1;
  private nextCommand = 1;
  private readonly clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  private retryDelay = 1000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastFrame = 0;
  private lastAckProgress = 0;
  private diagnosis: AbortController | null = null;

  constructor(origin: string, options: BrowserLinkOptions = {}) {
    this.origin = normalizeOrigin(origin);
    this.options = options;
  }

  connect(): void {
    this.active = true;
    if (!this.ws && !this.retryTimer) this.dial();
  }

  /** Wake after foreground/network recovery, retaining the resume token and outstanding frames. */
  reconnect(): void {
    this.active = true;
    this.retryDelay = 1000;
    this.disconnectSocket();
    this.dial();
  }

  /** Stops this connection permanently until connect() is called again. */
  close(): void {
    this.active = false;
    this.diagnosis?.abort();
    this.diagnosis = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    this.stopSocketTimers();
    ws?.close(1000, "Browser link closed");
    for (const sub of this.subscriptions.values()) clearTimeout(sub.retry);
    this.subscriptions.clear();
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(
        new BrowserLinkError(
          command.sentAt === null ? "transport_unavailable" : "transport_lost",
          command.sentAt === null
            ? "Command was not sent."
            : "Command may have run; reconcile before retrying.",
        ),
      );
    }
    this.pending.clear();
    this.token = null;
    this.serverId = null;
    this.resetTransport();
    this.status("disconnected");
  }

  subscribe(
    channel: BrowserChannel,
    handlers: BrowserLinkHandlers,
  ): () => void {
    const id = `s${this.nextSub++}`;
    const sub: Subscription = { id, channel, handlers };
    this.subscriptions.set(id, sub);
    if (this.token !== null) this.queueSubscription(sub);
    this.connect();
    return () => {
      if (!this.subscriptions.delete(id)) return;
      clearTimeout(sub.retry);
      if (this.token !== null) this.queue(id, { type: "unsub", id });
    };
  }

  command(
    session: string,
    hostId: string,
    command: BrowserCommand,
  ): Promise<BrowserReply> {
    const rid = `${this.clientId}-${this.nextCommand++}`;
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = {
        rid,
        session,
        hostId,
        command,
        sentAt: null,
        resolve,
        reject,
      };
      this.pending.set(rid, pending);
      pending.timer = setTimeout(() => {
        if (pending.sentAt !== null || !this.pending.delete(rid)) return;
        // A partial command cannot run until its final piece arrives. Keep already
        // numbered pieces for replay, but remove the remaining queued pieces.
        for (const [key, items] of this.queues) {
          const remaining = items.filter((item) => item.command !== pending);
          if (remaining.length === items.length) continue;
          if (items[0].command === pending && this.partialKey === key)
            this.partialKey = null;
          if (remaining.length) this.queues.set(key, remaining);
          else this.queues.delete(key);
        }
        reject(
          new BrowserLinkError(
            "transport_unavailable",
            "Command was not sent.",
          ),
        );
      }, 15_000);
      if (this.token !== null) this.queueCommand(pending);
      this.connect();
    });
  }

  private status(status: BrowserLinkStatus): void {
    this.options.onStatus?.(status);
  }

  private dial(): void {
    if (!this.active || this.ws) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.diagnosis?.abort();
    this.diagnosis = null;
    this.status("connecting");
    const url = `${this.origin.replace(/^http/, "ws")}/api/events/link`;
    let ws: NativeWebSocket;
    try {
      ws = openNativeWebSocket(url);
    } catch {
      this.failedDial();
      return;
    }
    this.ws = ws;
    this.welcomed = false;
    this.lastFrame = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws) return;
      const now = Date.now();
      if (
        now - this.lastFrame >= 30_000 ||
        (this.unacked > 0 && now - this.lastAckProgress >= 30_000)
      ) {
        this.dropAndRetry();
      } else if (ws.readyState === 1) {
        this.sendControl({ type: "ping", c: now });
      }
    }, 15_000);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.sendControl({
        type: "hello",
        v: 1,
        token: this.token,
        ack: this.downSeq,
      });
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        if (typeof event.data !== "string")
          throw new Error("Non-text browser link frame");
        this.lastFrame = Date.now();
        this.receive(JSON.parse(event.data));
      } catch {
        // Never resume a partially applied or malformed message.
        this.token = null;
        this.dropAndRetry();
      }
    };
    ws.onerror = () => {
      /* React Native delivers close after an error. */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopSocketTimers();
      this.welcomed = false;
      this.failedDial();
    };
  }

  private stopSocketTimers(): void {
    clearTimeout(this.flushTimer);
    clearTimeout(this.ackTimer);
    clearInterval(this.heartbeatTimer);
    this.flushTimer = undefined;
    this.ackTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  private disconnectSocket(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.diagnosis?.abort();
    this.diagnosis = null;
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    this.stopSocketTimers();
    // 4000 detaches rather than disposing the server's resumable link.
    ws?.close(4000, "Reconnecting");
  }

  private dropAndRetry(): void {
    this.disconnectSocket();
    this.failedDial();
  }

  private failedDial(): void {
    if (!this.active) return;
    this.status("disconnected");
    // Upgrade failures have no HTTP status. A single isolated request distinguishes expired auth.
    const controller = new AbortController();
    this.diagnosis = controller;
    let unauthorized = false;
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    const probe = nativeRequest(this.origin, "/api/events/link", {
      signal: controller.signal,
    })
      .then((response) => {
        unauthorized = response.status === 401;
      })
      .catch(() => {});
    void Promise.race([probe, timeout]).then(() => {
      if (this.diagnosis !== controller) return;
      controller.abort();
      this.diagnosis = null;
      if (!this.active) return;
      if (unauthorized) {
        this.status("unauthorized");
        return;
      }
      const delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.dial();
      }, delay);
    });
  }

  private sendControl(message: object): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  private receive(value: unknown): void {
    if (!record(value) || typeof value.type !== "string")
      throw new Error("Invalid frame");
    if (value.type === "welcome") return this.welcome(value);
    if (!this.welcomed) throw new Error("Frame before welcome");
    if (value.type === "ack") {
      if (!count(value.ack) || value.ack > this.upSeq)
        throw new Error("Invalid ack");
      this.ackUp(value.ack);
      this.flush();
      return;
    }
    if (value.type === "ping") {
      this.sendControl({ type: "ping", c: Date.now() });
      return;
    }
    if (value.type === "pong") return;
    if (!count(value.seq) || value.seq === 0)
      throw new Error("Invalid sequence");
    if (value.seq > this.downSeq + 1) throw new Error("Sequence gap");
    if (value.seq > this.downSeq) {
      if (value.type === "part") this.receivePart(value);
      else this.apply(value);
      this.downSeq = value.seq;
    }
    // Acknowledge only after the frame has been applied. Duplicate frames still need an ack.
    this.ackTimer ??= setTimeout(() => {
      this.ackTimer = undefined;
      this.sendControl({ type: "ack", ack: this.downSeq });
    }, 16);
  }

  private receivePart(part: Record<string, unknown>): void {
    if (
      !count(part.at) ||
      typeof part.data !== "string" ||
      typeof part.end !== "boolean"
    ) {
      throw new Error("Invalid part");
    }
    if (part.at === 0) {
      this.parts = [];
      this.partsAt = 0;
    }
    if (!this.parts || part.at !== this.partsAt || this.parts.length >= 512)
      throw new Error("Invalid part offset");
    this.parts.push(part.data);
    this.partsAt += part.data.length;
    if (part.end) {
      const line: unknown = JSON.parse(this.parts.join(""));
      this.parts = null;
      this.partsAt = 0;
      if (!record(line)) throw new Error("Invalid joined frame");
      this.apply(line);
    }
  }

  private apply(value: Record<string, unknown>): void {
    if (value.type === "e") {
      if (typeof value.name !== "string") throw new Error("Invalid event");
      if (value.name === "mux") {
        const control = value.data;
        if (!record(control) || typeof control.sub !== "string") return;
        const sub = this.subscriptions.get(control.sub);
        if (!sub) return;
        if (control.type === "open") {
          clearTimeout(sub.retry);
          sub.retry = undefined;
          sub.handlers.onOpen?.();
        } else if (control.type === "end") {
          sub.handlers.onEnd?.(
            typeof control.reason === "string" ? control.reason : "ended",
          );
          clearTimeout(sub.retry);
          sub.retry = setTimeout(() => {
            sub.retry = undefined;
            if (this.subscriptions.get(sub.id) === sub && this.token !== null)
              this.queueSubscription(sub);
          }, 3000);
        } else if (control.type === "refused") {
          this.subscriptions.delete(sub.id);
          clearTimeout(sub.retry);
          sub.handlers.onEnd?.(
            typeof control.error === "string"
              ? control.error
              : "Subscription refused",
          );
        }
      } else this.subscriptions.get(value.name)?.handlers.onEvent(value.data);
    } else if (value.type === "reply" && typeof value.rid === "string") {
      const command = this.pending.get(value.rid);
      if (command) {
        this.pending.delete(value.rid);
        clearTimeout(command.timer);
        command.resolve(value as unknown as BrowserReply);
      }
    }
  }
  private welcome(value: Record<string, unknown>): void {
    if (
      this.welcomed ||
      value.v !== 1 ||
      typeof value.token !== "string" ||
      typeof value.serverId !== "string" ||
      typeof value.resumed !== "boolean" ||
      !count(value.ack)
    ) {
      throw new Error("Invalid welcome");
    }
    const resumed =
      value.resumed && this.token !== null && value.token === this.token;
    const sameServer =
      this.serverId === null || this.serverId === value.serverId;
    if (resumed) {
      if (value.ack > this.upSeq) throw new Error("Invalid resume ack");
      this.ackUp(value.ack);
      this.sentSeq = value.ack;
      this.unacked = 0;
    } else {
      this.resetTransport();
    }
    this.token = value.token;
    this.serverId = value.serverId;
    this.welcomed = true;
    this.retryDelay = 1000;
    this.lastAckProgress = Date.now();
    if (!resumed) {
      for (const sub of this.subscriptions.values()) {
        clearTimeout(sub.retry);
        sub.retry = undefined;
        this.queueSubscription(sub);
      }
      for (const command of this.pending.values()) {
        const repeatable =
          command.command.type.startsWith("get_") ||
          REPEATABLE[command.command.type] === true;
        if (
          command.sentAt === null ||
          repeatable ||
          (sameServer && Date.now() - command.sentAt < DEDUPE_MS)
        ) {
          this.queueCommand(command);
        } else {
          this.pending.delete(command.rid);
          clearTimeout(command.timer);
          command.reject(
            new BrowserLinkError(
              "transport_lost",
              "Command may have run; reconcile before retrying.",
            ),
          );
        }
      }
    }
    this.status("open");
    this.flush();
  }

  private resetTransport(): void {
    this.downSeq = 0;
    this.upSeq = 0;
    this.sentSeq = 0;
    this.unacked = 0;
    this.outbox = [];
    this.queues.clear();
    this.partialKey = null;
    this.parts = null;
    this.partsAt = 0;
  }

  private queueSubscription(sub: Subscription): void {
    this.queue(sub.id, { type: "sub", id: sub.id, channel: sub.channel });
  }

  private queueCommand(command: PendingCommand): void {
    this.queue(
      `cmd:${command.hostId}:${command.session}`,
      {
        type: "cmd",
        rid: command.rid,
        session: command.session,
        hostId: command.hostId,
        command: command.command,
      },
      command,
    );
  }

  private queue(key: string, message: object, command?: PendingCommand): void {
    const items = this.queues.get(key) ?? [];
    items.push({ json: JSON.stringify(message), at: 0, command });
    this.queues.set(key, items);
    this.flush();
  }

  private ackUp(ack: number): void {
    let removed = 0;
    while (removed < this.outbox.length && this.outbox[removed].seq <= ack) {
      const sent = this.outbox[removed++];
      if (sent.seq <= this.sentSeq)
        this.unacked = Math.max(0, this.unacked - sent.bytes);
    }
    if (removed) {
      this.outbox.splice(0, removed);
      this.lastAckProgress = Date.now();
    }
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const ws = this.ws;
    if (!ws || !this.welcomed || ws.readyState !== 1) return;
    const room = () =>
      this.unacked < WINDOW_BYTES && ws.bufferedAmount < WINDOW_BYTES;
    const send = (sent: Sent) => {
      if (this.unacked === 0) this.lastAckProgress = Date.now();
      ws.send(sent.line);
      this.sentSeq = sent.seq;
      this.unacked += sent.bytes;
    };
    for (const sent of this.outbox) {
      if (sent.seq <= this.sentSeq) continue;
      if (!room()) break;
      send(sent);
    }
    if (this.outbox.some((sent) => sent.seq > this.sentSeq)) {
      if (ws.bufferedAmount >= WINDOW_BYTES)
        this.flushTimer = setTimeout(() => this.flush(), 16);
      return;
    }
    while (room() && this.queues.size) {
      const entry = this.nextUnit();
      if (!entry) break;
      this.outbox.push(entry.sent);
      if (entry.done && entry.command && entry.command.sentAt === null) {
        entry.command.sentAt = Date.now();
        clearTimeout(entry.command.timer);
      }
      send(entry.sent);
    }
    if (this.queues.size && ws.bufferedAmount >= WINDOW_BYTES) {
      this.flushTimer = setTimeout(() => this.flush(), 16);
    }
  }

  private nextUnit(): {
    sent: Sent;
    done: boolean;
    command?: PendingCommand;
  } | null {
    for (const [key, queue] of this.queues) {
      const item = queue[0];
      const seq = ++this.upSeq;
      let line = withSeq(item.json, seq);
      let done = true;
      if (item.at > 0 || byteLength(line) > PIECE_BYTES) {
        if (this.partialKey !== null && this.partialKey !== key) {
          this.upSeq--;
          continue;
        }
        this.partialKey = key;
        item.joined ??= withSeq(item.json, 0);
        let n = Math.min(item.joined.length - item.at, PIECE_BYTES);
        for (;;) {
          line = JSON.stringify({
            type: "part",
            seq,
            at: item.at,
            end: item.at + n >= item.joined.length,
            data: item.joined.slice(item.at, item.at + n),
          });
          const size = byteLength(line);
          if (size <= PIECE_BYTES) break;
          n = Math.max(1, Math.floor((n * PIECE_BYTES) / size) - 1);
        }
        item.at += n;
        done = item.at >= item.joined.length;
        if (done) this.partialKey = null;
      }
      if (done) queue.shift();
      this.queues.delete(key);
      if (queue.length) this.queues.set(key, queue);
      return {
        sent: { seq, line, bytes: byteLength(line) },
        done,
        command: item.command,
      };
    }
    return null;
  }
}
