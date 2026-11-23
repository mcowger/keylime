import { expect, test } from "bun:test";
import { startOfflineModel } from "./offline-model";

type Completion = { choices: { message: { content: string } }[] };
type Chunk = {
  choices: { delta: { content?: string }; finish_reason: string | null }[];
};
const request = {
  model: "offline",
  messages: [{ role: "user", content: "fixture prompt" }],
};
const tools = [
  {
    type: "function",
    function: { name: "bash", parameters: { type: "object" } },
  },
];
type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};
type ToolCompletion = {
  choices: {
    message: { role: string; content: null; tool_calls: ToolCall[] };
    finish_reason: string;
  }[];
};
type ToolChunk = {
  choices: {
    delta: { tool_calls?: (ToolCall & { index: number })[] };
    finish_reason: string | null;
  }[];
};

test("offline model responds with deterministic OpenAI completions", async () => {
  const server = startOfflineModel(25);
  try {
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    const send = (body: object) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = (await (await send(request)).json()) as Completion;
    const second = (await (await send(request)).json()) as Completion;
    expect(
      (await (await send({ ...request, tools })).json()) as Completion,
    ).toEqual(first);
    expect(first).toEqual(second);
    expect(first.choices[0].message.content).toContain(
      "deterministic offline fixture response",
    );
    expect((await send({ ...request, model: "other" })).status).toBe(400);

    const response = await send({ ...request, stream: true });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = (await response.text()).split("\n\n").filter(Boolean);
    expect(events.at(-1)).toBe("data: [DONE]");
    const chunks = events
      .slice(0, -1)
      .map((event) => JSON.parse(event.slice(6)) as Chunk);
    expect(
      chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join(""),
    ).toBe(first.choices[0].message.content);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("stop");
  } finally {
    server.stop(true);
  }
});

test("offline model streaming request can be aborted", async () => {
  const server = startOfflineModel(100);
  const abort = new AbortController();
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, stream: true }),
        signal: abort.signal,
      },
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    abort.abort();
    await expect(reader.read()).rejects.toThrow();
  } finally {
    abort.abort();
    server.stop(true);
  }
});

test("failed Bash fixture emits one tool call per turn and answers after its result", async () => {
  const server = startOfflineModel(25, true);
  try {
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    const send = (body: object) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await send(request)).status).toBe(400);
    expect(
      (
        await send({
          ...request,
          tools: [{ type: "function", function: { name: "other" } }],
        })
      ).status,
    ).toBe(400);
    const response = await send({ ...request, tools, stream: true });
    const events = (await response.text()).split("\n\n").filter(Boolean);
    expect(events.at(-1)).toBe("data: [DONE]");
    const chunks = events
      .slice(0, -1)
      .map((event) => JSON.parse(event.slice(6)) as ToolChunk);
    const calls = chunks.flatMap(
      (chunk) => chunk.choices[0].delta.tool_calls ?? [],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBe(0);
    expect(calls[0].type).toBe("function");
    expect(calls[0].function.name).toBe("bash");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      command:
        "printf 'Fixture tool started\\n'; sleep 6; printf 'Fixture tool failed\\n'; exit 1",
    });
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("tool_calls");

    const messages = [
      ...request.messages,
      { role: "assistant", content: null, tool_calls: [calls[0]] },
      { role: "tool", tool_call_id: calls[0].id, content: "exit code 1" },
    ];
    const answer = (await (
      await send({ model: "offline", messages, tools })
    ).json()) as Completion;
    expect(answer.choices[0].message.content).toContain(
      "deterministic offline fixture response",
    );
    const streamedAnswer = await send({
      model: "offline",
      messages,
      tools,
      stream: true,
    });
    const answerEvents = (await streamedAnswer.text())
      .split("\n\n")
      .filter(Boolean);
    const answerChunks = answerEvents
      .slice(0, -1)
      .map((event) => JSON.parse(event.slice(6)) as Chunk);
    expect(answerEvents.at(-1)).toBe("data: [DONE]");
    expect(
      answerChunks
        .map((chunk) => chunk.choices[0].delta.content ?? "")
        .join(""),
    ).toBe(answer.choices[0].message.content);
    expect(answerChunks.at(-1)?.choices[0].finish_reason).toBe("stop");
    const next = (await (
      await send({
        model: "offline",
        messages: [...messages, { role: "user", content: "another turn" }],
        tools,
      })
    ).json()) as ToolCompletion;
    expect(next.choices[0].finish_reason).toBe("tool_calls");
    expect(next.choices[0].message.tool_calls[0].function.name).toBe("bash");
    expect(next.choices[0].message.tool_calls[0].id).not.toBe(calls[0].id);
  } finally {
    server.stop(true);
  }
});
