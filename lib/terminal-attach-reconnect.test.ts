import { expect, mock, test } from "bun:test";
import type { TerminalAttachData } from "./terminal-attach";

let listener: ((event: unknown) => void) | undefined;
let online = true;
mock.module("./hosts/hub", () => ({
  onPtyEvent: (_host: string, _id: string, callback: (event: unknown) => void) => {
    listener = callback;
    return () => { listener = undefined; };
  },
  sendPtyFrame: () => online,
}));
// Load after installing the host-link mock so the gateway observes its events.
const { terminalAttachSocket } = await import("./terminal-attach");

test("host loss and unavailable attach close transiently so clients reconnect", () => {
  const frames: string[] = [];
  const closes: number[] = [];
  const ws = {
    data: { kind: "terminal-attach", hostId: "local", sessionId: "3aa8ab15-162b-4bee-97c8-2b35a65a7b32", id: "attach", started: false },
    send: (value: string) => { frames.push(value); return 1; },
    close: (code: number) => { closes.push(code); },
  } as unknown as Bun.ServerWebSocket<TerminalAttachData>;
  const hello = JSON.stringify({ type: "hello", version: 1, cols: 80, rows: 24 });
  terminalAttachSocket.message(ws, hello);
  listener?.({ type: "snapshot", data: "screen", cols: 80, rows: 24, cursor: 0 });
  listener?.(null);
  expect(closes).toEqual([1013]);
  expect(frames.map(frame => JSON.parse(frame).type)).toEqual(["snapshot"]);
  terminalAttachSocket.close(ws);
  online = false;
  ws.data.started = false;
  terminalAttachSocket.message(ws, hello);
  expect(closes).toEqual([1013, 1013]);
  terminalAttachSocket.close(ws);
  online = true;
  ws.data.started = false;
  terminalAttachSocket.message(ws, hello);
  listener?.({ type: "snapshot", data: "restored", cols: 80, rows: 24, cursor: 1 });
  expect(JSON.parse(frames.at(-1)!).data).toBe("restored");
  terminalAttachSocket.close(ws);
});
