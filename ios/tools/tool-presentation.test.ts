import { describe, expect, test } from "bun:test";
import {
  getNativeToolDuration,
  getNativeToolPresentation,
  getNativeToolResultMeta,
  type NativeToolCall,
  type NativeToolCategory,
  type NativeToolResult,
} from "../tool-presentation";

function call(
  toolName: string,
  input: Record<string, unknown> = {},
  intent?: string,
): NativeToolCall {
  return {
    type: "toolCall",
    toolCallId: "call",
    toolName,
    input,
    ...(intent === undefined ? {} : { intent }),
  };
}
function result(
  details?: unknown,
  extra: Partial<NativeToolResult> = {},
): NativeToolResult {
  return {
    role: "toolResult",
    toolCallId: "call",
    content: [],
    details,
    ...extra,
  };
}

describe("native tool presentation", () => {
  test.each<[string, NativeToolCategory, boolean]>([
    ["read", "read", true],
    ["functions.read", "read", true],
    ["custom_read", "read", false],
    ["ast_grep", "search", true],
    ["web_search", "search", true],
    ["browser", "web", true],
    ["tools.edit", "edit", true],
    ["bash", "terminal", true],
    ["todo", "todo", true],
    ["agent", "task", true],
    ["eval", "code", true],
    ["hub", "hub", true],
    ["mcp__example", "other", false],
  ])("classifies %s", (name, category, iconOnly) => {
    const presentation = getNativeToolPresentation(call(name));
    expect(presentation.category).toBe(category);
    expect(presentation.iconOnly).toBe(iconOnly);
  });

  test("chooses display names, intent and compact common parameters", () => {
    const presentation = getNativeToolPresentation(
      call(
        "MCP__service",
        {
          i: "  Inspect logs  ",
          query: "error",
          secrets: "not in row",
        },
        "  Find failures  ",
      ),
    );
    expect(presentation.displayName).toBe("service");
    expect(presentation.intent).toBe("Find failures");
    expect(presentation.preview).toBe("error");
    expect(
      getNativeToolPresentation(
        call("grep", { i: " search ", path: "src", pattern: "match" }, " "),
      ).preview,
    ).toBe("src");
    expect(
      getNativeToolPresentation(call("grep", { i: " search " }, " ")).intent,
    ).toBe("search");
    expect(
      getNativeToolPresentation(
        call("bash", { command: "x".repeat(150), content: "secret" }),
      ).preview,
    ).toHaveLength(120);
  });

  test("recognizes only exact write device targets and agent messages", () => {
    expect(
      getNativeToolPresentation(call("write", { path: "xd://read?source=x" })),
    ).toMatchObject({ category: "read", displayName: "read", iconOnly: true });
    expect(
      getNativeToolPresentation(call("write", { path: "xd://mcp__foo" })),
    ).toMatchObject({ category: "other", displayName: "foo", iconOnly: false });
    expect(
      getNativeToolPresentation(call("WRITE", { path: "agent://worker" })),
    ).toMatchObject({
      category: "agent-message",
      displayName: "agent",
      iconOnly: true,
    });
    expect(
      getNativeToolPresentation(call("write", { path: "xd://read/extra" })),
    ).toMatchObject({ category: "edit", displayName: "write" });
    expect(
      getNativeToolPresentation(call("edit", { path: "agent://worker" }))
        .category,
    ).toBe("edit");
  });

  test("renders todo, ask and eval previews", () => {
    expect(
      getNativeToolPresentation(
        call("todo", {
          op: "init",
          list: [{ items: [1, 2] }, { items: [3] }, null],
        }),
      ).preview,
    ).toBe("Initialized plan (3 tasks)");
    expect(
      getNativeToolPresentation(
        call("todo", { op: "append", items: ["one", 7, "two"] }),
      ).preview,
    ).toBe("Added 2 tasks");
    expect(
      getNativeToolPresentation(call("todo", { op: "done", task: "ship" }))
        .preview,
    ).toBe('Completed "ship"');
    expect(
      getNativeToolPresentation(
        call("ask", {
          questions: [
            { header: " Choice ", question: " Which? " },
            { question: "Why?" },
          ],
        }),
      ).preview,
    ).toBe("2 questions: “Choice: Which?” · “Why?”");
    expect(
      getNativeToolPresentation(call("ask", { questions: [null] })).preview,
    ).toBe("1 question");
    expect(
      getNativeToolPresentation(
        call("eval", { language: " PY ", code: "private code" }),
      ),
    ).toMatchObject({ language: "py", preview: "" });
  });

  test("summarizes hub sends, including consistent receipts only", () => {
    const block = call("hub", {
      op: "send",
      to: ["Alice", "Bob"],
      message: "\n  Hello  \nprivate remainder",
    });
    expect(
      getNativeToolPresentation(
        block,
        result({
          receipts: [{ outcome: "injected" }, { outcome: "injected" }],
        }),
      ),
    ).toMatchObject({
      hubTitle: "IRC → Alice, Bob injected",
      preview: "Hello",
    });
    expect(
      getNativeToolPresentation(
        block,
        result({ receipts: [{ outcome: "injected" }, { outcome: "queued" }] }),
      ).hubTitle,
    ).toBe("IRC → Alice, Bob");
    expect(
      getNativeToolPresentation(block, result({ receipts: [null] })).hubTitle,
    ).toBe("IRC → Alice, Bob");
    expect(
      getNativeToolPresentation(
        call("hub", { op: "send", to: "A", message: "" }),
      ).preview,
    ).toBe("A");
    expect(
      getNativeToolPresentation(call("hub", { op: "send", to: [] })).preview,
    ).toBe("send");
  });

  test("summarizes hub jobs and handles invalid results", () => {
    const block = call("hub", { op: "jobs" });
    expect(
      getNativeToolPresentation(
        block,
        result({
          op: "jobs",
          jobs: [
            { id: "a", label: "Review", status: "running" },
            { id: "b", status: "done" },
            { label: "missing id" },
          ],
        }),
      ),
    ).toMatchObject({ hubTitle: "waiting on 2 jobs", preview: "Review · b" });
    expect(
      getNativeToolPresentation(
        block,
        result({ op: "jobs", jobs: [{ id: "a", status: "done" }] }),
      ).hubTitle,
    ).toBe("1 job");
    expect(
      getNativeToolPresentation(
        block,
        result({ op: "jobs", jobs: [] }, { isError: true }),
      ),
    ).toMatchObject({ hubTitle: null, preview: "jobs" });
    expect(
      getNativeToolPresentation(block, result(null, { isError: true }))
        .hubTitle,
    ).toBeNull();
  });

  test("bounds hub recipients, snippets and job rosters", () => {
    const recipients = Array.from(
      { length: 12 },
      (_, index) => `agent${index}`,
    );
    const send = getNativeToolPresentation(
      call("hub", {
        op: "send",
        to: recipients,
        message: "x".repeat(130),
      }),
    );
    expect(send.hubTitle).toBe(`IRC → ${recipients.slice(0, 10).join(", ")}`);
    expect(send.preview).toBe(`${"x".repeat(120)}…`);

    const jobs = Array.from({ length: 60 }, (_, index) => ({
      id: `job${index}`,
    }));
    const roster = getNativeToolPresentation(
      call("hub", { op: "jobs" }),
      result({ op: "jobs", jobs }),
    );
    expect(roster.hubTitle).toBe("waiting on 50 jobs");
    expect(roster.preview?.split(" · ")).toHaveLength(50);
  });

  test("formats metadata and positive completed durations", () => {
    const value = result(
      {
        usage: {
          input_tokens: 1500,
          output: 25,
          cacheRead: 1_200_000,
          cache_write: 9,
          cacheWrite: -1,
        },
      },
      { timestamp: 3600, isError: true },
    );
    expect(getNativeToolResultMeta(value)).toBe(
      "in 2k · out 25 · cache R 1.2M · cache W 9",
    );
    expect(getNativeToolPresentation(call("read"), value).resultMeta).toBe(
      "in 2k · out 25 · cache R 1.2M · cache W 9",
    );
    expect(
      getNativeToolResultMeta(result({ input: 0, output: NaN })),
    ).toBeNull();
    expect(getNativeToolDuration(1000, value)).toBe(3);
    expect(getNativeToolDuration(3400, value)).toBeUndefined();
    expect(getNativeToolDuration(undefined, value)).toBeUndefined();
  });

  test("handles unknown values and unserializable preview input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      getNativeToolPresentation(call("custom", { payload: cyclic })).preview,
    ).toBe("");
    expect(
      getNativeToolPresentation(call("custom", { payload: null })).preview,
    ).toBe("");
    expect(getNativeToolPresentation(call("custom", {}))).toMatchObject({
      category: "other",
      intent: "",
      preview: "",
      language: "",
      hubTitle: null,
      resultMeta: null,
    });
  });
});
