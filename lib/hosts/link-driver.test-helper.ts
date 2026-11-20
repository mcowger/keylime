// The daemon end of a host link, driven by hand, for main-server tests that
// need a linked host without running `keylime host`. Not a test file itself.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { LinkSocketData } from "./hub.ts";
import type { DownMessage, HelloChannel } from "./link-protocol.ts";

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown | Promise<unknown>;
type Handlers = Record<string, Handler>;
type MessageHandler = (message: DownMessage) => unknown | Promise<unknown>;
type LinkOptions = {
  channels?: HelloChannel[];
  hello?: Record<string, unknown>;
};

const hub = await import("./hub.ts");
const {
  encodeBlobFrame,
  HostOpError,
  LINK_PROTOCOL_VERSION,
  SESSION_OP_PARAMS,
} = await import("./link-protocol.ts");
const { ProjectPathError } = await import("../project-registry.ts");
const { createHost, rotateLocalHostToken } = await import("./registry.ts");

const URL_BASE = "http://main.test/api/hosts/link";

/** One link WebSocket: its server end as Bun hands it to the hub (`LinkSocket`), and the daemon's view of it (what the
 * hub sent, in order, and `closed` once either side closed it). A close reaches the hub's `close` in a microtask. */
class TestSocket {
  data: LinkSocketData;
  frames: (string | Uint8Array)[] = [];
  closed: { code: number; reason: string } | null = null;
  waiters: (() => void)[] = [];
  constructor(data: LinkSocketData) {
    this.data = data;
  }

  send(data: string | Uint8Array) {
    if (this.closed) return 0;
    this.frames.push(data);
    this.wake();
    return data.length;
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
    this.wake();
    queueMicrotask(() => hub.hostLinkSocket.close(this));
  }

  terminate() {
    this.close(1006);
  }

  wake() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  /** The daemon sends one frame: a string, or bytes for a binary frame. */
  frame(data: string | Uint8Array) {
    hub.hostLinkSocket.message(this, data);
  }

  /** The hub's next message; null once the socket is closed and every frame before the close was read. */
  async next(): Promise<DownMessage | null> {
    for (;;) {
      if (this.frames.length > 0) {
        const frame = this.frames.shift()!;
        return JSON.parse(
          typeof frame === "string" ? frame : new TextDecoder().decode(frame),
        ) as DownMessage;
      }
      if (this.closed) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Upgrade a link with `token`, as Bun's route would: `response` is the hub's refusal (no socket), else undefined. */
export function upgradeSocket(token: string) {
  let socket: TestSocket | null = null;
  const request = new Request(URL_BASE, {
    headers: { authorization: `Bearer ${token}`, upgrade: "websocket" },
  });
  const response = hub.handleLinkUpgrade(request, (data) => {
    socket = new TestSocket(data);
    return true;
  });
  return { response, socket: socket as TestSocket | null };
}

/** Register a host and link it. `channels`: the hello's still-running children; `hello`: fields to override. */
export async function linkHost(
  label: string,
  { channels = [], hello = {} }: LinkOptions = {},
) {
  const { host, token } = createHost(label);
  const link = new LinkDriver(host.id, token);
  await link.dial({ channels, hello });
  return link;
}

/** Link this machine's daemon: the reserved `local` record. */
export async function linkLocalHost({
  channels = [],
  workspaceOps = [],
}: { channels?: HelloChannel[]; workspaceOps?: string[] } = {}) {
  const link = new LinkDriver("local", rotateLocalHostToken());
  await link.dial({ channels, hello: { workspaceOps } });
  return link;
}

/** Link this machine's daemon and run its real session ops on the current agent dir in this
 * process, as `keylime host` does; `ops` adds or replaces ops (spawn, say). readMedia bytes do not go as a blob. */
export async function linkLocalDaemon(
  ops: Handlers = {},
  onMessage?: MessageHandler,
) {
  const { localHost } = await import("./local-host.ts");
  const { sessionOps } = await import("./session-ops.ts");
  const { WORKSPACE_OP_PARAMS } = await import("../workspace-types.ts");
  const { createWorkspaceService } = await import("./workspace-ops.ts");
  const { grantWorkspaceRoot } = await import("./workspace-roots.ts");
  const { StagedUploads } = await import("./uploads.ts");
  const link = await linkLocalHost({
    workspaceOps: Object.keys(WORKSPACE_OP_PARAMS),
  });
  const uploads = new StagedUploads(
    (ack) => void link.post({ type: "upload_ack", ...ack }),
  );
  const workspace = createWorkspaceService(
    uploads,
    (id, epoch, event) =>
      void link.post({ type: "workspace_file", id, epoch, event }),
  );
  void link
    .serve(
      {
        ...Object.fromEntries(
          Object.entries(SESSION_OP_PARAMS).map(([op, params]) => [
            op,
            (args: Args) =>
              (
                sessionOps[op as keyof typeof sessionOps] as (
                  ...values: never[]
                ) => unknown
              )(...(params.map((name) => args[name]) as never[])),
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(WORKSPACE_OP_PARAMS).map(([op, params]) => [
            op,
            async (args: Args) => {
              const result = await (
                workspace.ops[op as keyof typeof workspace.ops] as (
                  ...values: never[]
                ) => Promise<{ ok: boolean; value?: unknown }>
              )(...(params.map((name) => args[name]) as never[]));
              return op === "readFileChunk" && result.ok
                ? result.value
                : result;
            },
          ]),
        ),
        validateCwd: async ({ path }) => {
          const result = await sessionOps.validateCwd(path as string);
          if (result.ok) grantWorkspaceRoot(result.value.cwd);
          return result;
        },
        sessionFileExists: ({ path }) =>
          localHost.sessionFileExists(path as string),
        uploadStart: (args) =>
          uploads.start(args as Parameters<typeof uploads.start>[0]),
        uploadAbort: ({ id }) => uploads.abort(id as string),
        invalidateSessionLists: ({ path }) =>
          localHost.invalidateSessionLists(path as string) ?? null,
        ...ops,
      },
      onMessage,
    )
    .finally(() => workspace.stop());
  return Object.assign(link, { workspace, uploads });
}

/** The `res` error `keylime host` sends for an op that threw (daemon.ts `answer`). */
function opFailure(error: unknown) {
  if (error instanceof HostOpError)
    return { status: error.status, code: error.code, message: error.message };
  // A rejected project path is a bad request.
  if (error instanceof ProjectPathError)
    return { status: 400, code: error.code, message: error.message };
  return {
    status: 500,
    code: "host_op_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Poll `predicate` until it holds; fails after 5 s instead of hanging the test. */
export async function until(predicate: () => unknown, what: string) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A linked host's `listSessions` entry for session `id`. */
export function listedSession(id: string, cwd = "/w") {
  return {
    path: `/remote/sessions/${id}.jsonl`,
    id,
    cwd,
    created: "c",
    modified: "m",
    messageCount: 1,
    firstMessage: "hi",
  };
}

/** An omp child behind `link` that is past its hello: answers each `cmd` on its channel with a `res`,
 * get_state as session `sessionId` plus `state`; a cmd whose op is `fail` is refused. Other frames
 * (ui_response, host_tool_result, …) get no reply, as omp's runner sends none. */
export function ompChild(
  link: LinkDriver,
  sessionId: string,
  {
    state = {},
    fail = null,
  }: { state?: Record<string, unknown>; fail?: string | null } = {},
) {
  return async (message: DownMessage) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    if (command.t !== "cmd") return;
    const data =
      command.op === "get_state"
        ? {
            sessionId,
            sessionFile: `/remote/sessions/${sessionId}.jsonl`,
            isStreaming: false,
            isCompacting: false,
            ...state,
          }
        : {};
    const outcome =
      command.op === fail
        ? { ok: false, error: `${fail} failed` }
        : { ok: true, data };
    await link.post({
      type: "stdout",
      ch: message.ch,
      line: JSON.stringify({ t: "res", id: command.id, ...outcome }),
    });
  };
}

export class LinkDriver {
  id: string;
  token: string;
  ack: number;
  upSeq: number;
  acked: number;
  socket!: TestSocket;
  welcome!: Extract<DownMessage, { type: "welcome" }>;

  constructor(id: string, token: string) {
    this.id = id;
    this.token = token;
    /** Highest downlink seq this side has applied. */
    this.ack = 0;
    this.upSeq = 0;
    /** The hub's last `ack`: the highest uplink seq it applied. */
    this.acked = 0;
    this.socket = null!;
  }

  /** Open a socket and send its hello (`hello` overrides its fields); resolves after its welcome, kept as `welcome`. */
  async dial({
    channels = [],
    ack = this.ack,
    hello: overrides = {},
  }: LinkOptions & { ack?: number } = {}) {
    const { response, socket } = upgradeSocket(this.token);
    assert.equal(response, undefined);
    assert.ok(socket);
    this.socket = socket;
    const hello = {
      type: "hello",
      v: LINK_PROTOCOL_VERSION,
      ompVersion: "14.0.0",
      platform: "linux",
      home: "/home/u",
      autoApproveExtension: false,
      ack,
      channels,
      ...overrides,
    };
    socket.frame(`${JSON.stringify(hello)}\n`);
    const welcome = await this.next();
    assert.ok(welcome?.type === "welcome");
    this.welcome = welcome;
  }

  /** Next message from the hub that is not a ping or an ack; null once the socket closed. */
  async next() {
    for (;;) {
      const message = await this.socket.next();
      if (message?.type === "ping") continue;
      if (message?.type === "ack") {
        this.acked = message.ack;
        continue;
      }
      if (message && "seq" in message && typeof message.seq === "number")
        this.ack = Math.max(this.ack, message.seq);
      return message;
    }
  }

  /** Send uplink messages in one frame after its ack line, as the daemon does; each gets the next uplink seq. */
  async post(...messages: ({ type: string } & Record<string, unknown>)[]) {
    const lines = [
      { type: "ack", ack: this.ack },
      ...messages.map((message) => ({ ...message, seq: ++this.upSeq })),
    ];
    // Closed under the daemon (a drop, a freeze, a newer link): the frame never goes out. A real daemon would resend it
    // after its next welcome; this driver does not.
    if (this.socket.closed) return;
    const before = this.socket.frames.length;
    this.socket.frame(
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    // The hub answers each frame it applied with exactly one ack, sent before message() returns.
    const acks = this.socket.frames
      .slice(before)
      .filter(
        (sent) =>
          JSON.parse(
            typeof sent === "string" ? sent : new TextDecoder().decode(sent),
          ).type === "ack",
      );
    assert.equal(
      acks.length,
      1,
      "the hub did not answer the frame with one ack",
    );
  }

  /** Answer one `req` with `value`: bytes go in a binary frame ahead of the `res`, anything else inline. */
  async answer(req: Extract<DownMessage, { type: "req" }>, value: unknown) {
    if (value instanceof Uint8Array) {
      this.socket.frame(encodeBlobFrame(req.id, value));
      return this.post({
        type: "res",
        id: req.id,
        ok: true,
        blob: { bytes: value.byteLength },
      });
    }
    return this.post({ type: "res", id: req.id, ok: true, result: value });
  }

  /** Answer every `req` from `ops[op](args)` (a throw answers failed, as the daemon does) until the socket closes; other messages go to `onMessage`. */
  serve(ops: Handlers, onMessage: MessageHandler = () => {}) {
    // A fake daemon's supplied session list is complete unless the test overrides the strict op to model an old or failing
    // daemon. Real daemon helpers already supply their actual strict scanner through SESSION_OP_PARAMS.
    const handlers: Handlers = {
      hostSettingsGet: () => ({
        autoResumeSessions: false,
        agentToolsEnabled: false,
        uploadRetentionDays: 30,
      }),
      modelsList: () => ({
        models: {},
        modelList: [],
        defaultModel: null,
        thinkingLevels: {},
        anthropicSlowMode: false,
      }),
      ...(ops.listSessions
        ? {
            listSessionIdsForRestore: async (args: Args) =>
              ((await ops.listSessions(args)) as { id: string }[]).map(
                (session) => session.id,
              ),
          }
        : {}),
      ...ops,
    };
    return (async () => {
      for (
        let message = await this.next();
        message;
        message = await this.next()
      ) {
        if (message.type !== "req" || !handlers[message.op]) {
          await onMessage(message);
          continue;
        }
        let value;
        try {
          value = await handlers[message.op](message.args as Args);
        } catch (error) {
          await this.post({
            type: "res",
            id: message.id,
            ok: false,
            error: opFailure(error),
          });
          continue;
        }
        await this.answer(message, value);
      }
    })();
  }

  /** The daemon's socket goes away (network drop, daemon stop). */
  drop() {
    this.socket.close(1006);
  }
}
