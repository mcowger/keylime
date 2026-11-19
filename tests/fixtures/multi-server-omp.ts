// The external omp boundary only; both web servers and the host daemon are real.
import * as fs from "node:fs";
import { createConnection } from "node:net";
import * as readline from "node:readline";
if (process.argv.includes("--version")) {
  console.log("18.15.0-multi-server-test");
  process.exit(0);
}
// Stdout belongs to the PTY; runner frames use the daemon's Unix socket.
const socketPath = process.env.KEYLIME_HOST_SOCKET;
if (!socketPath) throw new Error("Missing KEYLIME_HOST_SOCKET");
const rpcSocket = createConnection(socketPath);
rpcSocket.once("end", () => process.exit(0));
const sessionId = process.env.OMP_MULTI_SESSION_ID;
const sessionFile = process.env.OMP_MULTI_SESSION_FILE!;
const record = (entry: Record<string, unknown>) =>
  fs.appendFileSync(
    process.env.OMP_MULTI_LOG!,
    `${JSON.stringify({ pid: process.pid, ...entry })}\n`,
  );
const send = (frame: Record<string, unknown>) =>
  rpcSocket.write(`${JSON.stringify(frame)}\n`);
const out = (event: Record<string, unknown>) => send({ t: "event", event });
const resumed = process.argv.includes("--resume");
record({ type: "start", resumed });
let streaming = false;
let messages: Array<{
  role: string;
  content: Array<{ type: string; text: string }>;
  timestamp: number;
}> = [];
let timer: ReturnType<typeof setInterval> | undefined;
let promptNumber = 0;
const saved = fs
  .readFileSync(sessionFile, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
let parentId =
  saved.findLast((entry) => entry.type !== "session" && entry.id)?.id ?? null;
let entryNumber = 0;
const persist = (message: unknown, clientMessageId?: string) => {
  const id = `native-${process.pid}-${++entryNumber}`;
  fs.appendFileSync(
    sessionFile,
    `${JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message, ...(clientMessageId ? { clientMessageId } : {}) })}\n`,
  );
  parentId = id;
};
const end = () => {
  streaming = false;
  clearTimeout(timer);
  out({ type: "agent_end", isTerminal: true, messages: [] });
  out({ type: "session_settled" });
};
send({
  t: "hello",
  proto: 1,
  pid: process.pid,
  sessionId,
  sessionFile,
  cwd: process.cwd(),
});
readline.createInterface({ input: rpcSocket }).on("line", (line) => {
  const command = JSON.parse(line);
  record({ type: "command", command });
  if (command.t === "ui_response") {
    // keylime names the dialog by its wire id as a string.
    record({ type: "answer", id: String(command.id) });
    return end();
  }
  if (command.t !== "cmd") return;
  const { args } = command;
  const reply = (data = {}) =>
    send({ t: "res", id: command.id, ok: true, data });
  switch (command.op) {
    case "get_state":
      return reply({
        sessionId,
        sessionFile,
        cwd: process.cwd(),
        supportsClientMessageIds: true,
        isStreaming: streaming,
        isSettled: !streaming,
        isCompacting: false,
        queuedMessages: [],
        messages,
      });
    case "get_subagents":
      return reply({ subagents: [] });
    case "get_btw_history":
      return reply({ records: [] });
    case "abort":
    case "abort_and_restore_queue":
      reply({ messages: [] });
      return end();
    case "prompt": {
      reply({ agentInvoked: true });
      streaming = true;
      const n = ++promptNumber;
      const user = {
        role: "user",
        content: [{ type: "text", text: args.message }],
        timestamp: Date.now(),
      };
      messages.push(user);
      out({ type: "agent_start" });
      const correlation = args.clientMessageId
        ? { clientMessageId: args.clientMessageId }
        : {};
      out({
        type: "message_start",
        messageId: `u${n}`,
        message: user,
        ...correlation,
      });
      persist(user, args.clientMessageId);
      out({
        type: "message_end",
        messageId: `u${n}`,
        message: user,
        ...correlation,
      });
      if (args.message === "ask") {
        send({
          t: "ui_request",
          id: n,
          method: "askDialog",
          args: [
            [
              {
                id: "pick",
                question: "Pick one",
                options: [{ label: "A" }, { label: "B" }],
              },
            ],
          ],
        });
        return;
      }
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: Date.now(),
      };
      out({ type: "message_start", messageId: `a${n}`, message: assistant });
      assistant.content[0].text = "one";
      out({
        type: "message_update",
        messageId: `a${n}`,
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "one",
        },
      });
      out({
        type: "tool_execution_start",
        toolCallId: `t${n}`,
        toolName: "read",
        args: { path: "shared.txt" },
      });
      out({
        type: "tool_execution_end",
        toolCallId: `t${n}`,
        toolName: "read",
        result: {
          content: [{ type: "text", text: "one shared result" }],
          ...(args.message === "from B"
            ? { details: { largeResult: "x".repeat(1_100_000) } }
            : {}),
        },
        isError: false,
      });
      timer = setInterval(
        () => {
          if (
            args.message === "slow" &&
            !fs.existsSync(process.env.OMP_MULTI_RELEASE_FILE!)
          )
            return;
          assistant.content[0].text = "one two";
          out({
            type: "message_update",
            messageId: `a${n}`,
            message: { role: "assistant" },
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: " two",
            },
          });
          messages.push(assistant);
          persist(assistant);
          out({ type: "message_end", messageId: `a${n}`, message: assistant });
          end();
        },
        args.message === "slow" ? 50 : 300,
      );
      return;
    }
    default:
      return reply();
  }
});
