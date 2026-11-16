import assert from "node:assert/strict";
import "../tests/setup-dom.ts";
import test, { afterEach } from "node:test";
import React from "react";
import type { AgentMessage, AssistantMessage } from "@/lib/types";
import { CommittedTranscript } from "./ChatWindow";

// Testing Library must bind to the document installed by setup-dom first.
const { cleanup, render } = await import("@testing-library/react/pure.js");
afterEach(cleanup);

const reply = (text: string, timestamp: number): AssistantMessage => ({
  role: "assistant",
  provider: "p",
  model: "m",
  timestamp,
  content: [{ type: "text", text }],
});

test("the active turn gets a timestamp only after settling, without hiding an older turn", () => {
  const oldReply = reply("Older answer", 1_700_000_000_000);
  const firstReply = reply("Working", 1_700_000_060_000);
  const finalReply = reply("Finished", 1_700_000_120_000);
  const messages: AgentMessage[] = [
    { role: "user", content: "Earlier question" },
    oldReply,
    { role: "user", content: "Current question" },
    firstReply,
  ];
  const props = (items: AgentMessage[], busy: boolean) => ({
    messages: items,
    entryIds: items.map((_, i) => String(i)),
    conversationMeta: {
      toolResultsMap: new Map(),
      lastAnchorIdx: 2,
      visibleRefIndexByMessage: new Map(items.map((_, i) => [i, i])),
    },
    messageRefs: { current: [] as (HTMLDivElement | null)[] },
    isStreaming: false,
    sessionBusy: busy,
    isCompacting: false,
    externalRunActive: false,
    isNew: false,
    forkingEntryId: null,
    editingEntryId: null,
    handleFork: () => {},
    handleEdit: async () => true,
    modelNames: {},
    messageCwd: undefined,
    sessionId: "s",
    toolCallsDefaultCollapsed: true,
    hideToolActivity: false,
    neverFoldActivity: true,
    showToolCallsUnfolded: false,
    expandThinkingByDefault: "off" as const,
    latestThinking: null,
    hideThinkingBlock: false,
    visibleCount: 100,
    nearBottom: true,
    sentinelRef: React.createRef<HTMLButtonElement>(),
    handleLoadMoreClick: () => {},
  });
  const view = render(React.createElement(CommittedTranscript, props(messages, true)));
  const timestamp = (index: number) =>
    view.container.querySelector(`[data-message-index="${index}"] .message-assistant-footer > span`)?.textContent ?? null;
  const olderTime = timestamp(1);
  assert.ok(olderTime);
  assert.equal(timestamp(3), null);

  const withTool: AgentMessage[] = [...messages, {
    role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "done" }], timestamp: 1_700_000_090_000,
  }];
  view.rerender(React.createElement(CommittedTranscript, props(withTool, true)));
  assert.equal(timestamp(1), olderTime);
  assert.equal(timestamp(3), null);

  const completed = [...withTool, finalReply];
  view.rerender(React.createElement(CommittedTranscript, props(completed, true)));
  assert.equal(timestamp(1), olderTime);
  assert.equal(timestamp(3), null);
  assert.equal(timestamp(5), null);

  view.rerender(React.createElement(CommittedTranscript, props(completed, false)));
  assert.equal(timestamp(1), olderTime);
  assert.equal(timestamp(3), null);
  assert.ok(timestamp(5));
});
