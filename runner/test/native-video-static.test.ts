import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "../src/commands/native-video-extension-source";

test.each([true, false])("static capture supplies keyframes when frame precedes encoder: %s", async (frameBeforeEncoder) => {
  let controller!: ReadableStreamDefaultController<Frame>;
  const readable = new ReadableStream<Frame>({ start(c) { controller = c; } });
  const packets: Record<string, unknown>[] = [];
  let reportProgress!: () => void;
  let timerCleared = false;
  const consumed = Promise.withResolvers<void>();
  class Frame {
    timestamp = 1000000;
    displayWidth = 640;
    displayHeight = 480;
    format = "I420";
    clone() { consumed.resolve(); return new Frame(); }
    close() {}
  }
  class Encoder {
    static async isConfigSupported(config: unknown) { return { supported: true, config }; }
    encodeQueueSize = 0;
    pending: Frame[] = [];
    constructor(private callbacks: { output: (chunk: { timestamp: number; type: string; byteLength: number; copyTo: (bytes: Uint8Array) => void }, metadata: object) => void }) {}
    configure() {}
    encode(frame: Frame) { this.pending.push(frame); }
    async flush() {
      for (const frame of this.pending.splice(0)) this.callbacks.output({ timestamp: frame.timestamp, type: "key", byteLength: 3, copyTo(bytes: Uint8Array) { bytes.set([1, 2, 3]); } }, {});
    }
    close() {}
  }
  const ctx = createContext({
    chrome: { debugger: { getTargets: async () => [{ id: "target", type: "page", tabId: 1 }] }, tabCapture: { getMediaStreamId: async () => "stream" } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [{ getSettings: () => ({}) }], getTracks: () => [{ stop() {} }] }) } },
    MediaStreamTrackProcessor: class { readable = readable; },
    VideoEncoder: Encoder, VideoFrame: Frame, Uint8Array, performance, btoa,
    setInterval: (callback: () => void) => { reportProgress = callback; return 1; },
    clearInterval: () => { timerCleared = true; },
    nativeVideoPacket: (packet: string) => packets.push(JSON.parse(packet)),
  });
  runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, ctx);
  await runInContext('startCapture("target", 640, 480, 1)', ctx);
  reportProgress();
  expect(packets).toContainEqual(expect.objectContaining({ type: "diagnostic", stage: "capture", event: "progress", frames: 0 }));
  if (frameBeforeEncoder) {
    controller.enqueue(new Frame());
    await consumed.promise;
  }
  await runInContext('addEncoder("medium", "stream")', ctx);
  runInContext('requestKeyFrame("medium")', ctx);
  if (!frameBeforeEncoder) {
    controller.enqueue(new Frame());
    await consumed.promise;
  }
  expect(packets.filter((packet) => packet.type === "key")).toHaveLength(1);
  runInContext('acknowledge("stream", 1); requestKeyFrame("medium")', ctx);
  expect(packets.filter((packet) => packet.type === "key")).toHaveLength(2);
  reportProgress();
  expect(packets).toContainEqual(expect.objectContaining({ type: "diagnostic", stage: "capture", event: "first-frame", width: 640, height: 480 }));
  expect(packets).toContainEqual(expect.objectContaining({ type: "diagnostic", stage: "encoder", event: "first-output", key: true, bytes: 3 }));
  expect(packets).toContainEqual(expect.objectContaining({ type: "diagnostic", stage: "encoder", event: "progress", outputs: 2, packets: 2 }));
  for (const packet of packets.filter((entry) => entry.type === "diagnostic")) {
    expect(packet).not.toHaveProperty("dataBase64");
    expect(packet).not.toHaveProperty("descriptionBase64");
    expect(packet).not.toHaveProperty("streamId");
  }
  await runInContext('stopCapture()', ctx);
  expect(timerCleared).toBe(true);
});
