import assert from "node:assert/strict";
import "../tests/setup-dom.ts";
import test, { afterEach } from "node:test";
import React from "react";
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react/pure.js");
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeToolCalls } from "../lib/normalize";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantContentBlock,
  BashExecutionMessage,
  SessionEntry,
  ToolResultMessage,
} from "../lib/types";
import type { HeldMessage } from "../hooks/useAgentSession-queue";
type MessageProps = React.ComponentProps<typeof MessageView>;

const {
  HeldMessageView,
  MessageView,
  SafeMarkdownBody,
  TaskResultPanel,
  isInterruptedMessage,
  areMessageViewPropsEqual,
  haveSameRelevantToolResults,
} = await import("./MessageView");
const { CodeBlock } = await import("./MermaidBlock");
const { buildSessionContext } = await import("../lib/session-reader");
const { collectToolResults, planTranscriptRows } =
  await import("../lib/chat-transcript-plan");
afterEach(cleanup);

test("held messages name every delivery leg and only offer Delete before dispatch", () => {
  const base = {
    id: "held",
    mode: "prompt" as const,
    message: "Keep this safe.",
    createdAt: Date.now(),
    local: false,
  };
  for (const [state, label, actions, spinner] of [
    ["sending", "Sending…", false, true],
    ["waiting_host", "Waiting for Build box", true, false],
    ["delivering", "Delivering…", false, true],
    ["failed", "Not sent", true, false],
  ] as const) {
    const html = renderToStaticMarkup(
      React.createElement(HeldMessageView, {
        held: { ...base, state },
        hostLabel: "Build box",
        onDelete() {},
      }),
    );
    assert.ok(html.includes(label), state);
    assert.equal(html.includes("Delete this held message"), actions, state);
    assert.equal(html.includes("<select"), false, state);
    assert.equal(html.includes("activity-row-spinner"), spinner, state);
  }
});

test("Retry is offered only for failures and confirms uncertain delivery", async () => {
  const base = {
    id: "held",
    mode: "prompt" as const,
    message: "Again",
    createdAt: Date.now(),
    local: false,
  };
  for (const state of [
    "sending",
    "waiting_host",
    "held",
    "delivering",
  ] as const) {
    const html = renderToStaticMarkup(
      React.createElement(HeldMessageView, {
        held: { ...base, state },
        onRetry() {},
      }),
    );
    assert.equal(html.includes("Retry sending this message"), false, state);
  }
  const retried: string[] = [];
  const view = render(
    React.createElement(HeldMessageView, {
      held: { ...base, state: "failed", mayHaveBeenSent: true },
      onRetry: (id) => retried.push(id),
    }),
  );
  fireEvent.click(
    view.getByRole("button", { name: "Retry sending this message" }),
  );
  assert.deepEqual([...retried], []);
  const dialog = await waitFor(() => view.getByRole("dialog"));
  assert.match(dialog.textContent!, /run it twice/);
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  assert.deepEqual(retried, ["held"]);
  view.unmount();
  const direct = render(
    React.createElement(HeldMessageView, {
      held: { ...base, state: "failed" },
      onRetry: (id) => retried.push(id),
    }),
  );
  fireEvent.click(
    direct.getByRole("button", { name: "Retry sending this message" }),
  );
  assert.deepEqual(retried, ["held", "held"]);
});

test("Delete confirmation never claims omp has not seen a message that may have been sent, nor cancellation", async () => {
  const base = {
    id: "held",
    mode: "prompt" as const,
    message: "Keep this safe.",
    createdAt: Date.now(),
    local: false,
    state: "failed" as const,
  };
  const dialogText = async (held: HeldMessage) => {
    const view = render(
      React.createElement(HeldMessageView, { held, onDelete() {} }),
    );
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: "Delete this held message" }),
      );
    });
    const text = (await waitFor(() => view.getByRole("dialog"))).textContent!;
    view.unmount();
    return text;
  };
  const uncertain = await dialogText({ ...base, mayHaveBeenSent: true });
  assert.match(uncertain, /may already have reached omp/);
  assert.match(uncertain, /cannot cancel or undo/);
  assert.doesNotMatch(uncertain, /has not reached|will not be sent/);
  for (const state of ["held", "failed"] as const) {
    const ordinary = await dialogText({ ...base, state });
    assert.match(
      ordinary,
      /Remove this held message from the outbox list\?/,
      state,
    );
    assert.doesNotMatch(
      ordinary,
      /has not reached|never reached|will not send|will not be sent|cancel/,
      state,
    );
  }
});

test("sent messages without timestamps or branch metadata still offer copy", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      message: { role: "user", content: "Keep this message copyable." },
    }),
  );
  assert.match(html, /<button[^>]*aria-label="Copy message"/);
});

// Plain Copy needs the browser's layout-aware innerText (not implemented by
// jsdom). Verify code gutters, math, tables, images and spacing in Chromium;
// do not substitute textContent and claim equivalent coverage here.
test("message Markdown copy preserves source, excludes activity, and confirms success in Strict Mode", async (t) => {
  let clipboard = "";
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboard = text;
      },
    },
  });
  t.after(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else Reflect.deleteProperty(window, "matchMedia");
  });
  const source =
    "# Heading\n\n**Bold** and [link](https://example.com)\n\n```js\n  code();\n```";
  const messages: AgentMessage[] = [
    { role: "user", content: source },
    {
      role: "assistant",
      model: "test",
      provider: "test",
      content: [
        { type: "text", text: source },
        { type: "thinking", thinking: "Do not copy thinking" },
        {
          type: "toolCall",
          toolCallId: "copy-tool",
          toolName: "read",
          input: { path: "not copied" },
        },
        { type: "text", text: "## Conclusion\n\nDone." },
      ],
    },
  ];
  for (const message of messages) {
    const view = render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(MessageView, { message }),
      ),
    );
    const button = view.getByRole("button", { name: "Copy as Markdown" });
    await act(async () => {
      fireEvent.click(button);
    });
    assert.equal(
      clipboard,
      message.role === "user" ? source : `${source}\n\n## Conclusion\n\nDone.`,
    );
    // The click handler's copy chain (clipboard write -> setCopied) resolves on a
    // microtask that can land AFTER act's flush under load, leaving the "Copied"
    // label uncommitted when this line reads the DOM. waitFor lets React commit
    // instead of racing the scheduler (flaked under parallel suite load).
    await waitFor(() => assert.equal(button.textContent, "Copied"));
    view.unmount();
  }
});

test("plain Copy keeps full oversized message source instead of the reveal control", async (t) => {
  let clipboard = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboard = text;
      },
    },
  });
  t.after(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });
  const source = "# Keep the full raw source\n\n".repeat(5000);
  for (const message of [
    { role: "user", content: source },
    {
      role: "assistant",
      model: "test",
      provider: "test",
      content: [
        { type: "thinking", thinking: "Do not copy thinking" },
        { type: "text", text: source },
      ],
    },
  ] satisfies AgentMessage[]) {
    const view = render(React.createElement(MessageView, { message }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy message" }));
    });
    assert.equal(clipboard, source);
    view.unmount();
  }
});

test("expanded oversized user message can be collapsed again", (t) => {
  // Layout stub: capped bubbles overflow; an uncapped bubble fits its content.
  const observers: MockResizeObserver[] = [];
  const originalResizeObserver = globalThis.ResizeObserver;
  class MockResizeObserver implements ResizeObserver {
    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = MockResizeObserver;
  const proto = window.HTMLElement.prototype;
  const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const clientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get() {
      return 1000;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get: function (this: HTMLElement) {
      return this.style.maxHeight === "none" ? 1000 : 300;
    },
  });
  t.after(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    for (const [name, descriptor] of [
      ["scrollHeight", scrollHeight],
      ["clientHeight", clientHeight],
    ] as const) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else Reflect.deleteProperty(proto, name);
    }
  });

  const view = render(
    React.createElement(MessageView, {
      message: { role: "user", content: "long\n\n".repeat(200) },
    }),
  );
  const resize = () =>
    act(() => {
      for (const observer of observers) observer.callback([], observer);
    });
  fireEvent.click(view.getByRole("button", { name: "Show full input" }));
  resize();
  const toggle = view.getByRole("button", { name: "Collapse input" });
  toggle.focus();
  fireEvent.click(toggle);
  // Before re-measuring, the same toggle must stay mounted and focused.
  assert.equal(document.activeElement, toggle);
  resize();
  assert.equal(view.getByRole("button", { name: "Show full input" }), toggle);
  assert.equal(document.activeElement, toggle);
});

test("eval rows place language icons before the intent", () => {
  for (const [toolName, language, label] of [
    ["eval", "py", "Python"],
    ["eval", "js", "JavaScript"],
    ["tools.eval", "js", "JavaScript"],
  ]) {
    const view = render(
      React.createElement(MessageView, {
        isStreaming: true,
        message: {
          role: "assistant",
          model: "test",
          provider: "test",
          content: [{
            type: "toolCall",
            toolCallId: "eval-call",
            toolName,
            intent: "Inspecting settings",
            input: { language, code: "example()" },
          }],
        },
      }),
    );
    const row = view.container.querySelector("button.activity-row-trigger")!;
    const tool = row.querySelector(".activity-tool-icon")!;
    const icon = row.querySelector('[role="img"]')!;
    assert.equal(tool.getAttribute("title"), toolName);
    assert.equal(row.querySelector(".activity-row-tool"), null);
    assert.equal(tool.nextElementSibling?.className, "sr-only");
    assert.equal(icon.getAttribute("aria-label"), label);
    assert.equal(icon.nextElementSibling?.textContent, "Inspecting settings");
    view.unmount();
  }
});

test("tool rows distinguish agent messages and device calls from file access", () => {
  for (const [toolName, path, label, icon] of [
    ["write", "agent://TempRoots", undefined, "lucide-message-circle"],
    ["write", "xd://ast_grep", undefined, "lucide-search"],
    ["write", "xd://mcp__github_issue_read", "github_issue_read", "lucide-file-text"],
    ["read", "xd://ast_grep", undefined, "lucide-file-text"],
    ["write", "xd://read/sources", undefined, "lucide-file-pen"],
    ["write", "notes.txt", undefined, "lucide-file-pen"],
  ] as const) {
    const view = render(React.createElement(MessageView, {
      isStreaming: true,
      message: { role: "assistant", model: "test", provider: "test", content: [
        { type: "toolCall", toolCallId: "call", toolName, input: { path } },
      ] },
    }));
    const row = view.container.querySelector("button.activity-row-trigger")!;
    assert.equal(row.querySelector(".activity-row-tool")?.textContent, label, path);
    assert.ok(row.querySelector(`.activity-tool-icon svg.${icon}`), path);
    view.unmount();
  }
});

test("expanded tool inputs follow streaming arguments without toggling output", () => {
  const code = "print('first')\nprint('complete')";
  const editInput = {
    path: "/tmp/example.ts",
    patch: "-old\n+new",
    options: { dryRun: false },
  };
  const toolResults = new Map<string, ToolResultMessage>([
    [
      "edit-call",
      {
        role: "toolResult",
        toolCallId: "edit-call",
        content: [{ type: "text", text: "Edit complete" }],
      },
    ],
  ]);
  const props = (input: string): MessageProps => ({
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    toolResults,
    message: {
      role: "assistant",
      model: "test",
      provider: "test",
      content: [
        {
          type: "toolCall",
          toolCallId: "eval-call",
          toolName: "eval",
          input: { language: "py", code: input },
        },
        {
          type: "toolCall",
          toolCallId: "edit-call",
          toolName: "edit",
          input: editInput,
        },
      ],
    },
  });
  const { container, rerender } = render(
    React.createElement(MessageView, props("print('first')")),
  );
  // With collapse off, each tool call is its own already-open row.
  const rowTriggers = () => [
    ...container.querySelectorAll("button.activity-row-trigger"),
  ];
  assert.equal(rowTriggers().length, 2);
  const toggles = (label: string) =>
    [...container.querySelectorAll("button.tool-call-input-toggle")].filter(
      (button) => (button.textContent ?? "").includes(label),
    );
  const inputPanels = () => [
    ...container.querySelectorAll<HTMLDivElement>("div.tool-call-input"),
  ];
  const pres = (panel: HTMLDivElement) => [...panel.querySelectorAll("pre")];
  assert.equal(toggles("Show full input").length, 2);
  assert.ok(inputPanels().every((panel) => panel.hidden));
  for (const toggle of toggles("Show full input")) fireEvent.click(toggle);
  assert.equal(pres(inputPanels()[0])[1].textContent, "print('first')");
  assert.equal(pres(inputPanels()[1])[1].textContent, editInput.patch);
  assert.deepEqual(
    JSON.parse(pres(inputPanels()[1])[2].textContent ?? ""),
    editInput.options,
  );
  rerender(React.createElement(MessageView, props(code)));
  assert.equal(pres(inputPanels()[0])[1].textContent, code);
  const output = () =>
    [...container.querySelectorAll('pre[data-tool-output="true"]')].map(
      (node) => node.textContent,
    );
  assert.deepEqual(output(), ["Edit complete"]);
  for (const toggle of toggles("Collapse input")) fireEvent.click(toggle);
  assert.ok(inputPanels().every((panel) => panel.hidden));
  assert.deepEqual(output(), ["Edit complete"]);
});

test("large message content avoids the markdown pipeline until requested", () => {
  const largeMessage = "x".repeat(100_001);
  const html = renderToStaticMarkup(
    React.createElement(SafeMarkdownBody, null, largeMessage),
  );

  assert.match(html, /Large message \(100 KB\)/);
  assert.doesNotMatch(html, /markdown-body/);
});

test("streaming code blocks avoid syntax-highlighter line markup", () => {
  const html = renderToStaticMarkup(
    React.createElement(CodeBlock, {
      code: "const value = 1;",
      lang: "ts",
      isStreaming: true,
    }),
  );

  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, /linenumber/);
});

test("MCP mount notices stay out of the transcript", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      message: {
        role: "custom",
        customType: "xdev-mount-notice",
        content: "The xd:// device inventory changed.",
        display: false,
      },
    }),
  );

  assert.equal(html, "");
});

test("tool rows show native and input intents alongside their targets", () => {
  for (const [block, intent] of [
    [
      { type: "toolCall", id: "native", name: "read", arguments: { path: "native.ts" }, intent: "Inspecting native file" },
      "Inspecting native file",
    ],
    [
      { type: "toolCall", id: "input", name: "write", arguments: { path: "output.ts", i: "Writing output" } },
      "Writing output",
    ],
  ] as const) {
    const message = normalizeToolCalls({
      role: "assistant",
      model: "test",
      provider: "test",
      content: [block],
    } as unknown as AgentMessage);
    const view = render(
      React.createElement(MessageView, {
        message, toolCallsDefaultCollapsed: true, onOpenFile() {},
      }),
    );
    const row = view.container.querySelector(".activity-row-trigger")!;
    assert.ok(row.textContent?.includes(intent));
    assert.ok(row.textContent?.includes(block.arguments.path));
    assert.ok(row.querySelector(".activity-file-link"));
    view.unmount();
  }
});

test("streaming tool calls start collapsed when the interface preference is enabled", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      isStreaming: true,
      toolCallsDefaultCollapsed: true,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "foo.ts" },
          },
        ],
      },
    }),
  );

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<pre/);
});

test("expanded tool calls show the compact command header", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      isStreaming: true,
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "foo.ts" },
          },
        ],
      },
    }),
  );

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /tool-call-details/);
  assert.match(html, /\$<\/span><code>read foo\.ts<\/code>/);
});

test("read paths with an internal URL scheme are not file links", () => {
  const render = (path: string) =>
    renderToStaticMarkup(
      React.createElement(MessageView, {
        onOpenFile() {},
        message: {
          role: "assistant",
          model: "test",
          provider: "test",
          content: [
            {
              type: "toolCall",
              toolCallId: "call-1",
              toolName: "read",
              input: { path },
            },
          ],
        },
      }),
    );

  for (const path of [
    "history://ScoutAgent",
    "proc://Job1",
    " local://notes.md",
    "ftp://example.com/a.ts",
    "javascript://x%0Aalert(1)",
    "file:///etc/passwd",
  ]) {
    assert.doesNotMatch(render(path), /activity-file-link|role="link"/, path);
  }
  assert.match(render("src/foo.ts:10"), /activity-file-link/);
});

test("tool-row file links keep colon filenames intact", () => {
  const cases = [["src/my:file.txt", "src/my:file.txt"]];
  for (const [path, expected] of cases) {
    const openedFiles: string[] = [];
    const { container } = render(
      React.createElement(MessageView, {
        onOpenFile(file) {
          openedFiles.push(file);
        },
        message: {
          role: "assistant",
          model: "test",
          provider: "test",
          content: [
            {
              type: "toolCall",
              toolCallId: "call-1",
              toolName: "read",
              input: { path },
            },
          ],
        },
      }),
    );
    // File links render as a clickable span (role="button"), unlike web URLs.
    fireEvent.click(container.querySelector(".activity-file-link")!);
    assert.deepEqual(openedFiles, [expected], path);
    cleanup();
  }
});

test("read paths with a web URL open the fetched page in a new tab without toggling the row", () => {
  const opened: string[] = [];
  const originalOpen = window.open;
  window.open = (...args) => {
    opened.push(args.join(" "));
    return null;
  };
  const openedFiles: string[] = [];
  try {
    const cases = [
      [
        " https://example.com/docs",
        "https://example.com/docs _blank noopener,noreferrer",
      ],
      [
        "HTTPS://Example.com/a:raw",
        "https://example.com/a _blank noopener,noreferrer",
      ],
      [
        "https://example.com:8080/a.md:10-20",
        "https://example.com:8080/a.md _blank noopener,noreferrer",
      ],
    ];
    for (const [path, expected] of cases) {
      opened.length = 0;
      const { container, getByRole } = render(
        React.createElement(MessageView, {
          onOpenFile(file) {
            openedFiles.push(file);
          },
          message: {
            role: "assistant",
            model: "test",
            provider: "test",
            content: [
              {
                type: "toolCall",
                toolCallId: "call-1",
                toolName: "read",
                input: { path },
              },
            ],
          },
        }),
      );
      const trigger = container.querySelector("[aria-expanded]")!;
      const expanded = trigger.getAttribute("aria-expanded");
      fireEvent.click(getByRole("link"));
      fireEvent.keyDown(getByRole("link"), { key: "Enter" });
      assert.deepEqual(opened, [expected, expected], path);
      assert.equal(trigger.getAttribute("aria-expanded"), expanded, path);
      cleanup();
    }
  } finally {
    window.open = originalOpen;
  }
  assert.deepEqual(openedFiles, []);
});

test("ask tool previews question prompts instead of object coercion", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      isStreaming: true,
      toolCallsDefaultCollapsed: true,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-ask",
            toolName: "ask",
            input: {
              questions: [
                {
                  header: "Color",
                  question: "Which color do you prefer?",
                  options: [{ label: "Blue" }],
                  multiSelect: false,
                },
                {
                  header: "Features",
                  question: "Which features should be enabled?",
                  options: [{ label: "Search" }],
                  multiSelect: true,
                },
              ],
            },
          },
        ],
      },
    }),
  );

  assert.match(html, /Color: Which color do you prefer\?/);
  assert.match(html, /Features: Which features should be enabled\?/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("expanded read output uses compact terminal text without line gutters", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      isStreaming: true,
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "foo.ts" },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            content: [
              { type: "text", text: "1: const value = 1;\\n2: return value;" },
            ],
          },
        ],
      ]),
    }),
  );

  assert.match(html, /data-tool-output="true"/);
  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, /1: const value/);
});

test("tool operations render as compact timeline rows", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        timestamp: 1000,
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "npm test" },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            content: [],
            timestamp: 3000,
          },
        ],
      ]),
    }),
  );

  assert.match(html, /data-activity-operation="true"/);
  assert.doesNotMatch(html, /activity-row-indicator/);
  assert.match(html, /activity-row-duration/);
  assert.doesNotMatch(html, /border-radius:7px/);
});
test("task tool results render a per-subagent summary panel", () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, {
      details: {
        totalDurationMs: 360000,
        async: { state: "completed", jobId: "Scout", type: "task" },
        results: [
          {
            id: "Scout",
            agent: "scout",
            task: "Map the surface",
            exitCode: 0,
            tokens: 999000,
            cost: 1.25,
            durationMs: 360000,
            resolvedModel: "provider/gpt-5.6:medium",
          },
          {
            id: "Worker",
            agent: "worker",
            task: "Write the code",
            exitCode: 1,
            error: "Test failed",
            tokens: 500,
          },
        ],
      },
    }),
  );

  assert.match(html, /Subagents/);
  assert.match(html, /Map the surface/);
  assert.match(html, /Write the code/);
  assert.match(html, />Scout</);
  // A long job ID is capped to a share of the row so the task text keeps visible width.
  assert.match(
    html,
    /<span title="Scout" style="[^"]*max-width:min\(200px, 40%\)/,
  );
  assert.match(html, /aria-label="Worker \(worker\): /);
  assert.match(html, /2 subagents/);
  assert.match(html, /999k tok/);
  assert.match(html, /gpt-5.6/);
  assert.match(html, /\u23a4|⤴/);
});

test("task panel renders nothing without task details", () => {
  assert.equal(
    renderToStaticMarkup(
      React.createElement(TaskResultPanel, { details: undefined }),
    ),
    "",
  );
  assert.equal(
    renderToStaticMarkup(
      React.createElement(TaskResultPanel, { details: { patch: "p" } }),
    ),
    "",
  );
});

test("async-only task details render the job as one started row", () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskResultPanel, {
      details: {
        async: { state: "running", jobId: "AsyncAudit", type: "task" },
      },
    }),
  );
  assert.match(html, /1 subagent/);
  assert.match(html, /AsyncAudit/);
  assert.doesNotMatch(html, /0 subagents/);
});

test("irc:incoming custom messages title with the sender name", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      message: {
        role: "custom",
        customType: "irc:incoming",
        content:
          "<irc>\nIncoming IRC message from agent `AuditUiComponents`:\n\nPlease review the current tree.\nThanks.",
        display: true,
      },
    }),
  );
  assert.match(html, /AuditUiComponents/);
  assert.doesNotMatch(html, /irc:incoming/);
  assert.match(html, /Please review the current tree/);
  assert.doesNotMatch(html, /Incoming IRC message from agent/);
});
test("task chat uses a collapsible activity row and renders its full message", () => {
  const view = render(React.createElement(MessageView, {
    message: { role: "custom", customType: "irc:incoming", display: true,
      content: "<irc>\nIncoming IRC message from agent `Worker`:\nFirst line\n\n**Full message**" },
  }));
  const row = view.getByRole("button", { expanded: false });
  assert.match(row.textContent!, /Worker.*First line/);
  assert.equal(row.querySelector("svg.lucide-check"), null);
  assert.doesNotMatch(view.container.textContent!, /Full message/);
  fireEvent.click(row);
  assert.equal(view.container.querySelector("strong")?.textContent, "Full message");
  fireEvent.click(view.getByRole("button", { expanded: true }));
  assert.doesNotMatch(view.container.textContent!, /Full message/);
});


test("hub send renders as an IRC row with the steered message", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      isStreaming: true,
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-hub-1",
            toolName: "hub",
            input: {
              op: "send",
              to: "VisualFix",
              message: "Please ensure the readout path is fixed.\nThanks.",
            },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-hub-1",
          {
            role: "toolResult",
            toolCallId: "call-hub-1",
            toolName: "hub",
            content: [
              {
                type: "text",
                text: "Delivered to 1 peer(s):\n- VisualFix: injected",
              },
            ],
            details: {
              op: "send",
              to: ["VisualFix"],
              receipts: [{ to: "VisualFix", outcome: "injected" }],
            },
          },
        ],
      ]),
    }),
  );

  assert.match(html, /IRC → VisualFix injected/);
  assert.match(html, /Please ensure the readout path is fixed/);
  assert.doesNotMatch(html, /Delivered to 1 peer/);
});

test("wait results render restricted markdown without changing other tool output", () => {
  const output = (toolName: string) =>
    renderToStaticMarkup(
      React.createElement(MessageView, {
        isStreaming: true,
        toolCallsDefaultCollapsed: false,
        message: {
          role: "assistant",
          model: "test",
          provider: "test",
          content: [
            { type: "toolCall", toolCallId: "call", toolName, input: {} },
          ],
        },
        toolResults: new Map<string, ToolResultMessage>([
          [
            "call",
            {
              role: "toolResult",
              toolCallId: "call",
              toolName,
              content: [
                {
                  type: "text",
                  text: '## Still Running\n\n- `Worker` **active**\n\n<system-notice>\nWait carefully.\n</system-notice>\n\nAfterward.\n\n<system-reminder reason="rule_violation" note="a>b &gt; c">Keep working.</system-reminder>',
                },
              ],
            },
          ],
        ]),
      }),
    );
  const wait = output("wait");
  assert.match(wait, /<div class="tool-output-heading">Still Running<\/div>/);
  assert.match(
    wait,
    /<li[^>]*><code[^>]*>Worker<\/code> <strong>active<\/strong><\/li>/,
  );
  assert.doesNotMatch(wait, /<h2/);
  assert.match(
    wait,
    /<details class="tool-output-notice"><summary>System notice<\/summary><div>Wait carefully\.<\/div><\/details>/,
  );
  assert.match(wait, /<p[^>]*>Afterward\.<\/p>/);
  assert.match(
    wait,
    /<details class="tool-output-notice"><summary>System reminder<\/summary><div>reason=&quot;rule_violation&quot; note=&quot;a&gt;b &amp;gt; c&quot;\nKeep working\.<\/div><\/details>/,
  );
  assert.doesNotMatch(wait, /&lt;\/?system-(?:notice|reminder)&gt;/);
  assert.doesNotMatch(output("bash"), /<strong>active<\/strong>/);
});

test("hub jobs renders the waiting roster instead of raw markdown", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      isStreaming: true,
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-hub-2",
            toolName: "hub",
            input: { op: "jobs" },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-hub-2",
          {
            role: "toolResult",
            toolCallId: "call-hub-2",
            toolName: "hub",
            content: [
              {
                type: "text",
                text: "## Still Running (2)\n\n- `VisualFix` [task]",
              },
            ],
            details: {
              op: "jobs",
              jobs: [
                {
                  id: "VisualFix",
                  type: "task",
                  status: "running",
                  label: "VisualFix",
                  durationMs: 1890000,
                },
                {
                  id: "VisualTrace",
                  type: "task",
                  status: "running",
                  label: "VisualTrace",
                  durationMs: 1890000,
                },
              ],
            },
          },
        ],
      ]),
    }),
  );

  assert.match(html, /waiting on 2 jobs/);
  assert.match(html, /VisualTrace/);
  assert.match(html, /31m30s/);
  assert.doesNotMatch(html, /Still Running/);
});

test("hub jobs without structured details keeps the raw result", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      isStreaming: true,
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-hub-3",
            toolName: "hub",
            input: { op: "jobs" },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-hub-3",
          {
            role: "toolResult",
            toolCallId: "call-hub-3",
            toolName: "hub",
            content: [{ type: "text", text: "## Still Running (1)" }],
          },
        ],
      ]),
    }),
  );

  assert.match(html, /Still Running/);
});

test("advisor messages display their substantive markdown without expansion", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "advisor",
      content: "Consider **the edge case**.\n\nA second recommendation.",
      display: true,
    },
  }));
  assert.match(view.container.textContent!, /Advisor/);
  assert.equal(view.container.querySelector("strong")?.textContent, "the edge case");
  assert.match(view.container.textContent!, /A second recommendation/);
  assert.equal(view.container.querySelector(".activity-row-trigger"), null);
});

test("advisor findings show each severity and restricted markdown", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom", customType: "advisor", display: true,
      content: "agent-facing batch",
      details: { notes: [
        { severity: "concern", note: "Check `request` and **retry**. [link](https://example.com)" },
        { severity: "blocker", note: "Stop here." },
        { severity: "nit", note: "Small fix." },
      ] },
    },
  }));
  const findings = view.container.querySelectorAll(".advisor-finding");
  assert.equal(findings.length, 3);
  assert.equal(findings[0].querySelector(".advisor-severity-concern")?.textContent, "concern");
  assert.equal(findings[0].querySelector("code")?.textContent, "request");
  assert.equal(findings[0].querySelector("strong")?.textContent, "retry");
  assert.equal(findings[0].querySelector("a"), null);
  assert.match(findings[0].textContent!, /\[link\]\(https:\/\/example.com\)/);
  assert.equal(findings[1].querySelector(".advisor-severity-blocker")?.textContent, "blocker");
  assert.equal(findings[2].querySelector(".advisor-severity-nit")?.textContent, "nit");
  assert.doesNotMatch(view.container.textContent!.split("JSON")[0], /agent-facing batch/);
});

test("skill prompts start collapsed and can be expanded and collapsed", () => {
  const view = render(
    React.createElement(MessageView, {
      message: {
        role: "custom",
        customType: "skill-prompt",
        content: "Skill invoked\n\nFull skill instructions",
        display: true,
      },
    }),
  );
  assert.match(view.getByRole("button", { expanded: false }).textContent!, /Skill invoked/);
  assert.ok(view.container.querySelector(".activity-row-trigger"));
  assert.doesNotMatch(view.container.textContent!, /Full skill instructions/);
  fireEvent.click(view.getByRole("button", { expanded: false }));
  assert.match(view.container.textContent!, /Full skill instructions/);
  fireEvent.click(view.getByRole("button", { expanded: true }));
  assert.doesNotMatch(view.container.textContent!, /Full skill instructions/);
});

test("a saved skill invocation shows the submitted prompt outside process details", () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const prompt = "Please review the search plan.\n\nStart with **empty queries**.";
  const { messages, entryIds } = buildSessionContext([
    {
      type: "message", id: "u1", parentId: null, timestamp,
      message: { role: "user", content: "Earlier question" },
    },
    {
      type: "custom_message", id: "eval", parentId: "u1", timestamp,
      customType: "eval-state-context", display: false, content: "Eval context",
    },
    {
      type: "custom_message", id: "skill", parentId: "eval", timestamp,
      customType: "skill-prompt", display: true,
      content: `Skill invoked\n\nFull skill instructions\n\nUser:\n${prompt}`,
      details: { prompt },
    },
    {
      type: "message", id: "a1", parentId: "skill", timestamp,
      message: { role: "assistant", provider: "p", model: "m", content: [
        { type: "toolCall", toolCallId: "call", toolName: "read", input: { path: "plan.md" } },
        { type: "text", text: "Let's start with empty queries." },
      ] },
    },
  ]);
  const [, turn] = planTranscriptRows(messages);
  assert.equal(turn.kind, "group");
  const view = render(React.createElement(MessageView, {
    message: messages[turn.userIndex],
    entryId: entryIds[turn.userIndex],
  }));
  const bubble = view.container.querySelector(".markdown-user-message");
  assert.match(bubble?.textContent ?? "", /Please review the search plan/);
  assert.equal(bubble?.querySelector("strong")?.textContent, "empty queries");
  assert.doesNotMatch(view.container.textContent!, /Full skill instructions/);
  fireEvent.click(view.getByRole("button", { name: /skill-prompt/, expanded: false }));
  assert.match(view.container.textContent!, /Full skill instructions/);
});

test("async-result notices preserve lines and wrap when expanded", () => {
  const view = render(
    React.createElement(MessageView, {
      message: {
        role: "custom",
        customType: "async-result",
        content:
          "<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\n/root/repo\n---\nWall time: 0.16 seconds\n</system-notice>",
        display: true,
      },
    }),
  );
  assert.equal(view.container.querySelector("pre"), null);
  assert.match(view.container.textContent!, /Background job bg_1 has completed/);
  assert.ok(view.container.querySelector(".activity-row-trigger"));
  const header = view.getByRole("button", { expanded: false });
  assert.ok(header.querySelector("svg.lucide-clock"));
  assert.equal(header.querySelector("svg.lucide-check"), null);
  assert.doesNotMatch(view.container.textContent!, /Wall time/);

  fireEvent.click(view.getByRole("button", { expanded: false }));
  const pre = view.container.querySelector("pre")!;
  assert.equal(
    pre.textContent,
    "Background job bg_1 has completed. Resume your work using the result below.\n/root/repo\n---\nWall time: 0.16 seconds",
  );
  assert.ok(pre.classList.contains("activity-result-text"));
  assert.ok(view.getByRole("button", { name: /copy/i }).classList.contains("message-copy-action"));
  assert.doesNotMatch(view.container.innerHTML, /system-notice|<h2/);
});

test("async-result details show job status and duration while retaining raw JSON", () => {
  const view = render(
    React.createElement(MessageView, {
      message: {
        role: "custom",
        customType: "async-result",
        display: true,
        content: "2 background jobs have completed.",
        details: {
          jobs: [
            {
              jobId: "HttpSystem",
              type: "task",
              status: "completed",
              label: "HttpSystem",
              durationMs: 194633,
            },
            {
              jobId: "HttpSessions",
              type: "task",
              status: "failed",
              label: "HttpSessions",
              durationMs: 211815,
            },
          ],
        },
      },
    }),
  );
  assert.ok(view.getByRole("button", { expanded: false }).querySelector(".activity-row-indicator-error svg.lucide-circle-alert"));
  fireEvent.click(view.getByRole("button", { expanded: false }));
  assert.match(view.container.textContent!, /HttpSystem/);
  assert.match(view.container.textContent!, /3m14s/);
  assert.match(view.container.textContent!, /3m31s/);
  const raw = view.container.querySelector("details")!;
  assert.equal(raw.open, false);
  assert.match(raw.textContent!, /194633/);
});

test("completed job-result rows show the completion message without a check mark", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "job-result",
      display: true,
      content: "Search review finished.",
      details: { jobs: [{ jobId: "search-review", type: "task", status: "completed" }] },
    },
  }));
  const header = view.getByRole("button", { expanded: false });
  assert.match(header.textContent!, /job-result.*Search review finished\./);
  assert.equal(header.querySelector("svg.lucide-check"), null);
});

test("cancelled async jobs render the aborted status instead of a running indicator", () => {
  const view = render(
    React.createElement(MessageView, {
      message: {
        role: "custom",
        customType: "async-result",
        display: true,
        content: "Background job cancelled.",
        details: {
          jobs: [{ jobId: "cancelled-job", type: "task", status: "cancelled" }],
        },
      },
    }),
  );
  assert.ok(view.getByRole("button", { expanded: false }).querySelector(".activity-row-indicator svg.lucide-ban"));
  fireEvent.click(view.getByRole("button", { expanded: false }));
  assert.ok(view.container.querySelector("svg.lucide-ban"));
  assert.equal(view.container.querySelector(".live-status-dot"), null);
});

test("late LSP diagnostics show structured findings and retain multiline text", () => {
  const view = render(
    React.createElement(MessageView, {
      message: {
        role: "custom",
        customType: "lsp-late-diagnostic",
        content:
          "<system-notice>\nLate LSP diagnostics arrived after the edit returned:\n/repo/a.py — 0 error(s), 1 warning(s)\n/repo/a.py:8:1 [warning] [Ruff] Import block is un-sorted or un-formatted\n\nhelp: Organize imports (I001)\n</system-notice>",
        display: true,
      },
    }),
  );
  assert.match(view.getByRole("button", { expanded: false }).textContent!, /Late LSP diagnostics/);
  assert.ok(view.container.querySelector(".activity-row-trigger"));
  assert.ok(view.getByRole("button", { expanded: false }).querySelector(".activity-row-indicator svg.lucide-circle-alert"));
  assert.doesNotMatch(view.container.textContent!, /Organize imports/);
  fireEvent.click(view.getByRole("button", { expanded: false }));
  assert.match(view.container.querySelector(".late-diagnostic-heading")!.textContent!, /warning.*Ruff.*\/repo\/a\.py:8:1/);
  assert.match(view.container.querySelector(".late-diagnostic-text:last-child")!.textContent!, /Late LSP diagnostics/);
  assert.match(view.container.textContent!, /Import block is un-sorted or un-formatted\n\nhelp: Organize imports \(I001\)/);
  assert.ok(view.getByRole("button", { name: /copy/i }));
  assert.doesNotMatch(view.container.innerHTML, /system-notice/);
});

test("developer reminders show their wrapper attributes, start collapsed, and toggle from the header", () => {
  const view = render(
    React.createElement(MessageView, {
      message: {
        role: "custom",
        customType: "developer",
        content: [
          {
            type: "text",
            text: '<system-reminder reason="rule_violation" rule="ts-no-tiny-functions" path="builtin-defaults:ts-no-tiny-functions.md" note="a>b">\nUser-defined rule matched tool-call arguments.\n\n## Why\n\n- One-line wrappers: no real behavior.\n</system-reminder>',
          },
        ],
        display: true,
      },
    }),
  );
  const header = view.getByRole("button", { expanded: false });
  assert.ok(header.classList.contains("activity-row-trigger"));
  assert.equal(header.querySelector("svg.lucide-check"), null);
  assert.match(header.textContent!, /system-reminder/);
  assert.match(header.textContent!, /rule_violation/);
  assert.match(header.textContent!, /ts-no-tiny-functions/);
  assert.match(header.textContent!, /builtin-defaults:ts-no-tiny-functions\.md/);
  assert.match(header.textContent!, /note=a>b/);
  // A `>` inside an attribute value must not leak wrapper syntax into the body.
  assert.match(header.textContent!, /User-defined rule matched tool-call arguments/);
  assert.doesNotMatch(view.container.textContent!, /b">/);
  assert.doesNotMatch(view.container.textContent!, /One-line wrappers/);

  fireEvent.click(header);
  assert.equal(header.getAttribute("aria-expanded"), "true");
  assert.match(
    view.container.textContent!,
    /One-line wrappers: no real behavior/,
  );
  assert.doesNotMatch(view.container.textContent!, /<system-reminder/);

  fireEvent.click(header);
  assert.doesNotMatch(view.container.textContent!, /One-line wrappers/);
});

test("hook and unknown operational messages preview, expand, and preserve markdown and details", () => {
  for (const customType of ["hook", "extension-event"]) {
    const view = render(React.createElement(MessageView, {
      message: {
        role: "custom",
        customType,
        content: "Operation started\n\n**Full operation output**",
        details: { source: "extension", count: 42 },
        display: true,
      },
    }));
    const row = view.getByRole("button", { expanded: false });
    assert.ok(row.classList.contains("activity-row-trigger"));
    assert.match(row.textContent!, /Operation started/);
    assert.doesNotMatch(view.container.textContent!, /Full operation output/);
    fireEvent.click(row);
    assert.equal(view.container.querySelector("strong")?.textContent, "Full operation output");
    assert.match(view.container.textContent!, /42/);
    assert.match(view.container.textContent!, /extension/);
    fireEvent.click(view.getByRole("button", { expanded: true }));
    assert.doesNotMatch(view.container.textContent!, /Full operation output/);
    view.unmount();
  }
});

test("hidden extension messages remain distinct collapsed activity rows with their content and image", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "extension-event",
      display: false,
      content: [
        { type: "text", text: "Hidden event\n\n**Private extension output**" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      details: { eventId: "hidden-123" },
    },
  }));
  const row = view.getByRole("button", { expanded: false });
  assert.ok(row.classList.contains("activity-row-trigger"));
  assert.match(row.textContent!, /hidden/i);
  assert.match(row.textContent!, /Hidden event/);
  assert.equal(view.container.querySelector("img"), null);
  assert.doesNotMatch(view.container.textContent!, /Private extension output/);
  fireEvent.click(row);
  assert.equal(view.container.querySelector("strong")?.textContent, "Private extension output");
  assert.match(view.container.querySelector("img")?.getAttribute("src") ?? "", /^data:image\/png;base64,aGVsbG8=/);
  assert.match(view.container.textContent!, /hidden-123/);
});

test("compaction is a collapsed boundary that retains token metadata and the summary", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "compaction",
      display: true,
      content: "## Summary\n\n**Important retained context**\n\n<read-files>\n/repo/read.ts\n</read-files>\n<modified-files>\n/repo/write.ts\n</modified-files>",
      details: { tokensBefore: 120000, tokensAfter: 18000, method: "auto" },
    },
  }));
  const boundary = view.getByRole("button", { expanded: false });
  assert.match(boundary.textContent!, /compact/i);
  assert.match(boundary.textContent!, /120/);
  assert.match(boundary.textContent!, /18/);
  assert.doesNotMatch(view.container.textContent!, /Important retained context/);
  fireEvent.click(boundary);
  assert.equal(view.container.querySelector("strong")?.textContent, "Important retained context");
  assert.match(view.container.textContent!, /auto/i);
  assert.match(view.container.textContent!, /read\.ts/);
  assert.match(view.container.textContent!, /write\.ts/);
  fireEvent.click(view.getByRole("button", { expanded: true }));
  assert.doesNotMatch(view.container.textContent!, /Important retained context/);
});

test("passive tool context from a session file renders on the batch's last tool card", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const entry = (
    id: string,
    parentId: string | null,
    message: unknown,
  ): SessionEntry =>
    ({
      type: "message",
      id,
      parentId,
      timestamp: at,
      message,
    }) as SessionEntry;
  const { messages } = buildSessionContext([
    entry("u1", null, { role: "user", content: "look around" }),
    entry("a1", "u1", {
      role: "assistant",
      provider: "t",
      model: "m",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "a.ts" },
        },
        {
          type: "toolCall",
          id: "call-2",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    }),
    entry("r1", "a1", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "a" }],
    }),
    entry("r2", "r1", {
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "bash",
      content: [{ type: "text", text: "b" }],
    }),
    entry("d1", "r2", {
      role: "developer",
      attribution: "agent",
      passiveToolContext: true,
      timestamp: 1,
      content: [
        {
          type: "text",
          text: "\x1b[2mTreat\tthis result\nas authoritative.\x1b[0m",
        },
      ],
    }),
    entry("d2", "d1", {
      role: "developer",
      content: [{ type: "text", text: "Unmarked steering note." }],
      timestamp: 2,
    }),
    entry("a2", "d2", {
      role: "assistant",
      provider: "t",
      model: "m",
      content: [{ type: "text", text: "Done." }],
    }),
  ]);
  const toolResults = collectToolResults(messages);
  const html = (message: AgentMessage) =>
    renderToStaticMarkup(
      React.createElement(MessageView, {
        message,
        toolResults,
        toolCallsDefaultCollapsed: false,
      }),
    );
  // Expanded tool group, collapsed cards: one truncating row on the last card, the full text on hover.
  const shown = html(messages[1]);
  assert.equal(shown.match(/>Context:/g)?.length, 1);
  assert.match(
    shown,
    /class="activity-row-secondary" title="Context: Treat\tthis result\nas authoritative\."><span aria-hidden="true">↳ <\/span>Context: Treat\tthis result\nas authoritative\./,
  );
  assert.ok(shown.indexOf(">read<") < shown.indexOf(">bash<"));
  assert.ok(
    shown.indexOf("Context:") > shown.indexOf(">bash<"),
    "the line sits on the last card (call-2)",
  );
  assert.doesNotMatch(shown, /tool-call-context/);
  // An expanded card shows the full text as its own segment at the end of its details instead.
  assert.ok(messages[1].role === "assistant");
  const single: AssistantMessage = {
    ...messages[1],
    content: [messages[1].content[1]],
  };
  const view = render(
    React.createElement(MessageView, { message: single, toolResults }),
  );
  fireEvent.click(view.getByRole("button", { expanded: false }));
  const segment = view.container.querySelector(
    ".tool-call-details .tool-call-context",
  );
  assert.equal(
    segment?.textContent,
    "↳ Context: Treat\tthis result\nas authoritative.",
  );
  assert.equal(
    view.container.querySelector(".activity-row-secondary[title]"),
    null,
    "no truncated row while expanded",
  );
  // A harness wrapper shows as a label, titled like a developer message, never as raw tag text.
  const wrapped = new Map(toolResults);
  wrapped.set("call-2", {
    ...toolResults.get("call-2")!,
    passiveContext:
      '<system-reminder reason="rule_violation" rule="ts-set-map">\nUse a Record.\n</system-reminder>',
  });
  const labeled = renderToStaticMarkup(
    React.createElement(MessageView, { message: single, toolResults: wrapped }),
  );
  assert.match(
    labeled,
    /↳ <\/span>Context \(system-reminder · reason=rule_violation · rule=ts-set-map\): Use a Record\.<\/div>/,
  );
  assert.doesNotMatch(labeled, /&lt;/);
  // The length cap can cut the closing tag; the opening tag still never leaks, and empty values drop out.
  wrapped.set("call-2", {
    ...toolResults.get("call-2")!,
    passiveContext: '<system-reminder reason="" rule="ts-set-map">\nUse a Rec',
  });
  const cut = renderToStaticMarkup(
    React.createElement(MessageView, { message: single, toolResults: wrapped }),
  );
  assert.match(
    cut,
    /↳ <\/span>Context \(system-reminder · rule=ts-set-map\): Use a Rec<\/div>/,
  );
  assert.doesNotMatch(cut, /&lt;|reason=/);
  // Expanded, the wrapper becomes a nested card: its title as the header, the body below.
  wrapped.set("call-2", {
    ...toolResults.get("call-2")!,
    passiveContext:
      '<system-reminder source="graphify">\nMANDATORY: run `graphify query`.\n</system-reminder>',
  });
  const card = render(
    React.createElement(MessageView, { message: single, toolResults: wrapped }),
  );
  fireEvent.click(card.getAllByRole("button", { expanded: false }).at(-1)!);
  const nested = card.container.querySelector(
    ".tool-call-details .tool-call-context-card",
  );
  assert.equal(
    nested?.querySelector(".tool-call-context-title")?.textContent,
    "↳ system-reminder · source=graphify",
  );
  assert.equal(
    nested?.querySelector(".tool-call-context-body")?.textContent,
    "MANDATORY: run `graphify query`.",
  );
  // The marked message is no row of its own; the unmarked one still is.
  assert.ok(messages[4].role === "custom");
  assert.equal(messages[4].customType, "passive-tool-context");
  assert.equal(html(messages[4]), "");
  assert.ok(messages[5].role === "custom");
  assert.equal(messages[5].customType, "developer");
  assert.equal(messages[5].display, true);
  assert.match(html(messages[5]), /Unmarked steering note\./);
  const row = planTranscriptRows(messages)[0];
  assert.equal(row.kind, "group");
  assert.deepEqual(
    row.segments.map((segment) =>
      segment.kind === "text"
        ? "text"
        : segment.kind === "message" ? segment.index : segment.pieces.map((piece) => piece.index),
    ),
    [[1, 5], "text"],
  );
});

test("a deferred thinking block rendered from a block subset loads its source block", async (t) => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ thinking: "loaded" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const view = render(
    React.createElement(MessageView, {
      message: {
        role: "assistant",
        provider: "t",
        model: "m",
        content: [{ type: "thinking", thinking: "", deferred: true }],
      },
      sessionId: "s1",
      entryId: "e1",
      sourceBlockIndices: [2],
    }),
  );
  await act(async () => {
    fireEvent.click(view.container.querySelector(".activity-row-trigger")!);
  });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/entries\/e1\/thinking\?blockIndex=2$/);
});

test("thinking blocks stay collapsed by default and open with the expand preference", async () => {
  const message: AssistantMessage = {
    role: "assistant",
    provider: "t",
    model: "m",
    content: [
      { type: "thinking", thinking: "weighing the options" },
      { type: "text", text: "Answer" },
    ],
  };
  const html = (props: Partial<MessageProps>) =>
    renderToStaticMarkup(
      React.createElement(MessageView, { message, ...props }),
    );
  // Default (off): unchanged behavior — the reasoning text is not rendered.
  assert.doesNotMatch(html({}), /weighing the options/);
  assert.doesNotMatch(
    html({ expandThinkingByDefault: false }),
    /weighing the options/,
  );
  // On: the block is open on mount, so reading reasoning needs no clicks.
  assert.match(html({ expandThinkingByDefault: true }), /weighing the options/);
  // The same initial state covers a streaming block on purpose (see ThinkingBlock):
  // the reasoning the preference is meant to expose is the one being written.
  assert.match(
    html({ expandThinkingByDefault: true, isStreaming: true }),
    /weighing the options/,
  );
});

test("the model label hides on activity-only rows but stays on a row that also carries reply text", () => {
  const html = (content: AssistantContentBlock[]) =>
    renderToStaticMarkup(
      React.createElement(MessageView, {
        message: {
          role: "assistant",
          provider: "t",
          model: "label-model",
          content,
        },
        modelNames: { "t:label-model": "Label Model" },
      }),
    );
  const labelShown = (markup: string) =>
    /display:flex[^>]*><span>Label Model<\/span>/.test(markup);
  assert.equal(
    labelShown(html([{ type: "thinking", thinking: "plan" }])),
    false,
  );
  // Unfolded thinking rides in the reply's segment; the reply keeps its attribution.
  assert.equal(
    labelShown(
      html([
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Answer" },
      ]),
    ),
    true,
  );
  assert.equal(labelShown(html([{ type: "text", text: "Answer" }])), true);
});

test("an expanded thinking block collapses and re-expands by hand", async () => {
  const message: AssistantMessage = {
    role: "assistant",
    provider: "t",
    model: "m",
    content: [{ type: "thinking", thinking: "weighing the options" }],
  };
  const view = render(
    React.createElement(MessageView, {
      message,
      expandThinkingByDefault: true,
    }),
  );
  const output = () =>
    view.container.querySelector(".thinking-output")?.textContent;
  assert.equal(output(), "weighing the options");
  const trigger = view.container.querySelector(".activity-row-trigger")!;
  await act(async () => {
    fireEvent.click(trigger);
  });
  assert.equal(output(), undefined);
  await act(async () => {
    fireEvent.click(trigger);
  });
  assert.equal(output(), "weighing the options");
});

test("latest thinking advances without overriding manual toggles on updates", async () => {
  const message: AssistantMessage = {
    role: "assistant",
    provider: "t",
    model: "m",
    content: [
      { type: "thinking", thinking: "first" },
      { type: "thinking", thinking: "second" },
    ],
  };
  const element = (latest: number | null, msg = message) =>
    React.createElement(MessageView, {
      message: msg,
      isStreaming: true,
      latestThinkingBlockIndex: latest,
    });
  const view = render(element(0));
  const outputs = () =>
    [...view.container.querySelectorAll(".thinking-output")].map(
      (el) => el.textContent,
    );
  assert.deepEqual(outputs(), ["first"]);
  view.rerender(element(1));
  assert.deepEqual(outputs(), ["second"]);
  fireEvent.click(view.container.querySelectorAll(".activity-row-trigger")[1]);
  view.rerender(element(1, { ...message }));
  assert.deepEqual(outputs(), []);
  fireEvent.click(view.container.querySelectorAll(".activity-row-trigger")[0]);
  assert.deepEqual(outputs(), ["first"]);
  view.rerender(element(0));
  assert.deepEqual(outputs(), ["first"]);
  view.rerender(element(null));
  assert.deepEqual(outputs(), []);
});

test("a deferred thinking block auto-expanded by the preference loads its source block", async (t) => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ thinking: "loaded" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  // Ids of their own: loadThinkingContent caches per (session, entry, block),
  // and the click test above already loaded s1/e1 block 2 in this process.
  const view = render(
    React.createElement(MessageView, {
      message: {
        role: "assistant",
        provider: "t",
        model: "m",
        content: [{ type: "thinking", thinking: "", deferred: true }],
      },
      sessionId: "s2",
      entryId: "e2",
      sourceBlockIndices: [3],
      expandThinkingByDefault: true,
    }),
  );
  await waitFor(() =>
    assert.equal(
      view.container.querySelector(".thinking-output")?.textContent,
      "loaded",
    ),
  );
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/entries\/e2\/thinking\?blockIndex=3$/);
});

test("a running tool call shows a spinner instead of the no-result marker", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "long-job" },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [],
            partial: true,
          },
        ],
      ]),
    }),
  );

  assert.match(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /lucide-check/);
  assert.doesNotMatch(html, /lucide-circle-slash/);
});

test("a running tool with no output yet says so instead of reporting no output", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "long-job" },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [],
            partial: true,
          },
        ],
      ]),
    }),
  );

  assert.match(html, /data-tool-running="true"/);
  assert.doesNotMatch(html, /No output/);
});

test("a running tool streams its output before the result is committed", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "long-job" },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "line-1\nline-2" }],
            partial: true,
          },
        ],
      ]),
    }),
  );

  assert.match(html, /data-tool-output="true"/);
  assert.match(html, /line-1/);
  assert.match(html, /line-2/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
});

test("a committed tool result replaces the running affordances", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "long-job" },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "done" }],
            timestamp: 3000,
          },
        ],
      ]),
    }),
  );

  assert.doesNotMatch(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
  assert.doesNotMatch(html, /lucide-check/);
});

test("failed tool rows tint the category icon and name the failure accessibly", () => {
  const view = render(React.createElement(MessageView, {
    message: { role: "assistant", model: "test", provider: "test", content: [
      { type: "toolCall", toolCallId: "failed-read", toolName: "read", input: { path: "notes.txt" } },
    ] },
    toolResults: new Map<string, ToolResultMessage>([["failed-read", {
      role: "toolResult",
      toolCallId: "failed-read",
      toolName: "read",
      content: [{ type: "text", text: "File not found" }],
      isError: true,
      timestamp: 3000,
    }]]),
  }));
  try {
    const row = view.getByRole("button", { name: /\bTool call failed\b/ });
    const icon = row.querySelector<SVGElement>(".activity-tool-icon svg.lucide-file-text");
    assert.equal(icon?.style.color, "var(--status-error)");
  } finally {
    view.unmount();
  }
});

test("expanded edit results with a patch render the split diff view", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      isStreaming: true,
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "edit",
            input: { path: "demo.ts" },
          },
        ],
      },
      toolResults: new Map<string, ToolResultMessage>([
        [
          "call-1",
          {
            role: "toolResult",
            toolCallId: "call-1",
            content: [{ type: "text", text: "Patch applied" }],
            details: {
              patch:
                "--- a/demo.ts\n+++ b/demo.ts\n@@ -1,1 +1,2 @@\n const keep = true;\n-dropped const gone = 1;\n+added const here = 2;",
            },
          },
        ],
      ]),
    }),
  );

  // Split diff grid (before/after columns) instead of the raw output <pre>.
  assert.match(
    html,
    /grid-template-columns:minmax\(0, ?1fr\) minmax\(0, ?1fr\)/,
  );
  assert.match(html, /added const here = 2;/);
  assert.match(html, /dropped const gone = 1;/);
  assert.doesNotMatch(html, /<pre/);
});

test("parallel tool calls each render as their own row, never a merged group", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      toolCallsDefaultCollapsed: true,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "a.ts" },
          },
          {
            type: "toolCall",
            toolCallId: "call-2",
            toolName: "read",
            input: { path: "b.ts" },
          },
          {
            type: "toolCall",
            toolCallId: "call-3",
            toolName: "grep",
            input: { pattern: "test" },
          },
        ],
      },
    }),
  );

  assert.equal(html.match(/class="activity-row-trigger"/g)?.length, 3);
  for (const target of ["a.ts", "b.ts", "test"])
    assert.match(html, new RegExp(target));
});

test("todo tool calls render clean status badge with action and task name", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      isStreaming: true,
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "call-1",
            toolName: "todo",
            input: { op: "done", task: "Build redesigned component" },
          },
        ],
      },
    }),
  );

  assert.match(html, /tool-call-todo-badge/);
  assert.match(html, /Completed/);
  assert.match(html, /Build redesigned component/);
});

test("isInterruptedMessage identifies user interruptions accurately", () => {
  assert.equal(isInterruptedMessage("Interrupted by user"), true);
  assert.equal(isInterruptedMessage("interrupted by user"), true);
  assert.equal(isInterruptedMessage("Interrupted"), true);
  assert.equal(isInterruptedMessage("Request aborted"), true);
  assert.equal(isInterruptedMessage("Aborted"), true);
  assert.equal(isInterruptedMessage(null, "aborted"), true);
  assert.equal(isInterruptedMessage("Generation stopped by user"), true);
  assert.equal(isInterruptedMessage("429 Too Many Requests"), false);
  assert.equal(isInterruptedMessage("Provider connection failed"), false);
  assert.equal(isInterruptedMessage(null), false);
});

test("interrupted assistant message renders user-friendly status badge without responseError prefix", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        errorMessage: "Interrupted by user",
        content: [],
      },
    }),
  );

  assert.match(html, /role="status"/);
  assert.match(html, /Generation interrupted/);
  assert.doesNotMatch(html, /messageView\.responseError/);
  assert.doesNotMatch(html, /Response error/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("actual error assistant message renders alert badge without responseError prefix", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        errorMessage: "429 Too Many Requests: Rate limit exceeded",
        content: [],
      },
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /429 Too Many Requests: Rate limit exceeded/);
  assert.doesNotMatch(html, /messageView\.responseError/);
  assert.doesNotMatch(html, /Response error:/);
});

test("interrupted message with partial content renders content before interrupted badge", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      toolCallsDefaultCollapsed: false,
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        errorMessage: "Interrupted by user",
        content: [{ type: "text", text: "Partial generated response text" }],
      },
    }),
  );

  const contentIdx = html.indexOf("Partial generated response text");
  const statusIdx = html.indexOf("Generation interrupted");
  assert.ok(contentIdx !== -1, "partial content must be rendered");
  assert.ok(statusIdx !== -1, "status badge must be rendered");
  assert.ok(
    contentIdx < statusIdx,
    "content must precede the interrupted status badge",
  );
});

const FORK_LABEL = "Fork a new session from this point";

test("agent replies offer copy and fork at their resolved target", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else Reflect.deleteProperty(window, "matchMedia");
  });
  const forked: [string, boolean | undefined][] = [];
  const props: MessageProps = {
    message: {
      role: "assistant",
      model: "test",
      provider: "test",
      content: [{ type: "text", text: "Done." }],
    },
    entryId: "assistant-1",
    // Resolved by resolveForkTargets: the newest reply falls back to its own
    // turn's prompt with edit-and-resend.
    forkEntryId: "user-1",
    forkEditsPrompt: true,
    onFork: (entryId, editPrompt) => forked.push([entryId, editPrompt]),
  };
  const view = render(React.createElement(MessageView, props));
  assert.ok(view.getByRole("button", { name: "Copy message" }));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: FORK_LABEL }));
  });
  assert.deepEqual(forked, [], "the fork button only asks for confirmation");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  });
  assert.deepEqual(forked, []);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: FORK_LABEL }));
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Fork" }));
  });
  assert.deepEqual(forked, [["user-1", true]]);

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: FORK_LABEL }));
  });
  view.rerender(
    React.createElement(MessageView, { ...props, forkDisabled: true }),
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Fork" }));
  });
  assert.deepEqual(
    forked,
    [["user-1", true]],
    "a row blocked while the dialog was open does not fork",
  );
  view.unmount();
});

test("agent replies without text still offer the new-session action", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageView, {
      message: {
        role: "assistant",
        model: "test",
        provider: "test",
        content: [
          {
            type: "toolCall",
            toolCallId: "tool-1",
            toolName: "read",
            input: { path: "a.ts" },
          },
        ],
      },
      entryId: "assistant-2",
      forkEntryId: "user-1",
      onFork: () => {},
    }),
  );
  assert.doesNotMatch(html, /aria-label="Copy message"/);
  assert.match(html, new RegExp(`aria-label="${FORK_LABEL}"`));
});

test("a streaming reply and an unforkable row keep no fork action", () => {
  const reply: AssistantMessage = {
    role: "assistant",
    model: "test",
    provider: "test",
    content: [{ type: "text", text: "Streaming" }],
  };
  const streaming = renderToStaticMarkup(
    React.createElement(MessageView, {
      message: reply,
      entryId: "assistant-3",
      forkEntryId: "user-1",
      onFork: () => {},
      isStreaming: true,
    }),
  );
  assert.doesNotMatch(streaming, new RegExp(`aria-label="${FORK_LABEL}"`));
  assert.doesNotMatch(streaming, /aria-label="Copy message"/);
  assert.doesNotMatch(streaming, /aria-label="Read aloud"/);

  const noTarget = renderToStaticMarkup(
    React.createElement(MessageView, {
      message: reply,
      entryId: "assistant-4",
      onFork: () => {},
    }),
  );
  assert.doesNotMatch(noTarget, new RegExp(`aria-label="${FORK_LABEL}"`));
});

test("user messages fork at their own entry and edit the prompt", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else Reflect.deleteProperty(window, "matchMedia");
  });
  const forked: [string, boolean | undefined][] = [];
  const view = render(
    React.createElement(MessageView, {
      message: { role: "user", content: "Keep this forkable." },
      entryId: "user-7",
      forkEntryId: "user-7",
      onFork: (entryId, editPrompt) => forked.push([entryId, editPrompt]),
    }),
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: FORK_LABEL }));
  });
  assert.deepEqual(forked, []);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Fork" }));
  });
  assert.deepEqual(forked, [["user-7", true]]);
  view.unmount();
});

test("SafeMarkdownBody is wrapped in React.memo", () => {
  const memo = React.memo(() => null);
  assert.ok("$$typeof" in SafeMarkdownBody);
  assert.ok("$$typeof" in memo);
  assert.equal(SafeMarkdownBody.$$typeof, memo.$$typeof);
});

test("areMessageViewPropsEqual skips re-render when unrelated toolResults change", () => {
  const msg1: AssistantMessage = {
    role: "assistant",
    model: "test",
    provider: "test",
    content: [
      { type: "text", text: "Running tool..." },
      {
        type: "toolCall",
        toolCallId: "call-1",
        toolName: "read",
        input: { path: "a.ts" },
      },
    ],
  };
  const res1: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    content: [{ type: "text", text: "file content" }],
  };
  const res2: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-2",
    content: [{ type: "text", text: "another content" }],
  };

  const mapA = new Map([["call-1", res1]]);
  const mapB = new Map([
    ["call-1", res1],
    ["call-2", res2],
  ]);
  const mapC = new Map([
    [
      "call-1",
      { ...res1, content: [{ type: "text" as const, text: "modified" }] },
    ],
  ]);

  const baseProps = { message: msg1, toolResults: mapA };
  // New tool in mapB is unrelated to msg1: props should be considered equal
  assert.equal(
    areMessageViewPropsEqual(baseProps, { ...baseProps, toolResults: mapB }),
    true,
  );
  // Change in msg1's own tool: props should NOT be equal
  assert.equal(
    areMessageViewPropsEqual(baseProps, { ...baseProps, toolResults: mapC }),
    false,
  );
});

test("haveSameRelevantToolResults and MessageView re-render look up hybrid toolCall blocks by toolCallId over id", () => {
  const hybridMsg: AssistantMessage = {
    role: "assistant",
    model: "test",
    provider: "test",
    content: [
      {
        type: "toolCall",
        toolCallId: "call_A",
        toolName: "bash",
        input: {},
        ...{ id: "fc_item_1" },
      },
    ],
  };
  const resA1: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call_A",
    content: [{ type: "text", text: "initial output" }],
  };
  const resA2: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call_A",
    content: [{ type: "text", text: "updated output" }],
  };
  const resLegacyId: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "fc_item_1",
    content: [{ type: "text", text: "wrong lookup" }],
  };

  const mapA1 = new Map([
    ["call_A", resA1],
    ["fc_item_1", resLegacyId],
  ]);
  const mapA1Same = new Map<string, ToolResultMessage>([
    ["call_A", resA1],
    [
      "fc_item_1",
      { ...resLegacyId, content: [{ type: "text", text: "changed legacy" }] },
    ],
  ]);
  const mapA2 = new Map([
    ["call_A", resA2],
    ["fc_item_1", resLegacyId],
  ]);

  // Looking up by toolCallId ("call_A") means changing legacy "fc_item_1" does NOT trigger difference
  assert.equal(haveSameRelevantToolResults(hybridMsg, mapA1, mapA1Same), true);
  // Changing "call_A" returns false
  assert.equal(haveSameRelevantToolResults(hybridMsg, mapA1, mapA2), false);

  // Verify MessageView re-renders with updated tool result when toolResults changes for "call_A"
  const initialProps = {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: hybridMsg,
    toolResults: mapA1,
  };
  const { container, rerender } = render(
    React.createElement(MessageView, initialProps),
  );
  assert.match(container.textContent!, /initial output/);
  assert.doesNotMatch(container.textContent!, /wrong lookup/);

  rerender(
    React.createElement(MessageView, { ...initialProps, toolResults: mapA2 }),
  );
  assert.match(container.textContent!, /updated output/);
  assert.doesNotMatch(container.textContent!, /initial output/);
});

test("haveSameRelevantToolResults and areMessageViewPropsEqual handle toolCall with empty string toolCallId", () => {
  const emptyIdMsg: AssistantMessage = {
    role: "assistant",
    model: "test",
    provider: "test",
    content: [
      { type: "toolCall", toolCallId: "", toolName: "bash", input: {} },
    ],
  };
  const resEmpty1: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "",
    content: [{ type: "text", text: "empty id output 1" }],
  };
  const resEmpty2: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "",
    content: [{ type: "text", text: "empty id output 2" }],
  };
  const resUnrelated: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "other",
    content: [{ type: "text", text: "other" }],
  };

  const mapEmpty1 = new Map([["", resEmpty1]]);
  const mapEmpty2 = new Map([["", resEmpty2]]);
  const mapEmpty1WithUnrelated = new Map([
    ["", resEmpty1],
    ["other", resUnrelated],
  ]);
  const mapEmptyWithoutResult = new Map();

  // Adding a result under "" causes unequal comparison
  assert.equal(
    haveSameRelevantToolResults(emptyIdMsg, mapEmptyWithoutResult, mapEmpty1),
    false,
  );
  // Updating result under "" causes unequal comparison
  assert.equal(
    haveSameRelevantToolResults(emptyIdMsg, mapEmpty1, mapEmpty2),
    false,
  );
  // Unrelated key changing while "" is unchanged causes equal comparison
  assert.equal(
    haveSameRelevantToolResults(emptyIdMsg, mapEmpty1, mapEmpty1WithUnrelated),
    true,
  );

  const baseProps = {
    isStreaming: false,
    message: emptyIdMsg,
    toolResults: mapEmpty1,
  };
  assert.equal(
    areMessageViewPropsEqual(baseProps, {
      ...baseProps,
      toolResults: mapEmpty2,
    }),
    false,
  );
  assert.equal(
    areMessageViewPropsEqual(baseProps, {
      ...baseProps,
      toolResults: mapEmpty1WithUnrelated,
    }),
    true,
  );
});

test("user-message Edit only runs after confirmation, and not once blocked", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else Reflect.deleteProperty(window, "matchMedia");
  });
  const edited: [string, string][] = [];
  const props: MessageProps = {
    message: { role: "user", content: "Rewind to here." },
    entryId: "user-9",
    onEdit: async (entryId, content) => {
      edited.push([entryId, content]);
      return true;
    },
  };
  const view = render(React.createElement(MessageView, props));
  const editButton = view.getByRole("button", {
    name: "Jump back here and edit this message",
  });
  await act(async () => {
    fireEvent.click(editButton);
  });
  assert.deepEqual(edited, [], "the Edit button only asks for confirmation");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  });
  assert.deepEqual(edited, []);
  await act(async () => {
    fireEvent.click(editButton);
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Edit" }));
  });
  assert.deepEqual(edited, [["user-9", "Rewind to here."]]);

  await act(async () => {
    fireEvent.click(editButton);
  });
  view.rerender(
    React.createElement(MessageView, { ...props, editDisabled: true }),
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Edit" }));
  });
  assert.deepEqual(
    edited,
    [["user-9", "Rewind to here."]],
    "a row blocked while the dialog was open does not edit",
  );
  assert.equal(
    view.queryByRole("button", { name: "Edit" }),
    null,
    "confirming closes the dialog",
  );
  view.unmount();
});

test("an open confirmation closes when the row starts showing another message", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else Reflect.deleteProperty(window, "matchMedia");
  });
  const calls: string[][] = [];
  const row = (entryId: string, content: string) =>
    React.createElement(MessageView, {
      message: { role: "user", content },
      entryId,
      onEdit: async (id, text) => {
        calls.push(["edit", id, text]);
        return true;
      },
      onFork: (id) => calls.push(["fork", id]),
    });
  // ChatWindow keys rows by index, so a history swap reuses this component for another entry.
  const view = render(row("user-1", "Selected."));
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", {
        name: "Jump back here and edit this message",
      }),
    );
  });
  view.rerender(row("user-2", "Someone else."));
  assert.equal(
    view.queryByRole("button", { name: "Edit" }),
    null,
    "the Edit dialog closes",
  );

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: FORK_LABEL }));
  });
  view.rerender(row("user-3", "Another one."));
  assert.equal(
    view.queryByRole("button", { name: "Fork" }),
    null,
    "the Fork dialog closes",
  );

  view.rerender(row("user-1", "Selected."));
  assert.equal(
    view.queryByRole("button", { name: "Edit" }),
    null,
    "returning to the entry does not reopen its Edit dialog",
  );
  view.rerender(row("user-2", "Someone else."));
  view.rerender(row("user-3", "Another one."));
  assert.equal(
    view.queryByRole("button", { name: "Fork" }),
    null,
    "returning to the entry does not reopen its Fork dialog",
  );

  // Edit can drop out (onEdit withdrawn) while its dialog is open; it must not come back by itself.
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", {
        name: "Jump back here and edit this message",
      }),
    );
  });
  view.rerender(
    React.createElement(MessageView, {
      message: { role: "user", content: "Another one." },
      entryId: "user-3",
    }),
  );
  view.rerender(row("user-3", "Another one."));
  assert.equal(
    view.queryByRole("button", { name: "Edit" }),
    null,
    "Edit returning does not reopen its dialog",
  );
  assert.deepEqual(calls, []);
  view.unmount();
});

test("a `!` run renders as a shell card with its command, status and output", () => {
  const shell = (message: Omit<BashExecutionMessage, "role">) => {
    const view = render(
      React.createElement(MessageView, {
        message: { role: "bashExecution", ...message },
      }),
    );
    return { view, header: view.container.querySelector(".shell-run-header")! };
  };

  const ok = shell({ command: "git status", output: "clean\n", exitCode: 0 });
  assert.equal(
    ok.header.querySelector(".shell-run-command")!.textContent,
    "git status",
  );
  assert.equal(
    ok.view.container.querySelector(".shell-run-output"),
    null,
    "collapsed until opened",
  );
  fireEvent.click(ok.header);
  assert.equal(
    ok.view.container.querySelector(".shell-run-output")!.textContent,
    "clean\n",
  );
  assert.equal(ok.view.container.querySelector(".shell-run-failed"), null);
  assert.equal(
    ok.header.querySelector(".shell-run-tag"),
    null,
    "only excluded runs are tagged",
  );
  fireEvent.click(ok.header);
  assert.equal(
    ok.view.container.querySelector(".shell-run-output"),
    null,
    "the header closes it again",
  );
  cleanup();

  const failed = shell({ command: "false", output: "", exitCode: 1 });
  assert.match(
    failed.header.querySelector(".shell-run-status")!.textContent!,
    /exit 1/,
  );
  assert.ok(failed.view.container.querySelector(".shell-run-failed"));
  fireEvent.click(failed.header);
  assert.equal(
    failed.view.container.querySelector(".shell-run-output")!.textContent,
    "(no output)",
  );
  cleanup();

  const cancelled = shell({ command: "sleep 9", output: "", cancelled: true });
  assert.match(
    cancelled.header.querySelector(".shell-run-status")!.textContent!,
    /cancelled/,
  );
  cleanup();

  const pending = shell({ command: "make", output: "" });
  assert.ok(
    pending.header.querySelector(".activity-row-spinner"),
    "a running command shows a spinner",
  );
  assert.equal(
    pending.header.getAttribute("aria-disabled"),
    "true",
    "the header cannot be toggled while it runs",
  );
  fireEvent.click(pending.header);
  assert.equal(pending.header.getAttribute("aria-expanded"), "false");
  assert.equal(
    pending.view.container.querySelector(".shell-run-output"),
    null,
    "no empty output while it runs",
  );
});

test("shell card expansion resets for a different run but survives output updates", () => {
  const message: BashExecutionMessage = {
    role: "bashExecution",
    command: "printf hello",
    output: "hello",
    exitCode: 0,
    timestamp: 10,
  };
  const view = render(React.createElement(MessageView, { message }));
  const header = () => view.container.querySelector(".shell-run-header")!;
  fireEvent.click(header());
  assert.equal(header().getAttribute("aria-expanded"), "true");
  view.rerender(
    React.createElement(MessageView, {
      message: { ...message, output: "hello\n" },
    }),
  );
  assert.equal(
    header().getAttribute("aria-expanded"),
    "true",
    "refreshing the same run keeps the reader's expansion",
  );
  view.rerender(
    React.createElement(MessageView, {
      message: { ...message, timestamp: 20 },
    }),
  );
  assert.equal(
    header().getAttribute("aria-expanded"),
    "false",
    "a different run of the same command starts collapsed",
  );
});

test("a branch switch that reuses the card for another untimed run of the same command starts it collapsed", () => {
  const message: BashExecutionMessage = {
    role: "bashExecution",
    command: "ls",
    output: "a",
    exitCode: 0,
  };
  const view = render(
    React.createElement(MessageView, { message, entryId: "e1" }),
  );
  const header = () => view.container.querySelector(".shell-run-header")!;
  fireEvent.click(header());
  view.rerender(
    React.createElement(MessageView, {
      message: { ...message },
      entryId: "e1",
    }),
  );
  assert.equal(
    header().getAttribute("aria-expanded"),
    "true",
    "a reload of the same entry keeps it open",
  );
  view.rerender(
    React.createElement(MessageView, {
      message: { ...message, output: "b" },
      entryId: "e2",
    }),
  );
  assert.equal(header().getAttribute("aria-expanded"), "false");
});

test("a successful shell card exposes its outcome in its accessible name", () => {
  const view = render(
    React.createElement(MessageView, {
      message: {
        role: "bashExecution",
        command: "true",
        output: "",
        exitCode: 0,
      },
    }),
  );
  assert.ok(view.getByRole("button", { name: /true.*succeeded/i }));
});
