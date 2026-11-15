import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
import type { PromptSubmissionResult } from "@/hooks/useAgentSession";
const { cleanup, render, screen, waitFor } =
  await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { ChatInput } = await import("./ChatInput");
const { clearDraft } = await import("@/lib/draft-store");

beforeEach(() => {
  window.matchMedia = (media) => ({
    media,
    matches: false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
});
afterEach(() => {
  cleanup();
  clearDraft("shell-draft");
  localStorage.clear();
  Reflect.deleteProperty(window, "matchMedia");
});

function renderComposer(sendStatus: "accepted" | "rejected") {
  const calls: [string, string][] = [];
  const recordSend = async (text: string): Promise<PromptSubmissionResult> => {
    calls.push(["onSend", text]);
    return { status: sendStatus };
  };
  const recordQueue = (name: string) => async (text: string) => {
    calls.push([name, text]);
    return true;
  };
  render(
    React.createElement(ChatInput, {
      draftKey: "shell-draft",
      isStreaming: true,
      onAbort() {},
      onSend: recordSend,
      onSteer: recordQueue("onSteer"),
      onFollowUp: recordQueue("onFollowUp"),
    }),
  );
  return calls;
}

test("a `!` command typed during a run is sent as a shell command, never queued as text", async () => {
  const user = userEvent.setup();
  const calls = renderComposer("accepted");
  await user.type(screen.getByRole("textbox"), "!git status");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.deepEqual(calls, [["onSend", "!git status"]]));
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      "",
    ),
  );
});

test("a `!` command refused during a run goes back to the draft", async () => {
  const user = userEvent.setup();
  const calls = renderComposer("rejected");
  await user.type(screen.getByRole("textbox"), "!git status");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      "!git status",
    ),
  );
  assert.deepEqual(calls, [["onSend", "!git status"]]);
});
