import { expect, test } from "bun:test";
import { startOfflineModel } from "./offline-model";

type Completion = { choices: { message: { content: string } }[] };
type Chunk = { choices: { delta: { content?: string }; finish_reason: string | null }[] };
const request = { model: "offline", messages: [{ role: "user", content: "fixture prompt" }] };

test("offline model responds with deterministic OpenAI completions", async () => {
  const server = startOfflineModel(25);
  try {
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    const send = (body: object) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const first = (await (await send(request)).json()) as Completion;
    const second = (await (await send(request)).json()) as Completion;
    expect(first).toEqual(second);
    expect(first.choices[0].message.content).toContain("deterministic offline fixture response");
    expect((await send({ ...request, model: "other" })).status).toBe(400);

    const response = await send({ ...request, stream: true });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = (await response.text()).split("\n\n").filter(Boolean);
    expect(events.at(-1)).toBe("data: [DONE]");
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event.slice(6)) as Chunk);
    expect(chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join(""))
      .toBe(first.choices[0].message.content);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("stop");
  } finally {
    server.stop(true);
  }
});

test("offline model streaming request can be aborted", async () => {
  const server = startOfflineModel(100);
  const abort = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    abort.abort();
    await expect(reader.read()).rejects.toThrow();
  } finally {
    abort.abort();
    server.stop(true);
  }
});
