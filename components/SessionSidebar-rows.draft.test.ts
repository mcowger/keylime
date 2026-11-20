import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { stageTestUpload } from "../tests/staged-upload-fixture";
import React from "react";
import type { ChatInputHandle } from "./ChatInput";
import { sessionKey } from "@/lib/session-identity";
const { act, cleanup, render, screen, waitFor } =
  await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { ChatInput } = await import("./ChatInput");
// Same specifiers as the component's own imports, so both see one draft store.
const { SessionItem } = await import("@/components/SessionSidebar-rows");
const { clearDraft, setDraft } = await import("@/lib/draft-store");

const session = (id: string) => ({
  id,
  name: id,
  firstMessage: "",
  cwd: "/w",
  path: "",
  created: new Date().toISOString(),
  messageCount: 0,
  modified: new Date().toISOString(),
});
const row = (id: string) =>
  React.createElement(SessionItem, {
    session: session(id),
    isSelected: false,
    onClick() {},
    relativeTimeNow: Date.now(),
  });
const mark = () => screen.queryByRole("img", { name: "Unsent draft" });

test("a session row marks unsent composer content and drops the mark once it is gone", () => {
  try {
    // A draft that exists before the row mounts (restored after a reload, a re-expanded project).
    setDraft(sessionKey("draft-a"), {
      value: "half-written",
      images: [],
      files: [],
    });
    const { rerender } = render(row("draft-a"));
    assert.equal(
      mark()?.getAttribute("title"),
      "Unsent draft",
      "marked on first paint, with its tooltip",
    );
    rerender(row("draft-b"));
    assert.equal(mark(), null, "a row follows its own session's draft only");
    act(() =>
      setDraft(sessionKey("draft-b"), {
        value: "",
        images: [],
        files: [],
        uploads: [{ id: "u", name: "a.bin", size: 1, hostId: "local" }],
      }),
    );
    assert.ok(mark(), "an attachment-only draft counts");
    act(() =>
      setDraft(sessionKey("draft-b"), { value: "", images: [], files: [] }),
    );
    assert.equal(
      mark(),
      null,
      "an emptied draft clears the mark, whatever other sessions hold",
    );
  } finally {
    clearDraft(sessionKey("draft-a"));
    clearDraft(sessionKey("draft-b"));
    cleanup();
  }
});

test("a mounted session row follows composer typing, attachment-only drafts and sending", async (t) => {
  const user = userEvent.setup();
  const composer = React.createRef<ChatInputHandle>();
  const sent: { text: string; uploads?: string[] }[] = [];
  const file = new File(["attachment content"], "notes.txt", {
    type: "text/plain",
  });
  const uploadId = stageTestUpload(t, file);
  const previousMatchMedia = window.matchMedia;
  window.matchMedia = globalThis.matchMedia;
  try {
    render(
      React.createElement(
        React.Fragment,
        null,
        row("composer-draft"),
        React.createElement(ChatInput, {
          ref: composer,
          draftKey: sessionKey("composer-draft"),
          isStreaming: false,
          onAbort() {},
          async onSend(text, _images, uploads) {
            sent.push({ text, uploads });
            return { status: "accepted" };
          },
        }),
      ),
    );
    const input = screen.getByRole("textbox");
    assert.equal(mark(), null);
    await user.type(input, "half-written");
    assert.ok(mark(), "typing marks the mounted session row");
    await user.clear(input);
    assert.equal(mark(), null, "clearing the composer clears its mark");
    await act(async () => {
      assert.ok(composer.current);
      composer.current.addFiles([file]);
    });
    await waitFor(() =>
      assert.ok(mark(), "a file without text marks the mounted row"),
    );
    await user.click(input);
    await user.keyboard("{Enter}");
    await waitFor(() => assert.equal(mark(), null, "sending clears the mark"));
    assert.deepEqual(sent, [{ text: "", uploads: [uploadId()] }]);
  } finally {
    cleanup();
    clearDraft(sessionKey("composer-draft"));
    window.matchMedia = previousMatchMedia;
  }
});
