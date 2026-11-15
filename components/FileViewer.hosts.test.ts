import assert from "node:assert/strict";
import "../tests/setup-dom.ts";
import React from "react";
import test, { afterEach } from "node:test";
// DOM and browser fakes must exist before importing Testing Library and the component.
const { render, cleanup, waitFor } =
  await import("@testing-library/react/pure.js");
const { FileViewer } = await import("./FileViewer");
const originalFetch = globalThis.fetch;
const originalWorker = globalThis.Worker;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.Worker = originalWorker;
  Object.assign(window, { matchMedia: undefined });
});
function browser() {
  globalThis.Worker = class {
    onmessage = null;
    onerror = null;
    postMessage() {}
  } as unknown as typeof Worker;
  window.matchMedia = (media) => ({
    media,
    matches: false,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  });
}
const props = (hostId: string) => ({
  filePath: "/same/report.txt",
  cwd: "/same",
  hostId,
});

test("a file viewer renders bytes from its owning host", async () => {
  browser();
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    if (String(url).startsWith("/api/git/"))
      return Response.json({ supported: false });
    const host = new URL(String(url), "http://localhost").searchParams.get(
      "hostId",
    );
    return Response.json({
      content: host === "host-a" ? "Alpha document" : "Wrong machine",
      language: "text",
      size: 14,
    });
  }) as typeof fetch;
  const view = render(React.createElement(FileViewer, props("host-a")));
  await waitFor(() =>
    assert.ok(view.container.textContent?.includes("Alpha document")),
  );
});

test("an older read cannot replace the same path after its host changes", async () => {
  browser();
  let releaseAlpha!: () => void;
  let started!: () => void;
  const alphaStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    if (String(url).startsWith("/api/git/"))
      return Response.json({ supported: false });
    const host = new URL(String(url), "http://localhost").searchParams.get(
      "hostId",
    );
    if (host === "host-b")
      return Response.json({
        content: "Beta document",
        language: "text",
        size: 13,
      });
    started();
    return new Promise<Response>((resolve) => {
      releaseAlpha = () =>
        resolve(
          Response.json({ content: "Late alpha", language: "text", size: 10 }),
        );
    });
  }) as typeof fetch;
  const view = render(React.createElement(FileViewer, props("host-a")));
  await alphaStarted;
  view.rerender(React.createElement(FileViewer, props("host-b")));
  await waitFor(() =>
    assert.ok(view.container.textContent?.includes("Beta document")),
  );
  releaseAlpha();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(view.container.textContent?.includes("Beta document"));
  assert.ok(!view.container.textContent?.includes("Late alpha"));
});
