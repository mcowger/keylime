import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { WorkspaceBrowser } from "./WorkspaceBrowser";

// Load the testing library after the DOM test environment is installed.
const { render, cleanup } = await import("@testing-library/react/pure.js");

test("browser frames are requested only while selected and visible", async (t) => {
  const originalFetch = globalThis.fetch;
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  let hidden = false;
  const requests: Array<{ url: string; signal: AbortSignal }> = [];
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    requests.push({ url: String(input), signal });
    const { promise, reject } = Promise.withResolvers<Response>();
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    return promise;
  }) as typeof fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else Reflect.deleteProperty(document, "hidden");
  });

  const pages = [{ id: "page 1", title: "Page", url: "https://example.com" }];
  const view = render(<WorkspaceBrowser sessionId="session 1" pages={pages} active={false} />);
  assert.equal(requests.length, 0);

  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active />));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/sessions/session%201/browser/frame?tabId=page+1");
  assert.equal(requests[0].signal.aborted, false);

  await act(async () => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests.length, 1);

  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active={false} />));
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(requests.length, 1);

  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active />));
  assert.equal(requests.length, 2);
  await act(async () => view.rerender(<WorkspaceBrowser sessionId="session 1" pages={pages} active={false} />));
  assert.equal(requests[1].signal.aborted, true);
});
