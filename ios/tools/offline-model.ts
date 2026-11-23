// An OpenAI chat-completions endpoint for the real runner, not a Keylime server.
// It never examines or logs prompts and only listens on the host loopback interface.
const model = "offline";
const fragments = [
  "This ", "is ", "a ", "deterministic ", "offline ", "fixture ", "response. ",
  "It ", "streams ", "slowly ", "through ", "the ", "real ", "Keylime ",
  "daemon ", "and ", "runner. ", "You ", "can ", "stop ", "this ", "response ",
  "while ", "it ", "is ", "in ", "progress. ", "No ", "external ", "model ",
  "service ", "or ", "credentials ", "are ", "used. ", "The ", "same ", "prompt ",
  "always ", "receives ", "the ", "same ", "fixture ", "text.",
];
const text = fragments.join("");
const usage = {
  prompt_tokens: 1,
  completion_tokens: fragments.length,
  total_tokens: fragments.length + 1,
};
const command =
  "printf 'Fixture tool started\\n'; sleep 6; printf 'Fixture tool failed\\n'; exit 1";

function shouldCallBash(body: object): boolean {
  if (!("messages" in body) || !Array.isArray(body.messages)) return false;
  const messages: unknown[] = body.messages;
  const lastUser = messages.findLastIndex(
    (message) =>
      !!message &&
      typeof message === "object" &&
      "role" in message &&
      message.role === "user",
  );
  if (lastUser < 0) return false;
  return !messages
    .slice(lastUser + 1)
    .some(
      (message) =>
        !!message &&
        typeof message === "object" &&
        "role" in message &&
        (message.role === "assistant" || message.role === "tool"),
    );
}

function hasBashTool(body: object): boolean {
  return (
    "tools" in body &&
    Array.isArray(body.tools) &&
    body.tools.some(
      (tool: unknown) =>
        !!tool &&
        typeof tool === "object" &&
        "type" in tool &&
        tool.type === "function" &&
        "function" in tool &&
        !!tool.function &&
        typeof tool.function === "object" &&
        "name" in tool.function &&
        tool.function.name === "bash",
    )
  );
}

export function startOfflineModel(delayMs: number, failedBash = false) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
        return new Response("Not found", { status: 404 });

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: { message: "Invalid JSON" } }, { status: 400 });
      }
      if (
        !body ||
        typeof body !== "object" ||
        !("model" in body) ||
        body.model !== model
      )
        return Response.json(
          { error: { message: "Unknown fixture model" } },
          { status: 400 },
        );

      const callBash = failedBash && shouldCallBash(body);
      if (callBash && !hasBashTool(body))
        return Response.json(
          { error: { message: "Fixture requires the bash tool" } },
          { status: 400 },
        );
      const toolCall = callBash
        ? {
            id: `call_fixture_${crypto.randomUUID().replaceAll("-", "")}`,
            type: "function" as const,
            function: { name: "bash", arguments: JSON.stringify({ command }) },
          }
        : undefined;

      const base = { id: "chatcmpl-keylime-fixture", object: "chat.completion", created: 0, model };
      if (!("stream" in body) || body.stream !== true) {
        return Response.json({
          ...base,
          choices: [
            {
              index: 0,
              message: toolCall
                ? { role: "assistant", content: null, tool_calls: [toolCall] }
                : { role: "assistant", content: text },
              finish_reason: toolCall ? "tool_calls" : "stop",
            },
          ],
          usage,
        });
      }

      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      let index = 0;
      let abort: (() => void) | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const cleanup = () => {
            clearTimeout(timer);
            if (abort) request.signal.removeEventListener("abort", abort);
          };
          abort = () => {
            if (finished) return;
            finished = true;
            cleanup();
            console.log("[offline-model] Stream cancelled");
            try { controller.close(); } catch { /* Client already disconnected. */ }
          };
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) return abort();
          const send = (
            delta: Record<string, unknown>,
            finishReason: string | null,
          ) => {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  ...base,
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta, finish_reason: finishReason }],
                  ...(finishReason ? { usage } : {}),
                })}\n\n`,
              ),
            );
          };
          send({ role: "assistant" }, null);
          if (toolCall) {
            send({ tool_calls: [{ index: 0, ...toolCall }] }, null);
            send({}, "tool_calls");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            finished = true;
            cleanup();
            controller.close();
            return;
          }
          const next = () => {
            if (finished) return;
            if (index < fragments.length) {
              send({ content: fragments[index++] }, null);
              timer = setTimeout(next, delayMs);
              return;
            }
            send({}, "stop");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            finished = true;
            cleanup();
            controller.close();
            console.log("[offline-model] Stream completed");
          };
          timer = setTimeout(next, delayMs);
        },
        cancel() {
          abort?.();
        },
      });
      console.log("[offline-model] Stream started");
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  return server;
}
