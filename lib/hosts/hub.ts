import type { TerminalEvent } from "../terminal-types";
import {
  TerminalAttachServerSchema,
  type TerminalAttachServer,
} from "../api-contracts/terminal-attach";
// Main-server end of the host link (spec "Link protocol"): accepts `keylime
// host` daemons on /api/hosts/link and exposes each linked machine as a
// `RemoteHost`. Everything a daemon sends is untrusted input.
// No `next/*` or `@/` imports.
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  HostModelsSchema,
  ChatRolesSchema,
  type ChatRoles,
  HostSettingsSchema,
  type HostModels,
  type HostSettings,
  type HostSettingsPatch,
} from "../api-contracts/configuration-models";
import {
  UsageReportSchema,
  type UsageQueryOptions,
  type UsageReport,
} from "../api-contracts/usage-models";
import type {
  HostSnapshot,
  LinkedHostRow,
  LocalHostRow,
} from "../api-contracts/http-system";
import {
  HostArtifactActivationResultSchema,
  HostInstalledBinaryDigestsSchema,
  type ActivateHostArtifactArgs,
  type HostArtifactActivationArgs,
  type HostArtifactActivationResult,
  type HostInstalledBinaryDigests,
} from "../api-contracts/host-control-models";
import {
  BrowserListSchema,
  BrowserFrameSchema,
} from "../api-contracts/host-control-operations";
import type {
  BrowserListResult,
  BrowserCaptureResult,
} from "../api-contracts/runner-lifecycle";
import {
  BrowserControlResultSchema,
  type BrowserControlArgs,
  type BrowserControlResult,
} from "../api-contracts/runner-lifecycle";
import {
  BrowserVideoStartResultSchema,
  BrowserVideoNextResultSchema,
  BrowserVideoStopResultSchema,
  type BrowserVideoRequest,
} from "../api-contracts/runner-lifecycle";
import { readBodyWithinLimit } from "../bounded-form-data";
import type { RpcTransport } from "../omp/rpc-transport";
import type { ProjectRegistryEntry } from "../project-registry";
import { isValidSessionId } from "../session-file-references-core";
import {
  appendTransportSamples,
  transportMetricsPath,
} from "../transport-metrics";
import { isRecord } from "../type-guards";
import type { ArchivedSessionInfo, SessionInfo } from "../types";
import {
  isLinkUp,
  type Host,
  type HostStatus,
  type SpawnRequest,
  type SpawnResult,
} from "./host";
import {
  CREATION_ID_RE,
  decodeBlobFrame,
  decodeUp,
  encodeLine,
  encodeQueued,
  HostOpError,
  LINK_CLOSE,
  LINK_LIMITS,
  LINK_PROTOCOL_VERSION,
  LinkLimitError,
  LinkSender,
  MIN_LINK_PROTOCOL_VERSION,
  Outbox,
  PartJoiner,
  SeqWindow,
  SESSION_OP_PARAMS,
  type DownMessage,
  type HelloChannel,
  type HostOpName,
  type UnknownMessage,
  type OpenChannelRequest,
  type OpenChannelResult,
  type ShipPrDigest,
  type HostUriScheme,
  type Unsequenced,
  UnknownMessageLog,
  type UpMessage,
} from "./link-protocol";
import {
  customLocalLabel,
  DEFAULT_LOCAL_LABEL,
  HostRegistryUnreadableError,
  hostForToken,
  LOCAL_HOST_ID,
  loadHosts,
  readHosts,
  touchHost,
  type HostRecord,
} from "./registry";
import type { SessionOps } from "./session-ops";
import { validateHostTools } from "./shared-requests";
import {
  WORKSPACE_OP_PARAMS,
  type WorkspaceFileEvent,
  type WorkspaceOps,
} from "../workspace-types";
import { validWorkspaceResult } from "./workspace-results";

/** Liveness and op timeouts from LINK_LIMITS; tests shorten them. */
export const linkTimings = {
  pingMs: LINK_LIMITS.pingMs,
  offlineMs: LINK_LIMITS.offlineMs,
  opTimeoutMs: LINK_LIMITS.opTimeoutMs,
};

/** What the hub keeps on each link socket (Bun's `ws.data`): the host its token named, and whether its hello came. */
export interface LinkSocketData {
  hostId: string;
  hello: boolean;
  /** Registry token hash at authenticated upgrade. Synthetic test sockets lack this authority. */
  hostCredential?: string;
}

/** The server end of a link WebSocket: the part of Bun's ServerWebSocket the hub uses, so tests drive it with a plain object. */
export interface LinkSocket {
  readonly data: LinkSocketData;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

type Hello = Extract<UpMessage, { type: "hello" }>;
type Res = Extract<UpMessage, { type: "res" }>;
/** An `upload_ack` as lib/uploads.ts sees it. */
export type UploadAck = Omit<
  Extract<UpMessage, { type: "upload_ack" }>,
  "type" | "seq"
>;

interface PendingOp {
  op: HostOpName;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  sessionId?: string | null;
  /** Result bytes from the binary frames sent ahead of their `res`, in order (views into those frames). */
  blob: Uint8Array[];
  blobBytes: number;
}

/** A downlink line sent (or to resend) and not acked yet. `key`: the `sender` key it went out under; `bytes`: its
 * UTF-8 size; `part`: a `part` line; `sample`: on the line that completes a message, its link sample. */
interface Sent {
  seq: number;
  line: string;
  key: string;
  bytes: number;
  part: boolean;
  sample: DownSample | null;
}

/** What a downlink message's link sample needs, taken when it is queued: the time (wall and monotonic), its UTF-8 size, the bytes queued
 * or unacked ahead of it then, and the session it serves. */
interface DownSample {
  at: number;
  /** `at` on the monotonic clock, for ackMs. */
  t: number;
  bytes: number;
  bytesAhead: number;
  session: string | null;
}

/** A downlink line queued in the sender. */
type DownLine = { line: string; size: number; sample: DownSample };

interface Link {
  readonly id: string;
  readonly host: RemoteHost;
  status: HostStatus;
  /** Link protocol version the daemon last presented (Settings shows it on a 426). */
  hostVersion: number | null;
  /** Shared lifecycle (v7) is advertised independently of the v8 pool extensions. */
  shared: boolean;
  ompVersion: string | null;
  keylimeVersion: string | null;
  workspaceOps: Set<string>;
  canReportUsage: boolean;
  canStageArtifact: boolean;
  canActivateArtifact: boolean;
  canReportBinaryDigests: boolean;
  connectionId: string | null;
  platform: string | null;
  releaseArch?: string;
  lastSeenAt: string | null;
  autoApprove: boolean;
  /** The socket whose hello this link took; null while the daemon has none. */
  socket: LinkSocket | null;
  shipCredential?: string;
  /** Last downlink seq handed out. Lines stay in `outbox` until the daemon acks them. */
  downSeq: number;
  /** Downlink messages not numbered yet, per channel or request, sent fair (spec D7); from v6 also upload bytes under
   * `up:<id>`, which go as binary frames outside the line window (the browser's upload window bounds them). */
  sender: LinkSender<DownLine | { id: string; blob: Uint8Array }>;
  outbox: Outbox<Sent>;
  /** Bytes of the outbox lines, sent or waiting for a resend. */
  outboxBytes: number;
  /** Highest outbox seq written to the current socket; `flush` sends what is past it. */
  sentSeq: number;
  /** Bytes of the outbox lines written to the current socket: the unacked window (spec D7). */
  unacked: number;
  /** Bun queued the last line over the socket's buffered data: the rest waits for its `drain`. */
  awaitingDrain: boolean;
  up: SeqWindow;
  /** The uplink line the daemon is sending in parts. */
  parts: PartJoiner;
  /** What this link has already logged about messages it skipped. */
  unknownLog: UnknownMessageLog;
  /** This link's `up` samples in the current statsFlushMs window (STATS_BUDGET_FACTOR × statsSamples at most) and those
   * dropped past it; `start` is a monotonic time. */
  statsWindow: { start: number; used: number; dropped: number };
  /** A malformed `stats` sample was logged on this link (once per link). */
  statsWarned: boolean;
  pending: Map<string, PendingOp>;
  channels: Map<string, RemoteRpcTransport>;
  /** v7: the sessions of every child the host last listed, joined by this server or not. */
  listedSessions: Set<string>;
  pingTimer: NodeJS.Timeout | undefined;
  offlineTimer: NodeJS.Timeout | undefined;
  statusListeners: Set<(status: HostStatus) => void>;
}

/** Link samples (metric "link") waiting to be written, and the file they go to, resolved when the batch started so a
 * later flush never re-resolves the agent dir (a test's may be gone by then). */
interface LinkSampleBatch {
  samples: Record<string, unknown>[];
  file: string;
  timer: NodeJS.Timeout | undefined;
}

interface HubState {
  links: Map<string, Link>;
  changeListeners: Set<() => void>;
  helloListeners: Set<(hostId: string, channels: HelloChannel[]) => void>;
  sessionChangeListeners: Set<(hostId: string) => void>;
  /** This server is shutting down (freezeHostLinks): links neither send nor apply anything. */
  frozen: boolean;
  linkSamples: LinkSampleBatch;
  /** lib/uploads.ts: each host's `upload_ack`, and null when its socket ended (upload bytes in flight are lost). */
  uploadListeners: Set<(hostId: string, ack: UploadAck | null) => void>;
  fileListeners: Map<string, (event: WorkspaceFileEvent) => void>;
  terminalListeners: Map<string, Set<(event: TerminalEvent) => void>>;
  ptyListeners: Map<string, (event: TerminalAttachServer | null) => void>;
  pendingPtyDetaches: WeakMap<LinkSocket, Map<string, string>>;
}

declare global {
  var __ompHostHub: HubState | undefined;
}

// globalThis, like the rpc-manager registry: survives a `bun --hot` re-evaluation.
function hub(): HubState {
  globalThis.__ompHostHub ??= {
    links: new Map(),
    changeListeners: new Set(),
    helloListeners: new Set(),
    sessionChangeListeners: new Set(),
    frozen: false,
    linkSamples: { samples: [], file: "", timer: undefined },
    uploadListeners: new Set(),
    fileListeners: new Map(),
    terminalListeners: new Map(),
    ptyListeners: new Map(),
    pendingPtyDetaches: new WeakMap(),
  };
  // A state kept from before a field existed (`bun --hot`) lacks it.
  globalThis.__ompHostHub.linkSamples ??= {
    samples: [],
    file: "",
    timer: undefined,
  };
  globalThis.__ompHostHub.uploadListeners ??= new Set();
  globalThis.__ompHostHub.fileListeners ??= new Map();
  globalThis.__ompHostHub.ptyListeners ??= new Map();
  globalThis.__ompHostHub.pendingPtyDetaches ??= new WeakMap();
  globalThis.__ompHostHub.terminalListeners ??= new Map();
  globalThis.__ompHostHub.sessionChangeListeners ??= new Set();
  return globalThis.__ompHostHub;
}

/** The daemon changed its session files, including a restore that completed after its RPC timed out. */
export function onHostSessionsChanged(
  listener: (hostId: string) => void,
): () => void {
  const listeners = hub().sessionChangeListeners;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function onTerminalEvent(
  hostId: string,
  id: string,
  listener: (event: TerminalEvent) => void,
): () => void {
  const key = JSON.stringify([hostId, id]);
  const listeners = hub().terminalListeners.get(key) ?? new Set();
  hub().terminalListeners.set(key, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) hub().terminalListeners.delete(key);
  };
}

/** Only main-created watch identities route daemon events to their owning consumer. */
export function onWorkspaceFile(
  hostId: string,
  id: string,
  epoch: string,
  listener: (event: WorkspaceFileEvent) => void,
): () => void {
  const key = JSON.stringify([hostId, id, epoch]);
  hub().fileListeners.set(key, listener);
  return () => {
    if (hub().fileListeners.get(key) === listener)
      hub().fileListeners.delete(key);
  };
}

/** Attachments are tied to one host-link incarnation and never resumed. */
export function onPtyEvent(
  hostId: string,
  id: string,
  listener: (event: TerminalAttachServer | null) => void,
): () => void {
  const key = JSON.stringify([hostId, id]);
  hub().ptyListeners.set(key, listener);
  return () => {
    if (hub().ptyListeners.get(key) === listener)
      hub().ptyListeners.delete(key);
  };
}
export function sendPtyFrame(
  hostId: string,
  id: string,
  sessionId: string,
  payload: string,
): boolean {
  const link = hub().links.get(hostId);
  if (!link?.socket || !isLinkUp(link.status) || hub().frozen) return false;
  if (link.awaitingDrain) {
    if (payload === '{"type":"detach"}') {
      let pending = hub().pendingPtyDetaches.get(link.socket);
      if (!pending)
        hub().pendingPtyDetaches.set(link.socket, (pending = new Map()));
      pending.set(
        id,
        encodeLine({ type: "pty_attach", id, sessionId, payload }),
      );
      return true;
    }
    return false;
  }
  const sent = link.socket.send(
    encodeLine({ type: "pty_attach", id, sessionId, payload }),
  );
  if (sent === 0) return false;
  if (sent < 0) link.awaitingDrain = true;
  return true;
}
export async function hostPtySessions(hostId: string): Promise<string[]> {
  const result = await request(hostId, "ptySessions", {});
  if (
    !Array.isArray(result) ||
    !result.every((id) => typeof id === "string" && isValidSessionId(id))
  )
    throw new HostOpError(
      502,
      "invalid_pty_sessions",
      "Invalid terminal session inventory from host",
    );
  return result;
}

function endWorkspaceWatches(hostId: string): void {
  const terminalPrefix = `${JSON.stringify([hostId]).slice(0, -1)},`;
  for (const [key, listener] of hub().ptyListeners) {
    if (key.startsWith(terminalPrefix)) {
      hub().ptyListeners.delete(key);
      listener(null);
    }
  }
  for (const [key, listeners] of hub().terminalListeners) {
    if (!key.startsWith(terminalPrefix)) continue;
    hub().terminalListeners.delete(key);
    for (const listener of listeners) listener({ type: "disconnected" });
  }
  const prefix = `${JSON.stringify([hostId]).slice(0, -1)},`;
  for (const [key, listener] of hub().fileListeners) {
    if (!key.startsWith(prefix)) continue;
    hub().fileListeners.delete(key);
    listener({ type: "error", message: "The file's host link disconnected" });
  }
}

function linkFor(id: string): Link {
  const links = hub().links;
  let link = links.get(id);
  if (!link) {
    link = {
      id,
      host: new RemoteHost(id),
      status: "offline",
      hostVersion: null,
      shared: false,
      ompVersion: null,
      keylimeVersion: null,
      workspaceOps: new Set(),
      canReportUsage: false,
      canStageArtifact: false,
      canActivateArtifact: false,
      canReportBinaryDigests: false,
      connectionId: null,
      platform: null,
      lastSeenAt: null,
      autoApprove: false,
      socket: null,
      downSeq: 0,
      sender: new LinkSender(),
      outbox: new Outbox(),
      outboxBytes: 0,
      sentSeq: 0,
      unacked: 0,
      awaitingDrain: false,
      up: new SeqWindow(),
      parts: new PartJoiner(),
      unknownLog: new UnknownMessageLog("daemon"),
      statsWindow: { start: 0, used: 0, dropped: 0 },
      statsWarned: false,
      pending: new Map(),
      channels: new Map(),
      listedSessions: new Set(),
      pingTimer: undefined,
      offlineTimer: undefined,
      statusListeners: new Set(),
    };
    links.set(id, link);
  }
  return link;
}

function labelOf(id: string): string {
  if (id === LOCAL_HOST_ID) return customLocalLabel() || DEFAULT_LOCAL_LABEL;
  return loadHosts().find((h) => h.id === id)?.label ?? id;
}

function notify<A extends unknown[]>(
  listeners: Iterable<(...args: A) => void>,
  ...args: A
): void {
  for (const listener of listeners) {
    try {
      listener(...args);
    } catch {
      // A listener bug must not break the link.
    }
  }
}

function setStatus(link: Link, status: HostStatus): void {
  if (link.status !== status) {
    link.status = status;
    notify(link.statusListeners, status);
  }
  notify(hub().changeListeners);
}

const isStatus = (status: unknown): status is number =>
  Number.isInteger(status) &&
  (status as number) >= 400 &&
  (status as number) <= 599;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Unsequenced lines (welcome, ping, pong, ack): small, sent at once, never resent. */
function enqueue(link: Link, line: string): void {
  link.socket?.send(line);
}

/** Lines that left the outbox (acked or dropped): those written to the current socket leave the unacked window. */
function released(link: Link, items: Sent[]): void {
  for (const item of items) {
    link.outboxBytes -= item.bytes;
    if (item.seq <= link.sentSeq) link.unacked -= item.bytes;
  }
}

/** Send outbox lines past `sentSeq` (a resend after a redial), then the sender's next units, while the unacked window
 * has room and until Bun queues one under backpressure (-1: the rest goes on `drain`) or drops it (0: the socket is
 * closing; the next socket starts from its hello's ack). So at most about unackedBytes of sequenced lines sit in
 * Bun's, the kernel's and the daemon's buffers (spec D7), and a daemon that stops reading is waited for instead of
 * closed. */
function flush(link: Link): void {
  const ws = link.socket;
  if (!ws || link.awaitingDrain || hub().frozen) return;
  const limit = LINK_LIMITS.unackedBytes;
  const write = (item: Sent): boolean => {
    const sent = ws.send(item.line);
    if (sent !== 0) {
      link.sentSeq = item.seq;
      link.unacked += item.bytes;
    }
    if (sent > 0) return true;
    link.awaitingDrain = true;
    return false;
  };
  for (const item of link.outbox.pending()) {
    if (item.seq > link.sentSeq && (link.unacked >= limit || !write(item)))
      return;
  }
  while (link.unacked < limit) {
    const unit = link.sender.next(() => ++link.downSeq);
    if (!unit) return;
    if ("frame" in unit) {
      // Upload bytes (v6): unsequenced and outside the line window; lost with the socket, resumed by the next uploadStart.
      if (ws.send(unit.frame) > 0) continue;
      link.awaitingDrain = true;
      return;
    }
    const queued = unit.item as DownLine;
    // One sample per message: a split one carries it on its last part.
    const item: Sent = {
      seq: unit.seq,
      line: unit.line,
      key: unit.key,
      bytes: Buffer.byteLength(unit.line),
      part: unit.part,
      sample: unit.done ? { ...queued.sample, bytes: unit.messageBytes } : null,
    };
    link.outbox.push(item);
    link.outboxBytes += item.bytes;
    if (!write(item)) return;
  }
}

/** Queue under `key` (its channel or request id), numbered and kept until acked as it goes out. Throws
 * LinkLimitError before recording anything. Dropped once frozen: a kill, an answer or a command from a stopping
 * server must not reach the children. */
function sendDown(
  link: Link,
  body: Unsequenced<DownMessage>,
  key: string,
): void {
  if (hub().frozen) return;
  const line = encodeQueued(body);
  const size = Buffer.byteLength(line);
  // Ahead of it: what is queued or unacked on this link (counters, no scan); fairness may send it before some of that.
  const sample = {
    at: Date.now(),
    t: performance.now(),
    bytes: size,
    bytesAhead: link.outboxBytes + link.sender.queuedBytes,
    session: sessionOf(link, body),
  };
  link.sender.push(key, { line, size, sample });
  flush(link);
}

/** The session a downlink message serves: a session op's `id`, else its channel's child's; null for host ops. */
function sessionOf(link: Link, body: Unsequenced<DownMessage>): string | null {
  if (body.type !== "req")
    return "ch" in body ? (link.channels.get(body.ch)?.session ?? null) : null;
  return isRecord(body.args) &&
    typeof body.args.id === "string" &&
    isValidSessionId(body.args.id)
    ? body.args.id
    : null;
}

/** Batch link samples: written at LINK_LIMITS.statsSamples, after statsFlushMs, or when the hub stops. */
function recordLinkSamples(samples: Record<string, unknown>[]): void {
  const batch = hub().linkSamples;
  for (const sample of samples) {
    if (batch.samples.length === 0) {
      batch.file = transportMetricsPath();
      batch.timer = setTimeout(flushLinkSamples, LINK_LIMITS.statsFlushMs);
      batch.timer.unref?.();
    }
    batch.samples.push(sample);
    if (batch.samples.length >= LINK_LIMITS.statsSamples) flushLinkSamples();
  }
}

/** Write the batch now. Measurement only: a failed write is logged and dropped, never touches a link. */
export function flushLinkSamples(): void {
  const batch = hub().linkSamples;
  clearTimeout(batch.timer);
  batch.timer = undefined;
  if (batch.samples.length === 0) return;
  try {
    appendTransportSamples(batch.samples.splice(0), null, batch.file);
  } catch (error) {
    console.warn(
      `[keylime] could not write host link samples: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The daemon applied the downlink through `ack`: each message it acks now (a split one at its last part) becomes a
 * `down` sample; the lines leave the outbox and the unacked window. `ackMs` is monotonic: a wall-clock step between
 * queueing and ack does not show in it. */
function ackDown(link: Link, ack: number): void {
  const now = performance.now();
  const samples: Record<string, unknown>[] = [];
  const acked = link.outbox.ack(ack);
  for (const { sample } of acked) {
    if (sample)
      samples.push({
        metric: "link",
        dir: "down",
        host: link.id,
        session: sample.session,
        bytes: sample.bytes,
        bytesAhead: sample.bytesAhead,
        ackMs: Math.max(0, Math.round(now - sample.t)),
        at: sample.at,
      });
  }
  released(link, acked);
  recordLinkSamples(samples);
}

/** `up` samples one link may write per statsFlushMs, in multiples of statsSamples (a daemon reports about one `stats`
 * per window): a daemon cannot flood the shared metrics file. */
const STATS_BUDGET_FACTOR = 8;

/** Write the samples dropped past the link's budget as one `{dropped}` sample. */
function recordDropped(link: Link): void {
  const window = link.statsWindow;
  if (window.dropped > 0)
    recordLinkSamples([
      {
        metric: "link",
        dir: "up",
        host: link.id,
        dropped: window.dropped,
        at: Date.now(),
      },
    ]);
  window.dropped = 0;
}

/** A daemon's `stats`: valid samples within the link's budget become `up` samples; the excess is dropped and written as
 * one `{dropped}` sample when the next window starts, or when the link ends or the hub freezes. Malformed samples (already dropped by decodeUp) are logged once. */
function applyStats(
  link: Link,
  message: Extract<UpMessage, { type: "stats" }>,
): void {
  if (message.invalid && !link.statsWarned) {
    link.statsWarned = true;
    console.warn(
      `[keylime] ${labelOf(link.id)}: dropped ${message.invalid} malformed link samples (not logged again for this host)`,
    );
  }
  const window = link.statsWindow;
  const now = performance.now();
  if (now - window.start >= LINK_LIMITS.statsFlushMs) {
    recordDropped(link);
    Object.assign(window, { start: now, used: 0 });
  }
  const taken = message.samples.slice(
    0,
    Math.max(0, STATS_BUDGET_FACTOR * LINK_LIMITS.statsSamples - window.used),
  );
  window.used += taken.length;
  window.dropped += message.samples.length - taken.length;
  recordLinkSamples(
    taken.map((sample) => ({
      ...sample,
      metric: "link",
      dir: "up",
      host: link.id,
    })),
  );
}

/** Fail an op for good: a `req` not yet acked is never resent, nor the rest of one going in parts (one already
 * written may still run). */
function failOp(link: Link, id: string, error: Error): void {
  const pending = link.pending.get(id);
  if (!pending) return;
  link.pending.delete(id);
  clearTimeout(pending.timer);
  link.sender.drop(id);
  released(
    link,
    link.outbox.drop((m) => m.key === id),
  );
  pending.reject(error);
  flush(link);
}

function failAllOps(link: Link, error: () => Error): void {
  for (const id of [...link.pending.keys()]) failOp(link, id, error());
}

/** The socket is gone: ops in flight fail now rather than at their timeout. */
function endSocket(link: Link): void {
  link.socket = null;
  recordDropped(link);
  // Upload bytes not sent yet go nowhere now: each upload resumes from the host's offset (uploadStart).
  link.sender.dropBlobs();
  failAllOps(
    link,
    () =>
      new HostOpError(503, "host_offline", `${labelOf(link.id)} is offline`),
  );
  notify(hub().uploadListeners, link.id, null);
  endWorkspaceWatches(link.id);
}

function stopTimers(link: Link): void {
  clearInterval(link.pingTimer);
  clearTimeout(link.offlineTimer);
  link.pingTimer = undefined;
  link.offlineTimer = undefined;
}

function persistLastSeen(link: Link): void {
  if (!link.lastSeenAt) return;
  try {
    touchHost(link.id, link.lastSeenAt);
  } catch {
    // Last-seen is informational; a failed write must not drop the link.
  }
}

/** Any uplink traffic proves the daemon alive; silence for offlineMs means the link is gone. */
function sawDaemon(link: Link): void {
  link.lastSeenAt = new Date().toISOString();
  clearTimeout(link.offlineTimer);
  link.offlineTimer = setTimeout(() => {
    stopTimers(link);
    // No close handshake on a link gone silent; the daemon redials once its own watchdog fires.
    link.socket?.terminate();
    endSocket(link);
    persistLastSeen(link);
    setStatus(link, "offline");
  }, linkTimings.offlineMs);
  link.offlineTimer.unref?.();
}

/** The host the bearer token names, or the refusal to answer with. */
function authenticate(req: Request): HostRecord | Response {
  const header = req.headers.get("authorization");
  const token =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : "";
  try {
    const record = token ? hostForToken(token) : null;
    if (!record) return json({ error: "Invalid host token" }, 401);
    return record;
  } catch (error) {
    if (!(error instanceof HostRegistryUnreadableError)) throw error;
    // Never 401 here: a daemon told its token is unknown stops every omp child.
    console.error(`[keylime] host link refused: ${error.message}`);
    return json({ error: "The host registry cannot be read" }, 503);
  }
}

// The daemon retries a 503: what it sends lands on the next server instead.
const stopping = () => json({ error: "key lime is shutting down" }, 503);

/**
 * This server is shutting down. From here on nothing reaches a daemon (sendDown
 * drops it), and no hello or uplink frame is applied or acked: each daemon keeps
 * its children's output unacked and sends it to the next server, which adopts the
 * children. Every link socket closes 1001, so its daemon redials. Without this a
 * tab closing on the way out would answer omp's open host tool calls with an
 * error, and output this server took but never showed would be lost to the next one.
 */
export function freezeHostLinks(): void {
  hub().frozen = true;
  for (const link of hub().links.values()) {
    recordDropped(link);
    link.socket?.close(LINK_CLOSE.goingAway, "keylime is restarting");
  }
  // The process exits next: keep what was measured.
  flushLinkSamples();
}

/** GET /api/hosts/link: the daemon's WebSocket. The token is checked before the upgrade, so no unknown caller gets a
 * socket; undefined once upgraded. The hello comes as the socket's first frame (hostLinkSocket). */
export function handleLinkUpgrade(
  req: Request,
  upgrade: (data: LinkSocketData) => boolean,
): Response | undefined {
  const record = authenticate(req);
  if (record instanceof Response) return record;
  if (hub().frozen) return stopping();
  return upgrade({
    hostId: record.id,
    hello: false,
    hostCredential: record.tokenHash,
  })
    ? undefined
    : json({ error: "The host link is a WebSocket" }, 426);
}

/** POST /api/hosts/link: only a daemon from before the WebSocket (v3) sends one, its hello. It gets the 426 that tells
 * it to update keylime on its host. */
export async function handleOutdatedLinkPost(req: Request): Promise<Response> {
  const record = authenticate(req);
  if (record instanceof Response) return record;
  let raw: unknown = null;
  try {
    raw = JSON.parse(
      new TextDecoder().decode(
        await readBodyWithinLimit(req, LINK_LIMITS.uplinkBytes),
      ),
    );
  } catch {
    // Too large or not JSON: no version to report.
  }
  versionMismatch(linkFor(record.id), raw);
  return json(
    {
      error: "Link protocol version mismatch",
      hostVersion: helloVersion(raw),
      serverVersion: LINK_PROTOCOL_VERSION,
    },
    426,
  );
}

/** A hello's `v` when it is an integer, else null. */
function helloVersion(raw: unknown): number | null {
  const version = isRecord(raw) ? raw.v : undefined;
  return typeof version === "number" && Number.isInteger(version)
    ? version
    : null;
}

/** True for a daemon outside MIN_LINK_PROTOCOL_VERSION..LINK_PROTOCOL_VERSION (a newer one too: the web app upgrades first).
 * Compared before decoding: another version may shape its hello differently. */
function versionMismatch(link: Link, raw: unknown): boolean {
  const version = helloVersion(raw);
  if (
    version !== null &&
    version >= MIN_LINK_PROTOCOL_VERSION &&
    version <= LINK_PROTOCOL_VERSION
  )
    return false;
  // A stray old daemon with this token must not take down the healthy link.
  if (!link.socket) {
    // Kept for Settings: "needs upgrade (host vN, server vM)".
    link.hostVersion = version;
    setStatus(link, "needs-upgrade");
  }
  return true;
}

/** Bun's `websocket` handler for host links (server/app.ts). */
export const hostLinkSocket = {
  // A result frame is up to blobBytes plus its id header; Bun closes 1009 above it.
  maxPayloadLength: LINK_LIMITS.blobBytes + 256,
  // A backstop: flush keeps at most about unackedBytes of sequenced lines unacked (v5) and stops when Bun reports
  // backpressure. Past the limit the socket closes instead of buffering on, and what the daemon missed is resent after
  // its redial.
  backpressureLimit: LINK_LIMITS.uplinkBytes,
  closeOnBackpressureLimit: true as const,
  message(ws: LinkSocket, data: string | Uint8Array): void {
    guarded(ws, () => {
      // Nothing is applied or answered once this server stops: the daemon keeps it for the next one.
      if (hub().frozen || failedSockets.has(ws)) return;
      const link = hub().links.get(ws.data.hostId);
      if (link?.socket === ws) return onFrame(link, ws, data);
      // A socket a newer one replaced: what it still sends belongs to no link.
      if (ws.data.hello) return;
      onFirstFrame(ws, data);
    });
  },
  /** Bun wrote out what it had queued: send the outbox lines that waited. */
  drain(ws: LinkSocket): void {
    guarded(ws, () => {
      const link = hub().links.get(ws.data.hostId);
      if (link?.socket !== ws) return;
      const detaches = hub().pendingPtyDetaches.get(ws);
      if (detaches) {
        for (const [id, line] of detaches) {
          const sent = ws.send(line);
          if (sent === 0) {
            ws.terminate();
            return;
          }
          detaches.delete(id);
          if (sent < 0) {
            link.awaitingDrain = true;
            return;
          }
        }
        hub().pendingPtyDetaches.delete(ws);
      }
      link.awaitingDrain = false;
      flush(link);
    });
  },
  close(ws: LinkSocket): void {
    guarded(ws, () => {
      const link = hub().links.get(ws.data.hostId);
      if (link?.socket === ws) endSocket(link);
    });
  },
};

/** Sockets whose handler threw: closed, and nothing more they send is applied (it would land past a half-applied frame). */
const failedSockets = new WeakSet<LinkSocket>();

/** A throw in a websocket handler would reach uncaughtException, which exits the server: it ends that socket instead. */
function guarded(ws: LinkSocket, handle: () => void): void {
  try {
    handle();
  } catch (error) {
    failedSockets.add(ws);
    console.error(
      `[keylime] host link of ${ws.data.hostId} failed; closing it: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    ws.close();
  }
}

/** A socket's first frame must be its hello. */
function onFirstFrame(ws: LinkSocket, data: string | Uint8Array): void {
  const refuse = () =>
    ws.close(LINK_CLOSE.policy, "The first frame must be a hello");
  if (typeof data !== "string") return refuse();
  // A hello is one line: nothing longer is worth parsing.
  if (Buffer.byteLength(data) > LINK_LIMITS.maxLineBytes)
    return ws.close(LINK_CLOSE.tooBig, "Hello too large");
  // Revoked or deleted since the upgrade, or the registry cannot say: a plain close sends the daemon's redial through
  // the token check (401 stops its children, 503 redials).
  if (
    ws.data.hostId !== LOCAL_HOST_ID &&
    !loadHosts().some((h) => h.id === ws.data.hostId)
  )
    return ws.close();
  const link = linkFor(ws.data.hostId);
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return refuse();
  }
  if (versionMismatch(link, raw))
    return ws.close(
      LINK_CLOSE.versionMismatch,
      JSON.stringify({ serverVersion: LINK_PROTOCOL_VERSION }),
    );
  let hello: UpMessage | UnknownMessage;
  try {
    hello = decodeUp(data);
  } catch {
    return refuse();
  }
  if (hello.type !== "hello") return refuse();
  ws.data.hello = true;
  openLink(link, ws, hello);
}

const SHIP_RECEIPT_KEY = "ship-pr-digest-receipt";

function openLink(link: Link, ws: LinkSocket, hello: Hello): void {
  if (link.shipCredential !== ws.data.hostCredential) {
    // In particular, `local` can be rotated without changing the host id.
    link.sender.drop(SHIP_RECEIPT_KEY);
    released(
      link,
      link.outbox.drop((item) => item.key === SHIP_RECEIPT_KEY),
    );
    link.shipCredential = ws.data.hostCredential;
  }
  link.canReportBinaryDigests = hello.canReportBinaryDigests === true;
  if (!link.canReportBinaryDigests) {
    // A daemon without this capability may reject the request frame itself.
    for (const [id, pending] of link.pending)
      if (pending.op === "hostInstalledBinaryDigests")
        failOp(link, id, binaryDigestsUnsupported());
  }
  // One link per host: the newest wins and the previous daemon exits.
  const previous = link.socket;
  link.connectionId = randomUUID();
  link.socket = ws;
  previous?.close(LINK_CLOSE.replaced, "replaced by a newer link");
  if (previous) {
    // Upload bytes the old socket may have lost must not be followed by later ones on this socket: they resume instead.
    link.sender.dropBlobs();
    notify(hub().uploadListeners, link.id, null);
  }
  // Every sequenced uplink message answers a downlink one, so a daemon that
  // has applied none (ack 0) has sent none: it is a fresh process whose
  // uplink numbering starts again at 1.
  if (hello.ack <= 0) {
    link.up = new SeqWindow();
    // Such a daemon is asked again and answers from byte 0: the pieces of the replaced socket would prefix its result. The
    // same process (ack above 0) resends only the `res` of a result whose pieces already arrived.
    for (const pending of link.pending.values())
      Object.assign(pending, { blob: [], blobBytes: 0 });
  }
  // After a restart of this server the daemon is ahead: number above its ack.
  link.downSeq = Math.max(link.downSeq, hello.ack);
  released(link, link.outbox.ack(hello.ack));
  link.unknownLog.reset();
  link.hostVersion = hello.v;
  link.shared = true;
  enqueue(link, encodeLine({ type: "welcome", v: hello.v, hostId: link.id }));
  // Resend what the daemon has not applied, in order and paced, before anything new.
  link.sentSeq = hello.ack;
  link.unacked = 0;
  link.awaitingDrain = false;
  flush(link);
  link.ompVersion = hello.ompVersion;
  link.keylimeVersion = hello.keylimeVersion ?? null;
  link.workspaceOps = new Set(hello.workspaceOps ?? []);
  link.canReportUsage = hello.canReportUsage === true;
  link.canStageArtifact = hello.canStageArtifact === true;
  link.canActivateArtifact = hello.canActivateArtifact === true;
  endWorkspaceWatches(link.id);
  link.platform = hello.platform;
  link.releaseArch = hello.arch;
  link.autoApprove = hello.autoApproveExtension;
  sawDaemon(link);
  persistLastSeen(link);
  clearInterval(link.pingTimer);
  link.pingTimer = setInterval(
    () => enqueue(link, encodeLine({ type: "ping" })),
    linkTimings.pingMs,
  );
  link.pingTimer.unref?.();
  setStatus(link, hello.ompVersion === null ? "omp-missing" : "online");
  reattach(link, hello.channels);
  notify(hub().helloListeners, link.id, hello.channels);
}

/** A frame on the link's current socket: a result's bytes (binary), or uplink messages (text). */
function onFrame(link: Link, ws: LinkSocket, data: string | Uint8Array): void {
  sawDaemon(link);
  if (typeof data !== "string") {
    let result: { id: string; bytes: Uint8Array };
    try {
      result = decodeBlobFrame(data);
    } catch {
      return ws.close(LINK_CLOSE.policy, "Malformed result frame");
    }
    // A large result comes in pieces, in order. Pieces for an op no longer waiting are dropped;
    // past blobBytes none are kept, so its `res` then fails host_blob_missing.
    const pending = link.pending.get(result.id);
    if (pending) {
      pending.blobBytes += result.bytes.byteLength;
      const limit =
        pending.op === "readFileChunk"
          ? LINK_LIMITS.pieceBytes
          : LINK_LIMITS.blobBytes;
      if (pending.blobBytes <= limit) {
        pending.blob.push(result.bytes);
        // The deadline is for silence: at one unacked window per round trip a valid 64 MiB result outlasts a fixed one.
        // Only bytes the hub keeps count, so empty or surplus frames cannot hold an op open.
        if (result.bytes.byteLength > 0) pending.timer.refresh();
      }
    }
    // The daemon counts its frames in flight by these answers, binary ones included.
    enqueue(link, encodeLine({ type: "ack", ack: link.up.acked }));
    return;
  }
  if (Buffer.byteLength(data) > LINK_LIMITS.uplinkBytes)
    return ws.close(LINK_CLOSE.tooBig, "Uplink frame too large");
  let messages: (UpMessage | UnknownMessage)[];
  // The decoded line of each part that completes one.
  const wholes = new Map<
    UpMessage | UnknownMessage,
    UpMessage | UnknownMessage
  >();
  const parts = link.parts.clone();
  try {
    // Decode the whole frame first, joined lines included: a frame with one bad line applies nothing. The parts go
    // through a copy of the joiner, and applyUp's dedup is mirrored by a running high mark.
    let high = link.up.acked;
    messages = data
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const message = decodeUp(line);
        const seq = "seq" in message ? message.seq : null;
        if (seq === null || seq <= high) return message;
        high = seq;
        const whole = message.type === "part" ? parts.add(message) : null;
        if (whole !== null) wholes.set(message, decodeUp(whole));
        return message;
      });
  } catch {
    return ws.close(LINK_CLOSE.invalidData, "Malformed uplink frame");
  }
  link.parts = parts;
  for (const message of messages) {
    if (message.type === "ack") ackDown(link, message.ack);
    else applyUp(link, message, wholes.get(message));
  }
  // One answer per frame, also to one with nothing sequenced in it: a v5 daemon counts its frames in flight by them.
  enqueue(link, encodeLine({ type: "ack", ack: link.up.acked }));
  // The daemon's ack may have opened the unacked window.
  flush(link);
}

/**
 * Spec Rules → Reattach. Listed channels this server has a transport for carry
 * on unchanged. A spawned child the daemon no longer lists died while the link
 * was down: its transport gets a synthesized exit, marked `lost`. Listed
 * channels without a transport are children of a previous run of this server:
 * adopted (see adopt), or killed as orphans when that is not possible. Either
 * way they stay registered until their `exit` (see orphanExit).
 */
function reattach(
  link: Link,
  listed: HelloChannel[],
  refreshExisting = true,
): void {
  // Hello and channels_changed both carry the host's full listing.
  link.listedSessions = new Set(
    listed.flatMap(({ sessionId }) => (sessionId ? [sessionId] : [])),
  );
  const live = new Set(listed.map(({ ch }) => ch));
  for (const [ch, transport] of refreshExisting ? link.channels : []) {
    // A spawn still in flight is not listed yet.
    if (!transport.spawned || live.has(ch)) continue;
    link.channels.delete(ch);
    transport.lost = true;
    transport.deliverExit(null, null);
  }
  for (const hello of listed) {
    const { ch, sessionId, cwd } = hello;
    const existing = link.channels.get(ch);
    if (existing) {
      existing.spawned = true;
      const identityChanged =
        sessionId !== null && existing.session !== sessionId;
      if (sessionId) existing.session = sessionId;
      if (refreshExisting || identityChanged) existing.deliverResync();
      continue;
    }
    if (
      [...link.pending.values()].some(
        (op) => op.op === "open" && op.sessionId === sessionId,
      )
    )
      continue;
    const child = new RemoteRpcTransport(link.id, ch, sessionId);
    child.spawned = true;
    link.channels.set(ch, child);
    if (!sessionId) {
      child.close();
      continue;
    }
    child.adoption = (async () => {
      try {
        const spawned = await link.host.spawnRpc(
          {
            cwd,
            recordedCwd: cwd,
            sessionFile: "",
            advisor: false,
          },
          sessionId,
          { expectedChannel: ch },
        );
        if (spawned.transport !== child)
          throw new Error("Host changed a listed channel while joining");
        return await adopt(
          link,
          child,
          sessionId,
          spawned.cwd,
          [
            ...(spawned.pending ?? []),
            ...(spawned.streaming ? [spawned.streaming] : []),
          ],
          spawned,
        );
      } catch (error) {
        child.close();
        console.warn(
          `[keylime] could not join session ${sessionId} on ${labelOf(link.id)}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    })();
  }
}

/** Spec "Adopting live children": a session wrapper takes the child over, by
 * the identity the child itself reports (a new session is in no list before
 * its first reply is written). Failed shared adoption leaves this link. */
async function adopt(
  link: Link,
  child: RemoteRpcTransport,
  sessionId: string,
  cwd: string,
  replay: string[],
  metadata?: Pick<
    SpawnResult,
    "advisorSpawned" | "launchAdvisor" | "registration"
  >,
): Promise<boolean> {
  try {
    // rpc-manager imports the hub: resolving adoption lazily avoids their initialization cycle.
    const { adoptRpcSession } = await import("../rpc-manager");
    await adoptRpcSession({
      host: link.host,
      transport: child,
      sessionId,
      cwd,
      replay,
      ...metadata,
    });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    child.close();
    console.warn(
      `[keylime] left the shared omp child of session ${sessionId} on ${labelOf(link.id)} running: this server could not adopt it (${reason})`,
    );
    return false;
  }
}

/** `whole`: for a `part` that completes a line, that line decoded. `joined`: that line itself, which gets no dedup of
 * its own (its parts were deduped). */
function applyUp(
  link: Link,
  message: UpMessage | UnknownMessage,
  whole?: UpMessage | UnknownMessage,
  joined = false,
): void {
  if (message.type === "ping")
    return enqueue(link, encodeLine({ type: "pong" }));
  if (
    message.type === "pong" ||
    message.type === "hello" ||
    message.type === "ack"
  )
    return;
  if (message.type === "pty_event") {
    const listener = hub().ptyListeners.get(
      JSON.stringify([link.id, message.id]),
    );
    if (!listener) return;
    try {
      const event: unknown = JSON.parse(message.payload);
      if (!Value.Check(TerminalAttachServerSchema, event))
        throw new Error("Invalid terminal event");
      listener(event);
    } catch {
      listener(null);
    }
    return;
  }
  if (message.type === "unknown") {
    // A newer daemon's message, or one only the server sends: skipped, but its seq is applied so it is acked and never resent.
    if (message.seq !== null) link.up.applied(message.seq);
    const note = link.unknownLog.note(message);
    if (note) console.warn(`[keylime] ${labelOf(link.id)}: ${note}`);
    return;
  }
  // Already applied before a resend.
  if (!joined && !link.up.applied(message.seq)) return;
  switch (message.type) {
    case "part":
      return whole ? applyUp(link, whole, undefined, true) : undefined;
    case "stdout":
      return link.channels.get(message.ch)?.deliverLine(message.line);
    case "stderr":
      return link.channels.get(message.ch)?.deliverStderr(message.chunk);
    case "resync":
      return link.channels.get(message.ch)?.deliverResync();
    case "exit": {
      const transport = link.channels.get(message.ch);
      link.channels.delete(message.ch);
      return transport?.deliverExit(
        message.code,
        message.signal as NodeJS.Signals | null,
        message.reason,
      );
    }
    case "res":
      return settle(link, message);
    case "channels_changed":
      reattach(link, message.channels, false);
      return;
    case "sessions_changed":
      void import("./session-index")
        .then(({ invalidateHostSessionList }) => {
          invalidateHostSessionList(link.id);
          notify(hub().sessionChangeListeners, link.id);
          return import("../rpc-manager");
        })
        .then(({ notifyRunningChange }) =>
          notifyRunningChange({ refreshSessionList: true }),
        );
      return;
    case "ship_pr_digest":
      offerShipDigest(link, message);
      return;
    case "upload_ack":
      return notify(hub().uploadListeners, link.id, message);
    case "terminal_event":
      for (const listener of hub().terminalListeners.get(
        JSON.stringify([link.id, message.id]),
      ) ?? [])
        listener(message.event);
      return;
    case "workspace_file":
      return hub().fileListeners.get(
        JSON.stringify([link.id, message.id, message.epoch]),
      )?.(message.event);
    case "stats":
      return applyStats(link, message);
  }
}

function offerShipDigest(link: Link, offer: ShipPrDigest): void {
  const socket = link.socket;
  const credential = socket?.data.hostCredential;
  if (!credential) return;
  const stillAuthenticated = () => {
    if (link.socket !== socket) return false;
    return getShipHostCredential(link.id) === credential;
  };
  // Import lazily: the outbox dispatcher uses the hub to open its pinned session.
  void import("../message-outbox")
    .then(async ({ acceptShipDigestOffer, findShipDigestGrant }) => {
      if (
        !stillAuthenticated() ||
        !link.host.supportsWorkspaceOp("shipMonitorStatus")
      )
        return;
      const workspace = findShipDigestGrant(link.id, credential, offer);
      if (!workspace) return;
      const status = await link.host.workspaceOps.shipMonitorStatus({
        ...workspace,
        monitorId: offer.monitorId,
      });
      if (!stillAuthenticated() || !status.ok) return;
      const watch = status.value.watch;
      if (watch?.sessionId !== offer.sessionId || watch.prUrl !== offer.prUrl)
        return;
      if (acceptShipDigestOffer(link.id, credential, offer, workspace))
        sendDown(
          link,
          { type: "ship_pr_digest_receipt", id: offer.id },
          SHIP_RECEIPT_KEY,
        );
    })
    .catch(() => {
      // The daemon's persisted offer will retry; never synthesize a receipt after an error.
      console.warn(
        `[keylime] could not accept a Ship digest from host ${link.id}`,
      );
    });
}

function settle(link: Link, message: Res): void {
  const pending = link.pending.get(message.id);
  // Timed out, or an id this server never issued.
  if (!pending) return;
  link.pending.delete(message.id);
  clearTimeout(pending.timer);
  const label = labelOf(link.id);
  if (!message.ok) {
    const { status, code, message: text } = message.error;
    pending.reject(
      new HostOpError(
        isStatus(status) ? status : 502,
        code,
        `${label}: ${text}`,
      ),
    );
    return;
  }
  if (!message.blob) return pending.resolve(message.result);
  const limit =
    pending.op === "readFileChunk"
      ? LINK_LIMITS.pieceBytes
      : LINK_LIMITS.blobBytes;
  if (
    pending.blob.length === 0 ||
    pending.blobBytes > limit ||
    pending.blobBytes !== message.blob.bytes
  ) {
    return pending.reject(
      new HostOpError(
        502,
        "host_blob_missing",
        `${label} did not deliver the ${pending.op} result`,
      ),
    );
  }
  const blob =
    pending.blob.length === 1 ? pending.blob[0] : Buffer.concat(pending.blob);
  if (pending.op === "readMedia" || pending.op === "readFileChunk")
    return pending.resolve({ ok: true, value: blob });
  try {
    pending.resolve(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob)),
    );
  } catch {
    pending.reject(
      new HostOpError(
        502,
        "host_bad_result",
        `${label} sent an unreadable ${pending.op} result`,
      ),
    );
  }
}

function request(
  hostId: string,
  op: HostOpName,
  args: Record<string, unknown>,
  timeoutMs = linkTimings.opTimeoutMs,
  accept?: (value: unknown) => unknown,
): Promise<unknown> {
  const link = linkFor(hostId);
  const label = labelOf(hostId);
  if (hub().frozen)
    return Promise.reject(
      new HostOpError(503, "server_stopping", "key lime is shutting down"),
    );
  if (!link.socket || !isLinkUp(link.status)) {
    return Promise.reject(
      new HostOpError(503, "host_offline", `${label} is offline`),
    );
  }
  if (op === "hostInstalledBinaryDigests" && !link.canReportBinaryDigests)
    return Promise.reject(binaryDigestsUnsupported());
  if (
    (op === "usageReport" && !link.canReportUsage) ||
    (link.hostVersion === 13 &&
      (op === "hostSettingsGet" ||
        op === "hostSettingsSet" ||
        op === "modelsList"))
  ) {
    return Promise.reject(
      new HostOpError(
        501,
        "host_upgrade_required",
        `Upgrade ${label} to use this feature`,
      ),
    );
  }
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const id = randomUUID();
  const timer = setTimeout(
    () =>
      failOp(
        link,
        id,
        new HostOpError(
          504,
          "host_timeout",
          `${label} did not answer ${op} in time`,
        ),
      ),
    timeoutMs,
  );
  // A deadline, like the ping and offline timers: never what keeps the server running.
  timer.unref?.();
  // Accept runs synchronously while applying `res`, before following stdout in the same frame.
  const pending: PendingOp = {
    op,
    resolve: (value) => {
      try {
        resolve(accept ? accept(value) : value);
      } catch (error) {
        reject(error);
      }
    },
    reject,
    timer,
    blob: [],
    blobBytes: 0,
    ...(op === "open"
      ? {
          sessionId: typeof args.sessionId === "string" ? args.sessionId : null,
        }
      : {}),
  };
  link.pending.set(id, pending);
  try {
    sendDown(link, { type: "req", id, op, args }, id);
  } catch (error) {
    clearTimeout(timer);
    link.pending.delete(id);
    reject(
      error instanceof LinkLimitError
        ? new HostOpError(
            413,
            "host_request_too_large",
            `The request is too large for ${label}`,
          )
        : error,
    );
  }
  return promise;
}

/** Shape check for daemon results other than the lists: an OpResult whose
 * value has the fields main reads (a 500 TypeError in a route otherwise). */
function validResult(
  op: keyof SessionOps,
  result: unknown,
  args: unknown[],
): boolean {
  if (!isRecord(result)) return false;
  if (result.ok === false)
    return (
      isStatus(result.status) &&
      typeof result.code === "string" &&
      typeof result.error === "string"
    );
  if (result.ok !== true || !("value" in result)) return false;
  const { value } = result;
  switch (op) {
    // Media bytes only ever arrive through the blob leg.
    case "readMedia":
      return value instanceof Uint8Array;
    // Main uses these paths (spawn cwd, project keys): they must be strings.
    case "validateCwd":
      return (
        isRecord(value) &&
        typeof value.cwd === "string" &&
        typeof value.projectRoot === "string" &&
        (value.projectKey === undefined || typeof value.projectKey === "string")
      );
    case "exportSession":
      return (
        isRecord(value) &&
        typeof value.html === "string" &&
        typeof value.fileName === "string"
      );
    case "readSession":
      return (
        isRecord(value) &&
        isRecord(value.context) &&
        (isRecord(value.info) ||
          (typeof value.historyHasMore === "boolean" &&
            typeof value.historyRevision === "string"))
      );
    case "readContext": {
      // The context route reads a different shape per mode.
      const options = isRecord(args[2]) ? args[2] : {};
      if (!isRecord(value)) return false;
      if (options.boundary) return Array.isArray(value.entryIds);
      if (options.sync)
        return (
          isRecord(value.history) &&
          nullableString(value.leafId) &&
          nullableString(value.tipId)
        );
      return isRecord(value.context);
    }
    case "archiveSession":
      return isRecord(value) && typeof value.archivedPath === "string";
    // The route reads `projects` and iterates `newRoots`.
    case "updateProject":
      return (
        isRecord(value) &&
        Array.isArray(value.projects) &&
        value.projects.every((project) => projectEntry(project) !== null) &&
        Array.isArray(value.newRoots) &&
        value.newRoots.every((root) => typeof root === "string")
      );
    case "restoreArchive":
      return (
        isRecord(value) &&
        typeof value.sessionId === "string" &&
        isValidSessionId(value.sessionId)
      );
    // An answer without the daemon process's identity cannot be matched to the claim: the route would otherwise trust it.
    case "restoreReserve":
      return (
        isRecord(value) &&
        typeof value.instance === "string" &&
        value.instance !== ""
      );
    // An unknown answer must not read as "fenced and stopped": the route drops its claim on `running: false`.
    case "restoreFence":
      return (
        isRecord(value) &&
        typeof value.instance === "string" &&
        value.instance !== "" &&
        typeof value.running === "boolean"
      );
    default:
      return true;
  }
}

const optionalString = (value: unknown) =>
  value === undefined || typeof value === "string";
const optionalNumber = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));
const nullableString = (value: unknown) =>
  value === null || typeof value === "string";

/** A daemon's session-list entry reduced to SessionInfo's fields; null when one has the wrong type. */
function sessionEntry(value: unknown): SessionInfo | null {
  if (!isRecord(value)) return null;
  const {
    path,
    id,
    cwd,
    name,
    created,
    modified,
    lastMessageAt,
    messageCount,
    firstMessage,
    parentSessionId,
    projectRoot,
    projectKey,
    worktreeBranch,
  } = value;
  if (
    typeof path !== "string" ||
    typeof id !== "string" ||
    !isValidSessionId(id) ||
    typeof cwd !== "string" ||
    typeof created !== "string" ||
    typeof modified !== "string" ||
    typeof firstMessage !== "string" ||
    typeof messageCount !== "number" ||
    !Number.isFinite(messageCount) ||
    ![
      name,
      lastMessageAt,
      parentSessionId,
      projectRoot,
      projectKey,
      worktreeBranch,
    ].every(optionalString)
  )
    return null;
  return {
    path,
    id,
    cwd,
    name,
    created,
    modified,
    lastMessageAt,
    messageCount,
    firstMessage,
    parentSessionId,
    projectRoot,
    projectKey,
    worktreeBranch,
  } as SessionInfo;
}

/** A daemon's project-registry entry reduced to its known fields; null when one has the wrong type. */
function projectEntry(value: unknown): ProjectRegistryEntry | null {
  if (!isRecord(value)) return null;
  const { path, addedAt, hidden, alias, sortOrder, pinOrder, launchConfig } =
    value;
  if (
    typeof path !== "string" ||
    !path ||
    typeof addedAt !== "string" ||
    typeof hidden !== "boolean" ||
    !optionalString(alias) ||
    !optionalNumber(sortOrder) ||
    !optionalNumber(pinOrder) ||
    !(
      launchConfig === undefined ||
      (isRecord(launchConfig) &&
        optionalString(launchConfig.profile) &&
        (launchConfig.advisor === undefined ||
          typeof launchConfig.advisor === "boolean") &&
        (launchConfig.extraArgs === undefined ||
          (Array.isArray(launchConfig.extraArgs) &&
            launchConfig.extraArgs.every((arg) => typeof arg === "string"))))
    )
  )
    return null;
  return {
    path,
    addedAt,
    hidden,
    alias,
    sortOrder,
    pinOrder,
    launchConfig,
  } as ProjectRegistryEntry;
}

/** A daemon's archive entry reduced to ArchivedSessionInfo's fields; null when one has the wrong type. */
function archiveEntry(value: unknown): ArchivedSessionInfo | null {
  if (!isRecord(value)) return null;
  const {
    key,
    id,
    cwd,
    name,
    created,
    archivedAt,
    messageCount,
    firstMessage,
    size,
    status,
    restorePending,
  } = value;
  if (
    typeof key !== "string" ||
    typeof id !== "string" ||
    typeof cwd !== "string" ||
    typeof created !== "string" ||
    typeof archivedAt !== "string" ||
    typeof firstMessage !== "string" ||
    typeof messageCount !== "number" ||
    !Number.isFinite(messageCount) ||
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    !optionalString(name) ||
    !optionalString(status) ||
    (restorePending !== undefined && restorePending !== true)
  )
    return null;
  return {
    key,
    id,
    cwd,
    name,
    created,
    archivedAt,
    messageCount,
    firstMessage,
    size,
    status,
    ...(restorePending ? { restorePending: true } : {}),
  } as ArchivedSessionInfo;
}

const MEDIA_HASH_RE = /^[0-9a-f]{64}$/;

/** Ops that rewrite or move a session's file: an exiting orphan of that session may still flush it. */
const ORPHAN_SENSITIVE_OPS: Partial<Record<keyof SessionOps, true>> = {
  archiveSession: true,
  deleteSession: true,
  renameSessionFile: true,
};

function remoteSessionOps(hostId: string): SessionOps {
  const ops: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [op, params] of Object.entries(SESSION_OP_PARAMS) as [
    keyof SessionOps,
    readonly string[],
  ][]) {
    ops[op] = async (...args) => {
      if (op === "readMedia" && !MEDIA_HASH_RE.test(String(args[0]))) {
        return {
          ok: false,
          status: 400,
          code: "invalid_hash",
          error: "Invalid media hash",
        };
      }
      if (ORPHAN_SENSITIVE_OPS[op]) await orphanExit(hostId, String(args[0]));
      const result = await request(
        hostId,
        op,
        Object.fromEntries(params.map((name, i) => [name, args[i]])),
        linkTimings.opTimeoutMs,
      );
      if (op === "listSessionIdsForRestore") {
        if (
          Array.isArray(result) &&
          result.every((id) => typeof id === "string" && id.length > 0)
        )
          return result;
        throw new HostOpError(
          502,
          "host_bad_result",
          `${labelOf(hostId)} sent an incomplete active-session inventory`,
        );
      }
      const list: ((value: unknown) => object | null) | null =
        op === "listSessions"
          ? sessionEntry
          : op === "listProjects"
            ? projectEntry
            : op === "listArchives"
              ? archiveEntry
              : null;
      // Untrusted list entries: malformed ones are dropped, the rest keep only their known fields.
      if (list && Array.isArray(result))
        return result.map(list).filter((entry) => entry !== null);
      if (!list && validResult(op, result, args)) return result;
      throw new HostOpError(
        502,
        "host_bad_result",
        `${labelOf(hostId)} sent an invalid ${op} result`,
      );
    };
  }
  return ops as unknown as SessionOps;
}

function remoteWorkspaceOps(hostId: string): WorkspaceOps {
  const ops: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [op, params] of Object.entries(WORKSPACE_OP_PARAMS) as [
    keyof WorkspaceOps,
    readonly string[],
  ][]) {
    ops[op] = async (...args) => {
      const link = linkFor(hostId);
      if (link.socket && !link.workspaceOps?.has(op)) {
        throw new HostOpError(
          501,
          "workspace_unsupported",
          `Update or restart the keylime host daemon on ${labelOf(hostId)} to use workspace files`,
        );
      }
      const result = await request(
        hostId,
        op,
        Object.fromEntries(params.map((name, i) => [name, args[i]])),
        op === "publishUpload" ||
          op === "workspaceBranches" ||
          op === "removeRegisteredWorktree" ||
          op === "shipPreview"
          ? UPLOAD_ATTACH_TIMEOUT_MS
          : linkTimings.opTimeoutMs,
      );
      if (!validWorkspaceResult(op, result))
        throw new HostOpError(
          502,
          "host_bad_result",
          `${labelOf(hostId)} sent an invalid ${op} result`,
        );
      return result;
    };
  }
  return ops as unknown as WorkspaceOps;
}

/** An omp child on a linked host. Output that arrives before `RpcProcess`
 * subscribes is held for the first listener, as the local transport does, up
 * to channelBufferBytes: overflow closes this server's membership. */
export class RemoteRpcTransport implements RpcTransport {
  readonly hostId: string;
  readonly ch: string;
  /** Every linked daemon owns its children's lifecycle (RpcTransport reads this). */
  readonly hostOwnedLifecycle = true;
  /** RpcTransport.id: the channel id, for log correlation. */
  get id(): string {
    return this.ch;
  }
  /** Set for a child of a previous run the daemon listed in `hello` (the session it runs); null for children this server spawned. */
  readonly sessionId: string | null;
  /** The session the child last named in a `hello` or `session` frame, else `sessionId`: tags its link samples. */
  session: string | null;
  /** The daemon confirmed the spawn (or listed the channel); until then a `hello` without it is not a loss. */
  spawned = false;
  /** A later start owns this creation proxy too: its allocating attempt may no longer discard it. */
  reusedForCreation = false;
  /** The daemon stopped listing this child: it died while the link was down. Set before the synthesized exit. */
  lost = false;
  /** A listed child being taken over (see reattach): resolves true once adopted, false once killed instead. */
  adoption: Promise<boolean> | null = null;
  private readonly lineListeners: Array<(line: string) => void> = [];
  private readonly stderrListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  private readonly resyncListeners: Array<() => void> = [];
  private readonly pendingLines: string[] = [];
  private readonly pendingStderr: string[] = [];
  private heldLineBytes = 0;
  private heldStderrBytes = 0;
  private overflowed = false;
  private exitInfo: [number | null, NodeJS.Signals | null] | null = null;
  private closed = false;
  private interested = false;
  private preparing = 0;
  private preparationHandoff = false;
  private opening: OpenChannelRequest | null = null;
  private refreshing = false;

  constructor(hostId: string, ch: string, sessionId: string | null = null) {
    this.hostId = hostId;
    this.ch = ch;
    this.sessionId = sessionId;
    this.session = sessionId;
  }

  write(line: string, callback: (error?: Error | null) => void): void {
    if (this.exitInfo || this.closed)
      return callback(new Error("RPC process is not running"));
    // sendDown would drop it: a command waiting on it fails now instead of at its timeout.
    if (hub().frozen) return callback(new Error("key lime is shutting down"));
    try {
      // Kept in the link outbox until the daemon acks it, across reconnects; queued per channel, in order.
      sendDown(
        linkFor(this.hostId),
        { type: "stdin", ch: this.ch, line },
        this.ch,
      );
      callback(null);
    } catch (error) {
      // Nothing was queued: a command too large for the link is refused like an oversize request body.
      if (error instanceof LinkLimitError)
        return callback(
          new HostOpError(
            413,
            "request_too_large",
            "Agent command is too large",
          ),
        );
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
    for (const line of this.pendingLines.splice(0)) listener(line);
    this.heldLineBytes = 0;
  }

  onStderr(listener: (chunk: string) => void): void {
    this.stderrListeners.push(listener);
    for (const chunk of this.pendingStderr.splice(0)) listener(chunk);
    this.heldStderrBytes = 0;
  }

  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.exitListeners.push(listener);
    const info = this.exitInfo;
    if (info) queueMicrotask(() => listener(info[0], info[1]));
  }

  /** The host dropped buffered output for this child; the session must reconcile. */
  onResync(listener: () => void): void {
    this.resyncListeners.push(listener);
  }

  /** The link has no stdin EOF: closing input leaves the shared channel (the host owns the child). */
  endInput(): void {
    this.close();
  }

  killTree(force: boolean): void {
    if (this.exitInfo) return;
    sendDown(
      linkFor(this.hostId),
      { type: "kill", ch: this.ch, force },
      this.ch,
    );
  }

  setInterest(on: boolean): void {
    if (this.closed || this.exitInfo || this.interested === on) return;
    this.interested = on;
    this.sendInterest();
  }

  /** `takeOver`: only the command that asked its open for a preparation lease inherits it, never an unrelated one. */
  setPreparing(on: boolean, takeOver = false): void {
    if (this.closed || this.exitInfo) return;
    const wasPreparing = this.preparing > 0;
    this.preparing = Math.max(0, this.preparing + (on ? 1 : -1));
    if (on && takeOver && this.preparationHandoff) {
      this.preparationHandoff = false;
      this.preparing -= 1; // The first real command takes over the open-to-send lease without a false gap.
    }
    if (wasPreparing !== this.preparing > 0) this.sendInterest();
  }

  /** Acquire (rejects 409 `session_busy` while another web app edits) or release the host's history-edit lease. */
  async setEditing(on: boolean): Promise<void> {
    if (this.closed || this.exitInfo) return;
    await request(this.hostId, "editLease", { ch: this.ch, on });
  }

  private sendInterest(): void {
    sendDown(
      linkFor(this.hostId),
      {
        type: "interest",
        ch: this.ch,
        on: this.interested,
        preparing: this.preparing > 0,
      },
      this.ch,
    );
  }

  async setHostTools(
    tools: unknown[],
    schemes: HostUriScheme[],
  ): Promise<void> {
    if (this.closed || this.exitInfo) throw new Error("RPC channel is closed");
    validateHostTools(tools, schemes);
    sendDown(
      linkFor(this.hostId),
      { type: "host_tools", ch: this.ch, tools, schemes },
      this.ch,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const link = linkFor(this.hostId);
    if (link.channels.get(this.ch) === this) link.channels.delete(this.ch);
    if (!this.exitInfo)
      void request(this.hostId, "close", { ch: this.ch }).catch(() => {});
    this.deliverExit(null, null);
  }

  noteOpen(opening: OpenChannelRequest): void {
    // Reconciliation is a read/join, never another explicit advisor change.
    this.opening = {
      sessionId: opening.sessionId,
      launch: opening.launch,
      expectedChannel: this.ch,
    };
    if (opening.preparing && !this.preparationHandoff) {
      this.preparationHandoff = true;
      this.preparing += 1;
    }
    if (this.interested || this.preparing > 0) this.sendInterest();
  }

  /** A wrapper reads this child's lines (else they are held for the one adopting it). */
  get listening(): boolean {
    return this.lineListeners.length > 0;
  }

  replayOpen(pending: string[], streaming: string | null): void {
    if (this.lineListeners.length === 0) return;
    notify(this.resyncListeners);
    for (const line of pending) this.deliverLine(line);
    if (streaming) this.deliverLine(streaming);
  }

  async resync(): Promise<void> {
    if (!this.opening || this.refreshing || this.closed || this.exitInfo)
      return;
    this.refreshing = true;
    try {
      const sessionId = this.session ?? this.opening.sessionId;
      if (!sessionId)
        throw new Error(
          "The shared channel has not reported its session identity",
        );
      await request(
        this.hostId,
        "open",
        { ...this.opening, sessionId },
        linkTimings.opTimeoutMs,
        (value) => {
          if (
            !isOpenResult(value) ||
            value.ch !== this.ch ||
            value.pending === null
          )
            throw new Error("Host could not reconcile the shared channel");
          this.refreshing = false;
          if (this.interested || this.preparing > 0) this.sendInterest();
          notify(this.resyncListeners);
          for (const line of value.pending) this.deliverLine(line);
          if (value.streaming) this.deliverLine(value.streaming);
        },
      );
    } catch (error) {
      // A redial's hello reattaches this channel and retries its snapshot.
      if (error instanceof HostOpError && error.code === "host_offline") return;
      this.close();
      console.warn(
        `[keylime] closed shared channel ${this.ch}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.refreshing = false;
    }
  }

  /** The byte size of `text` when it may be held for a listener; null past the cap, where the child is killed once. */
  private holdable(text: string): number | null {
    const bytes = Buffer.byteLength(text);
    if (
      !this.overflowed &&
      this.heldLineBytes + this.heldStderrBytes + bytes <=
        LINK_LIMITS.channelBufferBytes
    )
      return bytes;
    if (!this.overflowed) {
      this.overflowed = true;
      this.close();
    }
    return null;
  }

  deliverLine(line: string): void {
    if (this.closed) return;
    if (line.includes('"t":"hello"') || line.includes('"t":"session"'))
      this.noteSession(line);
    if (this.lineListeners.length > 0) return notify(this.lineListeners, line);
    const bytes = this.holdable(line);
    if (bytes === null) return;
    this.pendingLines.push(line);
    this.heldLineBytes += bytes;
  }

  deliverStderr(chunk: string): void {
    if (this.stderrListeners.length > 0)
      return notify(this.stderrListeners, chunk);
    const bytes = this.holdable(chunk);
    if (bytes === null) return;
    this.pendingStderr.push(chunk);
    this.heldStderrBytes += bytes;
  }

  deliverResync(): void {
    notify(this.resyncListeners);
    void this.resync();
  }

  /** Set when the host stopped the child on purpose (see the `exit` message's `reason`). */
  stopReason?: string;

  deliverExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    reason?: string,
  ): void {
    if (this.exitInfo) return;
    this.stopReason = reason;
    this.exitInfo = [code, signal];
    notify(this.exitListeners, code, signal);
  }

  private noteSession(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (
      isRecord(frame) &&
      (frame.t === "hello" || frame.t === "session") &&
      typeof frame.sessionId === "string" &&
      isValidSessionId(frame.sessionId)
    ) {
      this.session = frame.sessionId;
    }
  }
}

function isSpawnResult(value: unknown): value is {
  cwd: string;
  fellBack: boolean;
  launchAdvisor: boolean;
  autoApproveExtension: boolean;
} {
  return (
    isRecord(value) &&
    typeof value.cwd === "string" &&
    typeof value.fellBack === "boolean" &&
    typeof value.launchAdvisor === "boolean" &&
    typeof value.autoApproveExtension === "boolean"
  );
}

function isOpenResult(value: unknown): value is OpenChannelResult {
  if (!isRecord(value)) return false;
  const { ch, joined, pending, streaming, advisorSpawned, registration } =
    value;
  if (registration !== undefined) {
    if (
      !isRecord(registration) ||
      !Array.isArray(registration.tools) ||
      !Array.isArray(registration.schemes)
    )
      return false;
    try {
      validateHostTools(registration.tools, registration.schemes);
    } catch {
      return false;
    }
  }
  return (
    isSpawnResult(value) &&
    typeof ch === "string" &&
    ch.length > 0 &&
    typeof joined === "boolean" &&
    typeof advisorSpawned === "boolean" &&
    (pending === null ||
      (Array.isArray(pending) &&
        pending.every((line) => typeof line === "string"))) &&
    (streaming === null || typeof streaming === "string")
  );
}

/** Legacy hosts retain their single-server lifecycle and notification behaviour. */
export function hostOwnsLifecycle(hostId: string): boolean {
  return hub().links.get(hostId)?.shared === true;
}

/** A linked machine: the `Host` calls go over its link. */
export class RemoteHost implements Host {
  readonly id: string;
  readonly sessionOps: SessionOps;
  readonly workspaceOps: WorkspaceOps;

  constructor(id: string) {
    this.id = id;
    this.sessionOps = remoteSessionOps(id);
    this.workspaceOps = remoteWorkspaceOps(id);
  }

  getSettings() {
    return getRemoteHostSettings(this.id);
  }

  setSettings(patch: HostSettingsPatch) {
    return setRemoteHostSettings(this.id, patch);
  }

  listModels(refresh?: boolean) {
    return listRemoteHostModels(this.id, refresh);
  }

  async getUsageReport(options: UsageQueryOptions): Promise<UsageReport> {
    const result = await request(
      this.id,
      "usageReport",
      { ...options },
      180_000,
    );
    if (!Value.Check(UsageReportSchema, result))
      throw new HostOpError(
        502,
        "invalid_host_result",
        "Invalid host usage report",
      );
    return result;
  }

  supportsWorkspaceOp(name: keyof WorkspaceOps): boolean {
    return linkFor(this.id).workspaceOps?.has(name) ?? false;
  }

  get label(): string {
    return labelOf(this.id);
  }

  status(): HostStatus {
    return linkFor(this.id).status;
  }

  onStatus(listener: (status: HostStatus) => void): () => void {
    const listeners = linkFor(this.id).statusListeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async spawnRpc(
    spawnRequest: SpawnRequest,
    sessionId: string | null = null,
    options?: {
      replaceAdvisor?: boolean;
      preparing?: boolean;
      expectedChannel?: string;
    },
  ): Promise<SpawnResult> {
    const link = linkFor(this.id);
    if (link.status === "omp-missing")
      throw new HostOpError(
        503,
        "host_omp_missing",
        `omp is not installed on ${this.label}`,
      );
    const { creationId } = spawnRequest;
    if (creationId !== undefined) {
      if (typeof creationId !== "string" || !CREATION_ID_RE.test(creationId)) {
        throw new HostOpError(
          400,
          "invalid_request",
          "Invalid creation identity",
        );
      }
    }
    // A pure join cannot start a child; new remote launches require a registry record.
    if (options?.expectedChannel === undefined && this.id !== LOCAL_HOST_ID) {
      try {
        if (!readHosts().some((host) => host.id === this.id))
          throw new HostOpError(
            409,
            "host_unregistered",
            "This host is no longer in the linked-hosts registry; no session was started",
          );
      } catch (error) {
        if (!(error instanceof HostRegistryUnreadableError)) throw error;
        throw new HostOpError(
          503,
          "host_registry_unreadable",
          "The linked-hosts registry cannot be read; no session was started",
        );
      }
    }
    const opening: OpenChannelRequest = {
      sessionId,
      launch: spawnRequest,
      ...options,
    };
    // An open may wait for a cold child's `ready`, which sends nothing meanwhile.
    return (await request(
      this.id,
      "open",
      opening,
      LINK_LIMITS.channelReadyMs + linkTimings.opTimeoutMs,
      (value) => {
        if (
          !isOpenResult(value) ||
          (options?.expectedChannel !== undefined &&
            value.ch !== options.expectedChannel)
        ) {
          throw new HostOpError(
            502,
            "host_bad_result",
            `${this.label} sent an invalid open result`,
          );
        }
        if (value.pending === null) {
          void request(this.id, "close", { ch: value.ch }).catch(() => {});
          throw new HostOpError(
            502,
            "host_pending_overflow",
            "The shared channel's pending requests could not be restored",
          );
        }
        const transport =
          link.channels.get(value.ch) ??
          new RemoteRpcTransport(this.id, value.ch, sessionId);
        if (creationId !== undefined && link.channels.has(value.ch))
          transport.reusedForCreation = true;
        transport.spawned = true;
        transport.noteOpen(opening);
        link.channels.set(value.ch, transport);
        link.autoApprove = value.autoApproveExtension;
        // An adopting wrapper already gets every line of a continuous member, held here: the snapshot would repeat them out of order.
        const streaming =
          value.continuous === true && !transport.listening
            ? null
            : value.streaming;
        transport.replayOpen(value.pending, value.streaming);
        return {
          transport,
          cwd: value.cwd,
          fellBack: value.fellBack,
          launchAdvisor: value.launchAdvisor,
          advisorSpawned: value.advisorSpawned,
          joined: value.joined,
          registration: value.registration,
          pending: value.pending,
          streaming,
        };
      },
    )) as SpawnResult;
  }

  async sessionFileExists(path: string): Promise<boolean> {
    const exists = await request(this.id, "sessionFileExists", { path });
    if (typeof exists !== "boolean")
      throw new HostOpError(
        502,
        "host_bad_result",
        `${this.label} sent an invalid sessionFileExists result`,
      );
    return exists;
  }

  invalidateSessionLists(sessionFile?: string): void {
    // Best effort, like the local cache drop.
    request(this.id, "invalidateSessionLists", { path: sessionFile }).catch(
      () => {},
    );
  }

  autoApproveExtension(): boolean {
    return linkFor(this.id).autoApprove;
  }
}

/** The credential on the active link, only while it still matches the registry. */
export function getShipHostCredential(hostId: string): string | undefined {
  if (hub().frozen) return;
  const credential = hub().links.get(hostId)?.socket?.data.hostCredential;
  if (
    credential &&
    loadHosts().some(
      (host) => host.id === hostId && host.tokenHash === credential,
    )
  )
    return credential;
}

/** `local` is this machine, reached through its daemon link (offline while none is linked); other ids must be registered hosts. */
export function getHost(id: typeof LOCAL_HOST_ID): Host;
export function getHost(id: string): Host | null;
export function getHost(id: string): Host | null {
  return id === LOCAL_HOST_ID || loadHosts().some((h) => h.id === id)
    ? linkFor(id).host
    : null;
}

export function listHosts(): LinkedHostRow[] {
  return loadHosts()
    .filter((record) => record.id !== LOCAL_HOST_ID)
    .map((record) => {
      const link = hub().links.get(record.id);
      return {
        id: record.id,
        label: record.label,
        status: link?.status ?? "offline",
        ompVersion: link?.ompVersion ?? null,
        keylimeVersion: link?.keylimeVersion ?? null,
        platform: link?.platform ?? null,
        lastSeenAt: link?.lastSeenAt ?? record.lastSeenAt,
        connectionId: link?.connectionId ?? null,
        hostVersion: link?.hostVersion ?? null,
        serverVersion: LINK_PROTOCOL_VERSION,
        workspaceOps: [...(link?.workspaceOps ?? [])],
        ...(link?.canStageArtifact && { canStageArtifact: true }),
        ...(link?.canActivateArtifact && { canActivateArtifact: true }),
        ...(link?.releaseArch && { arch: link.releaseArch }),
      };
    });
}

/** This machine first, then linked hosts; shared by GET /api/hosts and its live stream. */
export function hostsSnapshot(): HostSnapshot {
  const link = hub().links.get(LOCAL_HOST_ID);
  const local: LocalHostRow = {
    id: "local",
    label: customLocalLabel(),
    status: link?.status ?? "offline",
    ompVersion: link?.ompVersion ?? null,
    keylimeVersion: link?.keylimeVersion ?? null,
    platform: link?.platform ?? null,
    lastSeenAt: null,
    hostVersion: link?.hostVersion ?? null,
    serverVersion: LINK_PROTOCOL_VERSION,
    workspaceOps: [...(link?.workspaceOps ?? [])],
    ...(link?.canStageArtifact && { canStageArtifact: true }),
    serverPlatform: process.platform,
    daemonManaged: process.env.NODE_ENV !== "development",
  };
  return { hosts: [local, ...listHosts()] };
}

/** Publish enrollment, rename, and revocation. Links also publish their own changes. */
export function notifyHostsChange(): void {
  notify(hub().changeListeners);
}

/** When the host last sent anything on its uplink (pongs included); null when it has no link here. */
export function lastUplinkAt(hostId: string): number | null {
  const lastSeenAt = hub().links.get(hostId)?.lastSeenAt;
  return lastSeenAt ? Date.parse(lastSeenAt) : null;
}

export function getHostLinkProtocol(hostId: string): number | null {
  return hub().links.get(hostId)?.hostVersion ?? null;
}

export function getHostOmpVersion(hostId: string): string | null {
  return hub().links.get(hostId)?.ompVersion ?? null;
}

export function onHostsChange(listener: () => void): () => void {
  const listeners = hub().changeListeners;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Fires on every accepted hello with the omp children the daemon still runs. Listeners
 * run after reattach: lost channels have exited, others are adopted, retained by the journal, or killed. */
export function onHostHello(
  listener: (hostId: string, channels: HelloChannel[]) => void,
): () => void {
  const listeners = hub().helloListeners;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether this server adopted a child of `sessionId` the host listed in a hello; waits for an adoption still running. */
export async function adoptedChild(
  hostId: string,
  sessionId: string,
): Promise<boolean> {
  const listed = [...(hub().links.get(hostId)?.channels.values() ?? [])].filter(
    (child) => child.sessionId === sessionId,
  );
  return (await Promise.all(listed.map((child) => child.adoption))).includes(
    true,
  );
}

/** Whether this host may still run the session. Missing listing data does not prove absence. */
export function hostListsChild(sessionId: string, hostId = "local"): boolean {
  const link = hub().links.get(hostId);
  return (
    !!link &&
    isLinkUp(link.status) &&
    (link.listedSessions?.has(sessionId) ?? true)
  );
}

/** Resolves once every child of `sessionId` the host listed in a hello has exited or been adopted.
 * Rejects with 503 if the host goes offline first: waiting through an outage
 * would hold the session's start lock until the host redials. */
export async function orphanExit(
  hostId: string,
  sessionId: string,
): Promise<void> {
  const link = hub().links.get(hostId);
  const listed = [...(link?.channels.values() ?? [])].filter(
    (child) => child.sessionId === sessionId,
  );
  if (!link || listed.length === 0) return;
  const { promise: offline, reject } = Promise.withResolvers<never>();
  const onStatus = (status: HostStatus) => {
    if (!isLinkUp(status))
      reject(
        new HostOpError(503, "host_offline", `${labelOf(hostId)} is offline`),
      );
  };
  onStatus(link.status);
  link.statusListeners.add(onStatus);
  const gone = listed.map((child) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    child.onExit(() => resolve());
    // An adopted child runs the live session: not an orphan to wait for.
    void child.adoption?.then((adopted) => adopted && resolve());
    return promise;
  });
  try {
    await Promise.race([offline, Promise.all(gone)]);
  } finally {
    link.statusListeners.delete(onStatus);
  }
}

/** An attach may copy 2 GiB (to another device): far longer than an op's usual deadline. */
const UPLOAD_ATTACH_TIMEOUT_MS = 10 * 60_000;
/** Read-only browser operations are sent to the daemon owning the session. */
export async function hostBrowserList(
  hostId: string,
  sessionId: string,
): Promise<BrowserListResult> {
  const value = await request(hostId, "browserList", { sessionId });
  if (!Value.Check(BrowserListSchema, value))
    throw new HostOpError(
      502,
      "invalid_browser_result",
      "Invalid browser result from host",
    );
  return value;
}

export async function hostBrowserCapture(
  hostId: string,
  sessionId: string,
  tabId: string,
): Promise<BrowserCaptureResult> {
  const value = await request(hostId, "browserCapture", { sessionId, tabId });
  if (!Value.Check(BrowserFrameSchema, value))
    throw new HostOpError(
      502,
      "invalid_browser_result",
      "Invalid browser result from host",
    );
  return value;
}
export async function hostBrowserVideo(
  hostId: string,
  sessionId: string,
  command: BrowserVideoRequest,
): Promise<unknown> {
  const op =
    command.op === "start"
      ? "browserVideoStart"
      : command.op === "next"
        ? "browserVideoNext"
        : "browserVideoStop";
  const value = await request(hostId, op, { sessionId, input: command.input });
  const schema =
    command.op === "start"
      ? BrowserVideoStartResultSchema
      : command.op === "next"
        ? BrowserVideoNextResultSchema
        : BrowserVideoStopResultSchema;
  if (!Value.Check(schema, value))
    throw new HostOpError(
      502,
      "invalid_browser_result",
      "Invalid browser video result from host",
    );
  if (
    command.op === "next" &&
    Value.Check(BrowserVideoNextResultSchema, value) &&
    value.packets.reduce((n, packet) => n + packet.data.length, 0) > 512 * 1024
  )
    throw new HostOpError(
      502,
      "invalid_browser_result",
      "Invalid browser video result from host",
    );
  return value;
}

/** Send an ordered batch to the owning host without retrying uncertain partial delivery. */
export async function hostBrowserControl(
  hostId: string,
  sessionId: string,
  control: BrowserControlArgs,
): Promise<BrowserControlResult> {
  const value = await request(hostId, "browserControl", { sessionId, control });
  if (!Value.Check(BrowserControlResultSchema, value))
    throw new HostOpError(
      502,
      "invalid_browser_result",
      "Invalid browser result from host",
    );
  return value;
}

/** An upload op on `hostId`'s daemon (an offline one fails 503). */
export function hostUploadOp(
  hostId: string,
  op: "uploadStart" | "uploadAbort" | "uploadAttach" | "stageHostArtifact",
  args: Record<string, unknown>,
): Promise<unknown> {
  if (op === "stageHostArtifact") {
    const link = hub().links.get(hostId);
    if (link?.socket && isLinkUp(link.status) && !link.canStageArtifact)
      return Promise.reject(
        new HostOpError(
          501,
          "host_artifact_unsupported",
          "This daemon does not support artifact staging",
        ),
      );
  }
  return request(
    hostId,
    op,
    args,
    op === "uploadAttach" ? UPLOAD_ATTACH_TIMEOUT_MS : linkTimings.opTimeoutMs,
  );
}

/** Activation is for standalone remote hosts, never the paired local services. */
export async function hostArtifactActivationOp(
  hostId: string,
  ...[op, args]:
    | ["activateHostArtifact", ActivateHostArtifactArgs]
    | ["hostArtifactActivationStatus", HostArtifactActivationArgs]
): Promise<HostArtifactActivationResult> {
  if (hostId === LOCAL_HOST_ID || !getHost(hostId))
    throw new HostOpError(404, "host_not_found", "Select a linked remote host");
  const link = hub().links.get(hostId);
  if (
    op === "activateHostArtifact" &&
    link?.socket &&
    isLinkUp(link.status) &&
    !link.canActivateArtifact
  )
    throw new HostOpError(
      501,
      "host_activation_unsupported",
      "This daemon does not support artifact activation",
    );
  const result = await request(hostId, op, args);
  if (!Value.Check(HostArtifactActivationResultSchema, result))
    throw new HostOpError(
      502,
      "host_bad_result",
      "The host did not send a valid activation result",
    );
  return result;
}

function binaryDigestsUnsupported(): HostOpError {
  return new HostOpError(
    501,
    "host_binary_digests_unsupported",
    "This daemon does not report installed binary digests",
  );
}

export async function readHostInstalledBinaryDigests(
  hostId: string,
): Promise<HostInstalledBinaryDigests> {
  if (hostId === LOCAL_HOST_ID || !getHost(hostId))
    throw new HostOpError(404, "host_not_found", "Select a linked remote host");
  const result = await request(hostId, "hostInstalledBinaryDigests", {});
  if (!Value.Check(HostInstalledBinaryDigestsSchema, result))
    throw new HostOpError(
      502,
      "host_bad_result",
      "The host did not send valid installed binary digests",
    );
  return result;
}

/** Releases are available only to live standalone hosts that can install a pair. */
export function hostReleaseTarget(hostId: string): {
  platform: string;
  arch: string;
} {
  if (hostId === LOCAL_HOST_ID || !getHost(hostId))
    throw new HostOpError(404, "host_not_found", "Select a linked remote host");
  const link = hub().links.get(hostId);
  if (!link?.socket || !isLinkUp(link.status))
    throw new HostOpError(503, "host_offline", "The selected host is offline");
  const { platform, releaseArch: arch } = link;
  if (
    !link.canActivateArtifact ||
    (platform !== "linux" && platform !== "darwin") ||
    (arch !== "x64" && arch !== "arm64")
  )
    throw new HostOpError(
      501,
      "host_activation_unsupported",
      "This host does not support release deployment",
    );
  return { platform, arch };
}

export async function getRemoteHostSettings(
  hostId: string,
): Promise<HostSettings> {
  const result = await request(hostId, "hostSettingsGet", {});
  if (!Value.Check(HostSettingsSchema, result))
    throw new HostOpError(
      502,
      "invalid_host_result",
      "Invalid host settings response",
    );
  return result;
}

export async function setRemoteHostSettings(
  hostId: string,
  patch: HostSettingsPatch,
): Promise<HostSettings> {
  const result = await request(hostId, "hostSettingsSet", patch);
  if (!Value.Check(HostSettingsSchema, result))
    throw new HostOpError(
      502,
      "invalid_host_result",
      "Invalid host settings response",
    );
  return result;
}

export async function listRemoteHostModels(
  hostId: string,
  refresh = false,
): Promise<HostModels> {
  const result = await request(hostId, "modelsList", { refresh }, 180_000);
  if (!Value.Check(HostModelsSchema, result))
    throw new HostOpError(
      502,
      "invalid_host_result",
      "Invalid host models response",
    );
  return result;
}

export async function listHostChatRoles(
  hostId: string,
  cwd: string,
  thinkingLevel?: string,
  currentModel?: { provider: string; modelId: string },
): Promise<ChatRoles> {
  const result = await request(
    hostId,
    "chatRolesList",
    {
      cwd,
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(currentModel
        ? {
            currentProvider: currentModel.provider,
            currentModelId: currentModel.modelId,
          }
        : {}),
    },
    180_000,
  );
  if (!Value.Check(ChatRolesSchema, result))
    throw new HostOpError(
      502,
      "invalid_host_result",
      "Invalid chat roles response from host",
    );
  return result;
}

/** Queue upload bytes (at most pieceBytes) for `hostId`'s daemon, fair with its other traffic; false when it has no socket. */
export function sendUploadFrame(
  hostId: string,
  id: string,
  bytes: Uint8Array,
): boolean {
  const link = hub().links.get(hostId);
  if (!link?.socket || hub().frozen) return false;
  link.sender.push(`up:${id}`, { id, blob: bytes });
  flush(link);
  return true;
}

/** Forget upload bytes of `id` not sent yet (a resume or an abort). */
export function dropUploadFrames(hostId: string, id: string): void {
  hub().links.get(hostId)?.sender.drop(`up:${id}`);
}

/** Every host's `upload_ack`s, and null when a host's socket ends (its upload bytes in flight are lost). */
export function onUploadEvent(
  listener: (hostId: string, ack: UploadAck | null) => void,
): () => void {
  const listeners = hub().uploadListeners;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** End a host's link now (revoke). Its daemon gets 401 when it redials and stops its children. */
export function closeHostLink(id: string): void {
  const link = hub().links.get(id);
  if (!link) return;
  hub().links.delete(id);
  stopTimers(link);
  failAllOps(
    link,
    () => new HostOpError(503, "host_offline", "The host link was closed"),
  );
  link.socket?.close();
  endSocket(link);
  // Nothing will report these children again.
  for (const transport of link.channels.values())
    transport.deliverExit(null, null);
  setStatus(link, "offline");
}
