import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import type { ChatInputHandle } from "./ChatInput";
const { cleanup, render, screen, waitFor } =
  await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { ChatInput } = await import("./ChatInput");
const { clearDraft, getDraft } = await import("@/lib/draft-store");

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
  // Typing "/" opens the slash menu, which scrolls its active row into view.
  window.HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  clearDraft("btw-draft");
  localStorage.clear();
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(window.HTMLElement.prototype, "scrollIntoView");
});

/** Every way the composer can hand text to the agent, recorded by name. */
function renderComposer(
  props: Pick<
    React.ComponentProps<typeof ChatInput>,
    "isStreaming" | "onBuiltinCommand"
  >,
) {
  const calls: [string, string][] = [];
  const recordSend = async (text: string): Promise<{ status: "accepted" }> => {
    calls.push(["onSend", text]);
    return { status: "accepted" };
  };
  const recordQueue = (name: string) => async (text: string) => {
    calls.push([name, text]);
    return true;
  };
  const ref = React.createRef<ChatInputHandle>();
  render(
    React.createElement(ChatInput, {
      ref,
      draftKey: "btw-draft",
      onAbort() {},
      onSend: recordSend,
      onSteer: recordQueue("onSteer"),
      onFollowUp: recordQueue("onFollowUp"),
      onBuiltinCommand: async (text) => {
        calls.push(["onBuiltinCommand", text]);
        return { handled: true };
      },
      ...props,
    }),
  );
  return { calls, ref };
}

for (const isStreaming of [false, true]) {
  test(`/btw goes to the side-question command, never the agent, ${isStreaming ? "while a run streams" : "when idle"}`, async () => {
    const user = userEvent.setup();
    const { calls } = renderComposer({ isStreaming });
    await user.type(screen.getByRole("textbox"), "/btw what is 2+2");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      assert.deepEqual(calls, [["onBuiltinCommand", "/btw what is 2+2"]]),
    );
    await waitFor(() =>
      assert.equal(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
        "",
      ),
    );
  });
}

for (const behavior of ["queue", "steer"]) {
  test(`/btw offers Send during a run regardless of the ${behavior} preference`, async () => {
    localStorage.setItem("keylime:submit-during-run", behavior);
    const user = userEvent.setup();
    const { calls } = renderComposer({ isStreaming: true });
    await user.type(screen.getByRole("textbox"), "/btw what is 2+2");
    await user.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() =>
      assert.deepEqual(calls, [["onBuiltinCommand", "/btw what is 2+2"]]),
    );
    await waitFor(() =>
      assert.equal(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
        "",
      ),
    );
  });
}

test("without builtin dispatch, /btw during a run keeps the Queue button and queues as ordinary text", async () => {
  localStorage.setItem("keylime:submit-during-run", "queue");
  const user = userEvent.setup();
  const { calls } = renderComposer({
    isStreaming: true,
    onBuiltinCommand: undefined,
  });
  await user.type(screen.getByRole("textbox"), "/btw what is 2+2");
  assert.equal(screen.queryByRole("button", { name: /^Send$/ }), null);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    assert.deepEqual(calls, [["onFollowUp", "/btw what is 2+2"]]),
  );
});

test("/btw with an attachment is refused and keeps the draft and the attachment", async () => {
  const user = userEvent.setup();
  const { calls, ref } = renderComposer({ isStreaming: false });
  await act(async () => {
    assert.ok(ref.current);
    ref.current.addFiles([
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    ]);
  });
  await waitFor(() => assert.equal(getDraft("btw-draft")?.files.length, 1));
  await user.type(screen.getByRole("textbox"), "/btw what is this");
  await user.keyboard("{Enter}");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(calls, []);
  assert.equal(
    (screen.getByRole("textbox") as HTMLTextAreaElement).value,
    "/btw what is this",
  );
  assert.equal(getDraft("btw-draft")?.files.length, 1);
});

test("slash palette keeps /btw available during a streaming run", async () => {
  const user = userEvent.setup();
  renderComposer({ isStreaming: true });
  await user.type(screen.getByRole("textbox"), "/bt");
  await waitFor(() => assert.ok(screen.getByText("/btw")));
});

test("/btw Send button refuses pending uploads immediately with the attachment error", async () => {
  const user = userEvent.setup();
  const { calls, ref } = renderComposer({ isStreaming: true });
  // Attach an uploading file (20 MB exceeds inline text limit -> staged upload).
  await act(async () => {
    assert.ok(ref.current);
    ref.current.addFiles([
      new File([new Uint8Array(6 * 1024 * 1024)], "big.bin", {
        type: "application/octet-stream",
      }),
    ]);
  });
  await user.type(screen.getByRole("textbox"), "/btw what is this");
  const sendBtn = screen.getByRole("button", { name: /^Send$/ });
  assert.equal((sendBtn as HTMLButtonElement).disabled, false);
  await user.click(sendBtn);
  assert.deepEqual(calls, []);
  assert.equal(
    (screen.getByRole("textbox") as HTMLTextAreaElement).value,
    "/btw what is this",
  );
});
