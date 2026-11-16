import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { hostSocketPath } from "../lib/hosts/omp-socket";

export async function runAttach(sessionId: string | undefined): Promise<number> {
  if (!sessionId) { console.error("Usage: keylime attach <session-id>"); return 1; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error("keylime attach requires a terminal"); return 1; }
  const socket = createConnection(hostSocketPath() + ".attach");
  const lines = createInterface({ input: socket });
  const { promise, resolve } = Promise.withResolvers<number>();
  let finished = false;
  let active = false;
  const wasRaw = process.stdin.isRaw;
  const send = (message: object) => { if (socket.writable) socket.write(JSON.stringify(message) + "\n"); };
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  const decoder = new StringDecoder("utf8");
  const resize = () => send({ type: "resize", ...size() });
  const input = (data: Buffer) => {
    const index = data.indexOf(0x1d); // Ctrl-] detaches without ending the session.
    const forwarded = index < 0 ? data : data.subarray(0, index);
    if (forwarded.length) { const text = decoder.write(forwarded); if (text) send({ type: "input", data: text }); }
    if (index >= 0) { send({ type: "detach" }); finish(0); }
  };
  const onSignal = () => { send({ type: "detach" }); finish(0); };
  const onEnd = () => { send({ type: "detach" }); finish(0); };
  function finish(code: number, error?: string): void {
    if (finished) return;
    finished = true;
    process.stdin.removeListener("data", input);
    process.stdin.removeListener("end", onEnd);
    process.stdout.removeListener("resize", resize);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    if (active) {
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l");
    }
    lines.close(); socket.destroy();
    if (error) console.error(error);
    resolve(code);
  }
  socket.once("connect", () => send({ type: "hello", sessionId, ...size() }));
  socket.on("error", (error) => finish(1, `Could not attach: ${error.message}`));
  socket.on("close", () => finish(active ? 0 : 1, active ? undefined : "Terminal connection closed"));
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === "snapshot" && typeof message.data === "string") {
        if (!active) {
          active = true;
          process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
          process.stdin.setRawMode(true);
          process.stdin.on("data", input);
          process.stdin.on("end", onEnd);
          process.stdin.resume();
          process.stdout.on("resize", resize);
          process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); process.on("SIGHUP", onSignal);
        }
        process.stdout.write(message.data);
      } else if (message.type === "output" && typeof message.data === "string") process.stdout.write(message.data);
      else if (message.type === "exit") finish(typeof message.code === "number" ? message.code : 0);
      else if (message.type === "error") finish(1, `Could not attach: ${message.message}`);
    } catch { finish(1, "Invalid response from host"); }
  });
  return promise;
}
