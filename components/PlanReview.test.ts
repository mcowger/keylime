import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";

// Load React DOM consumers after setup-dom installs the browser globals.
const { render, screen, cleanup, fireEvent } =
  await import("@testing-library/react/pure.js");
const { PlanReview } = await import("./PlanReview");
const { ChatInput } = await import("./ChatInput");
afterEach(cleanup);

const proposal = {
  id: "review-1",
  title: "Review this plan",
  content: "## Work\n\nMake the change.",
  planFilePath: "/plans/review.md",
};

test("plan review sends approval or explicit revision feedback", () => {
  const responses: Array<[string, boolean, string | undefined]> = [];
  render(React.createElement(PlanReview, {
    proposal,
    pending: false,
    onRespond: async (id, approved, feedback) => {
      responses.push([id, approved, feedback]);
      return true;
    },
  }));
  assert.ok(screen.getByText("Make the change."));
  fireEvent.click(screen.getByRole("button", { name: "Approve & implement" }));
  fireEvent.click(screen.getByRole("button", { name: "Request revisions" }));
  const send = screen.getByRole("button", { name: "Send revisions" }) as HTMLButtonElement;
  assert.equal(send.disabled, true);
  fireEvent.change(screen.getByRole("textbox", { name: "Revision feedback" }), {
    target: { value: "  Explain testing  " },
  });
  fireEvent.click(send);
  assert.deepEqual(responses, [["review-1", true, undefined], ["review-1", false, "Explain testing"]]);
});

test("mode button cycles between Build and Plan, including during a run", () => {
  window.matchMedia = (media) => ({
    media, matches: false, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  });
  const selections: boolean[] = [];
  const props = {
    onSend: async () => ({ status: "accepted" as const }),
    onAbort() {},
    onModelChange() {},
    isStreaming: true,
    onPlanModeChange: (enabled: boolean) => selections.push(enabled),
  };
  const { rerender } = render(React.createElement(ChatInput, { ...props, planEnabled: false }));
  assert.equal(screen.queryByRole("button", { name: "Build mode. Switch to Plan" }), null);
  fireEvent.click(screen.getByRole("button", { name: /Change model/ }));
  fireEvent.click(screen.getByRole("button", { name: "Build mode. Switch to Plan" }));
  rerender(React.createElement(ChatInput, { ...props, planEnabled: true }));
  fireEvent.click(screen.getByRole("button", { name: "Plan mode. Switch to Build" }));
  assert.deepEqual(selections, [true, false]);
  rerender(React.createElement(ChatInput, { ...props, planEnabled: true, planCommandPending: true }));
  const pending = screen.getByRole("button", { name: "Plan mode. Switch to Build" }) as HTMLButtonElement;
  assert.equal(pending.disabled, true);
  fireEvent.click(pending);
  assert.deepEqual(selections, [true, false]);
});
