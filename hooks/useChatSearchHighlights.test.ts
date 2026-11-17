import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { SessionContext } from "../lib/types";
import { useChatSearchHighlights } from "./useChatSearchHighlights";
import { createSessionCatchUp } from "./useAgentSession-sync";

// DOM setup must run before the React test library and hooks are loaded.
const { cleanup, renderHook } = await import("@testing-library/react/pure.js");

afterEach(cleanup);

test("an older search target waits for delayed backfill before jumping", async (t) => {
  const context = (ids: string[]): SessionContext => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  const page = Promise.withResolvers<Response>();
  t.mock.method(globalThis, "fetch", () => page.promise);
  let displayed = context([]);
  let complete = false;
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "scope",
    history(next, _leaf, _metadata, ready) { displayed = next; complete = ready === true; },
    live() {}, subscribe: () => false,
  });
  catchUp.seed(context(["new"]), null, false);
  const completed = Promise.withResolvers<void>();
  catchUp.backfill("rev", completed.resolve);
  const container = document.createElement("div");
  const message = document.createElement("div");
  message.setAttribute("data-message-text", "");
  message.setAttribute("data-entry-id", "old");
  let jumped = 0;
  message.scrollIntoView = () => { jumped++; };
  container.append(message);
  const css = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", { configurable: true, value: { escape: (id: string) => id } });
  t.after(() => css ? Object.defineProperty(globalThis, "CSS", css) : Reflect.deleteProperty(globalThis, "CSS"));
  const nodeFilter = Object.getOwnPropertyDescriptor(globalThis, "NodeFilter");
  Object.defineProperty(globalThis, "NodeFilter", { configurable: true, value: window.NodeFilter });
  t.after(() => nodeFilter ? Object.defineProperty(globalThis, "NodeFilter", nodeFilter) : Reflect.deleteProperty(globalThis, "NodeFilter"));
  let handled = 0;
  const target = { sessionId: "s1", entryId: "old", ordinal: 0 };
  const props = () => ({
    container: { current: container }, query: "needle", target,
    ready: complete, navigationKey: "s1:default", sessionId: "s1", entryIds: displayed.entryIds,
    revealMessage: () => true, holdScrollPosition: () => {},
    onTargetHandled: () => { handled++; },
  });
  const view = renderHook(() => useChatSearchHighlights(props()));
  assert.equal(handled, 0);
  assert.equal(jumped, 0);
  page.resolve(Response.json({ context: context(["old"]), historyHasMore: false, historyRevision: "rev" }));
  await completed.promise;
  view.rerender();
  assert.equal(handled, 1);
  assert.equal(jumped, 1);
});

test("a pending target cannot jump after the selected branch changes", () => {
  const target = { sessionId: "s1", entryId: "old", ordinal: 0 };
  const container = document.createElement("div");
  let handled = 0;
  let revealed = 0;
  let key = "s1:default";
  let ready = false;
  const view = renderHook(() => useChatSearchHighlights({
    container: { current: container }, query: "needle", target, ready,
    navigationKey: key, sessionId: "s1", entryIds: ["old"],
    revealMessage: () => { revealed++; return true; },
    holdScrollPosition: () => {}, onTargetHandled: () => { handled++; },
  }));
  key = "s1:branch";
  ready = true;
  view.rerender();
  assert.equal(handled, 1);
  assert.equal(revealed, 0);
});
