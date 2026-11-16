import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { NATIVE_VIDEO_EXTENSION_SOURCE } from "../src/commands/native-video-extension-source";

test.each([true, false])("static capture supplies keyframes when frame precedes encoder: %s", async (frameBeforeEncoder) => {
  let controller!: ReadableStreamDefaultController<Frame>;
  const readable = new ReadableStream<Frame>({ start(c) { controller = c; } });
  const packets: { type: string }[] = [];
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
    nativeVideoPacket: (packet: string) => packets.push(JSON.parse(packet)),
  });
  runInContext(NATIVE_VIDEO_EXTENSION_SOURCE, ctx);
  await runInContext('startCapture("target", 640, 480, 1)', ctx);
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
  expect(packets.map((packet) => packet.type)).toEqual(["key"]);
  runInContext('acknowledge("stream", 1); requestKeyFrame("medium")', ctx);
  expect(packets.map((packet) => packet.type)).toEqual(["key", "key"]);
  await runInContext('stopCapture()', ctx);
});
