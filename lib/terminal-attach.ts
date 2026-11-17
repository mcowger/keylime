import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { TerminalAttachClientSchema } from "./api-contracts/terminal-attach";
import { onPtyEvent, sendPtyFrame } from "./hosts/hub";
import { isValidSessionId } from "./session-file-references-core";

export interface TerminalAttachData {
  kind: "terminal-attach";
  hostId: string;
  sessionId: string;
  id: string;
  started: boolean;
  timer?: NodeJS.Timeout;
  unsubscribe?: () => void;
}
type Socket = Bun.ServerWebSocket<TerminalAttachData>;

export function terminalAttachUpgrade(request: Request, upgrade: (data: TerminalAttachData) => boolean): Response | undefined {
  const url = new URL(request.url);
  const hostId = url.searchParams.get("hostId"), sessionId = url.searchParams.get("sessionId");
  if (!hostId || hostId.length > 256 || !sessionId || !isValidSessionId(sessionId)) return Response.json({ error: "Invalid host or session ID" }, { status: 400 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
  if (!upgrade({ kind: "terminal-attach", hostId, sessionId, id: randomUUID(), started: false })) return Response.json({ error: "WebSocket upgrade failed" }, { status: 426 });
}

export const terminalAttachSocket = {
  open(ws: Socket): void {
    ws.data.timer = setTimeout(() => ws.close(1008, "hello required"), 10000);
    ws.data.timer.unref?.();
  },
  message(ws: Socket, data: string | Uint8Array): void {
    if (typeof data !== "string" || Buffer.byteLength(data) > 131072) { ws.close(1009, "invalid terminal frame"); return; }
    let message: unknown;
    try { message = JSON.parse(data); } catch { ws.close(1007, "invalid JSON"); return; }
    if (!Value.Check(TerminalAttachClientSchema, message)) { ws.close(1008, "invalid terminal frame"); return; }
    const state = ws.data;
    if (!state.started) {
      if (message.type !== "hello") { ws.close(1008, "hello required"); return; }
      state.started = true;
      clearTimeout(state.timer);
      state.unsubscribe = onPtyEvent(state.hostId, state.id, (event) => {
        if (!event) { ws.close(1013, "host connection lost"); return; }
        // Bun returns -1 when the frame was queued under backpressure; only 0 means it was dropped.
        if (ws.send(JSON.stringify(event)) === 0) { ws.close(1013, "terminal client too slow"); return; }
        if (event.type === "exit" || event.type === "error") ws.close(1000, "terminal ended");
      });
    } else if (message.type === "hello") { ws.close(1008, "duplicate hello"); return; }
    if (!sendPtyFrame(state.hostId, state.id, state.sessionId, data)) { ws.close(1013, "host connection unavailable"); return; }
    if (message.type === "detach") ws.close(1000, "detached");
  },
  close(ws: Socket): void {
    const state = ws.data;
    clearTimeout(state.timer);
    state.unsubscribe?.();
    if (state.started) sendPtyFrame(state.hostId, state.id, state.sessionId, JSON.stringify({ type: "detach" }));
  },
};
