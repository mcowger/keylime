import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CDPSession } from "puppeteer-core";
import type { WorkerTabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { NATIVE_VIDEO_EXTENSION_ID } from "./native-video-extension";
import { CommandError } from "./types";

// The helper protocol is adapted from paseo-plugins (MIT); see native-video-LICENSE.txt.
const MAX_BYTES = 512 * 1024;
const MAX_PACKETS = 8;
const IDLE_MS = 10_000;
type Cdp = CDPSession;
type Packet = { type: "key" | "delta"; timestamp: number; capturedAt: number; width: number; height: number; data: string };
const packetSchema = Type.Object({
  streamId: Type.String(), sequence: Type.Integer(), captureGeneration: Type.Integer(),
  timestampUs: Type.Integer({ minimum: 0 }), type: Type.Union([Type.Literal("key"), Type.Literal("delta")]),
  width: Type.Number(), height: Type.Number(), dataBase64: Type.String({ minLength: 4 }),
});
type Lease = { id: string; source: Stream; packets: Packet[]; bytes: number; needsKey: boolean; lastRead: number };
type Stream = {
  id: string; tabId: string; owner: string; tab: WorkerTabSession;
  current: () => boolean; browserCdp: Cdp; helper: Cdp; helperId: string;
  width: number; height: number; codec: string; leases: Set<Lease>;
  failure: boolean; closed: boolean;
};
const streams = new Map<string, Lease>();
const sources = new Map<WorkerTabSession, Stream>();
const pending = new Map<WorkerTabSession, Promise<Stream>>();

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error("Native video helper unavailable");
  return result.result?.value as unknown;
}
function close(stream: Stream): void {
  if (stream.closed) return;
  stream.closed = true;
  sources.delete(stream.tab);
  for (const lease of stream.leases) streams.delete(lease.id);
  stream.leases.clear();
  void (async () => {
    try { await Promise.race([evaluate(stream.helper, "stopCapture()"), Bun.sleep(1000)]); } catch {}
    try { await stream.helper.detach(); } catch {}
    try { await stream.browserCdp.send("Target.closeTarget", { targetId: stream.helperId }); } catch {}
    try { await stream.browserCdp.detach(); } catch {}
  })();
}
const reaper = setInterval(() => {
  const now = Date.now();
  for (const lease of streams.values()) {
    if (!lease.source.current() || now - lease.lastRead > IDLE_MS) closeLease(lease);
  }
}, 1000);
reaper.unref();

export async function startVideo(tab: WorkerTabSession, tabId: string, owner: string, current: () => boolean) {
  if (streams.size >= 32) throw new CommandError("Browser video capacity reached", "unavailable");
  let source = sources.get(tab);
  if (!source) {
    let opening = pending.get(tab);
    if (!opening) {
      if (sources.size + pending.size >= 8) throw new CommandError("Browser video capacity reached", "unavailable");
      let expired = false;
      const deadline = Promise.withResolvers<never>();
      const timer = setTimeout(() => {
        expired = true;
        deadline.reject(new CommandError("Native browser video timed out", "unavailable"));
      }, 5000);
      const work = startVideoInner(tab, tabId, owner, () => !expired && current());
      opening = Promise.race([work, deadline.promise]);
      pending.set(tab, opening);
      void opening.finally(() => clearTimeout(timer)).catch(() => {});
      void work.finally(() => { pending.delete(tab); }).catch(() => {});
    }
    source = await opening;
  }
  if (!current() || source.closed || source.failure || source.owner !== owner || source.tabId !== tabId) {
    if (!source.leases.size) close(source);
    throw new CommandError("Browser video unavailable", "unavailable");
  }
  const lease: Lease = { id: randomUUID(), source, packets: [], bytes: 0, needsKey: true, lastRead: Date.now() };
  source.leases.add(lease);
  streams.set(lease.id, lease);
  void evaluate(source.helper, 'requestKeyFrame("medium")').catch(() => {});
  return { streamId: lease.id, codec: source.codec, width: source.width, height: source.height };
}

function closeLease(lease: Lease): void {
  streams.delete(lease.id);
  lease.source.leases.delete(lease);
  lease.packets = [];
  if (!lease.source.leases.size) close(lease.source);
}

async function startVideoInner(tab: WorkerTabSession, tabId: string, owner: string, current: () => boolean) {
  if (!current()) throw new CommandError("Browser tab not found", "not_found");
  const browser = tab.browser.browser;
  const target = browser.targets().find((item) => "_targetId" in item && item._targetId === tabId);
  if (!target) throw new CommandError("Browser tab not found", "not_found");
  const pageCdp = await target.createCDPSession();
  let width: number, height: number;
  try {
    const metrics = await pageCdp.send("Page.getLayoutMetrics");
    width = Math.floor(metrics.cssVisualViewport.clientWidth);
    height = Math.floor(metrics.cssVisualViewport.clientHeight);
    if (!current() || width <= 0 || height <= 0 || width > 8192 || height > 8192)
      throw new Error("Browser viewport unavailable");
  } finally { void pageCdp.detach().catch(() => {}); }
  const browserCdp = await browser.target().createCDPSession();
  let helperId = "";
  let helper: Cdp;
  let stream: Stream | undefined;
  try {
    const created = await browserCdp.send("Target.createTarget", {
      url: `chrome-extension://${NATIVE_VIDEO_EXTENSION_ID}/recorder.html`, background: true, hidden: true,
    });
    helperId = created.targetId;
    if (!current()) throw new Error("Browser tab changed");
    const helperTarget = await browser.waitForTarget(
      (item) => "_targetId" in item && item._targetId === helperId, { timeout: 5000 },
    );
    helper = await helperTarget.createCDPSession();
    await helper.send("Performance.enable");
    const before = Date.now();
    const metrics = await helper.send("Performance.getMetrics");
    const after = Date.now();
    const sourceClock = metrics.metrics.find((metric) => metric.name === "Timestamp")?.value;
    if (sourceClock === undefined || after - before > 1000) throw new Error("Native video clock unavailable");
    const epochOffset = (before + after) / 2 - sourceClock * 1000;
    await helper.send("Runtime.enable");
    await helper.send("Runtime.addBinding", { name: "nativeVideoPacket" });
    const id = randomUUID();
    stream = { id, tabId, owner, tab, current, browserCdp, helper, helperId, width, height, codec: "", leases: new Set(), failure: false, closed: false };
    const state = stream;
    helper.on("Runtime.bindingCalled", (event: { name: string; payload: string }) => {
      if (event.name !== "nativeVideoPacket" || event.payload.length > 3_000_000 || state.closed) return;
      let raw: unknown;
      try { raw = JSON.parse(event.payload); } catch { return; }
      if (raw && typeof raw === "object" && "error" in raw) { state.failure = true; return; }
      if (!Value.Check(packetSchema, raw) || raw.streamId !== id) return;
      void evaluate(helper, `acknowledge(${JSON.stringify(id)},${raw.sequence})`).catch(() => {});
      if (!state.current() || raw.captureGeneration !== 1 || raw.width !== width || raw.height !== height) return;
      const data = raw.dataBase64;
      let requestKey = false;
      for (const lease of state.leases) {
        if (data.length > MAX_BYTES || lease.bytes + data.length > MAX_BYTES || lease.packets.length >= MAX_PACKETS) {
          lease.packets = []; lease.bytes = 0; lease.needsKey = true; requestKey = true;
          continue;
        }
        if (lease.needsKey && raw.type !== "key") continue;
        if (raw.type === "key") lease.needsKey = false;
        lease.packets.push({ type: raw.type, timestamp: raw.timestampUs, capturedAt: Math.round(epochOffset + raw.timestampUs / 1000), width, height, data });
        lease.bytes += data.length;
      }
      if (requestKey) void evaluate(helper, 'requestKeyFrame("medium")').catch(() => {});
    });
    const ready = await evaluate(helper, 'new Promise(resolve => { if (document.readyState === "complete") resolve(typeof startCapture === "function"); else addEventListener("load", () => resolve(typeof startCapture === "function"), {once:true}); })');
    if (!ready || !current()) throw new Error("Native video helper unavailable");
    await evaluate(helper, `startCapture(${JSON.stringify(tabId)},${width},${height},1)`);
    const encoder = await evaluate(helper, `addEncoder("medium",${JSON.stringify(id)})`);
    if (!current() || stream.closed || !encoder || typeof encoder !== "object" || !("codec" in encoder) || typeof encoder.codec !== "string") throw new Error("Browser tab changed");
    stream.codec = encoder.codec;
    sources.set(tab, stream);
    return stream;
  } catch {
    if (stream) close(stream);
    else {
      if (helperId) void browserCdp.send("Target.closeTarget", { targetId: helperId }).catch(() => {});
      void browserCdp.detach().catch(() => {});
    }
    throw new CommandError("Native browser video is unavailable", "unavailable");
  }
}

function getStream(id: string, tabId: string, owner: string): Lease {
  const lease = streams.get(id);
  const source = lease?.source;
  if (!lease || !source || source.tabId !== tabId || source.owner !== owner || !source.current()) {
    if (lease && source?.owner === owner) closeLease(lease);
    throw new CommandError("Browser video stream not found", "not_found");
  }
  if (source.failure) { close(source); throw new CommandError("Browser video stopped", "unavailable"); }
  return lease;
}
export async function nextVideo(id: string, tabId: string, owner: string) {
  const lease = getStream(id, tabId, owner);
  const stream = lease.source;
  lease.lastRead = Date.now();
  try {
    await Promise.race([
      evaluate(stream.helper, 'touchEncoder("medium")'),
      Bun.sleep(2000).then(() => { throw new Error("Video helper timed out"); }),
    ]);
  } catch {
    close(stream);
    throw new CommandError("Browser video stopped", "unavailable");
  }
  if (!lease.packets.length) await Bun.sleep(100);
  getStream(id, tabId, owner);
  const packets = lease.packets;
  lease.packets = []; lease.bytes = 0;
  return { width: stream.width, height: stream.height, packets, serverTime: Date.now() };
}
export function stopVideo(id: string, tabId: string, owner: string) {
  closeLease(getStream(id, tabId, owner));
  return {};
}
