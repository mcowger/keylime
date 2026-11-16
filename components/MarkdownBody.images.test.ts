import assert from "node:assert/strict";
import "../tests/setup-dom.ts";
import React from "react";
import { MarkdownBody } from "./MarkdownBody";
import test, { afterEach } from "node:test";

// Testing Library must load after setup-dom installs the browser globals.
const { render, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react/pure.js");
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("shows the resolved local path when the file API denies access", async () => {
  let requested = "";
  let credentials: RequestCredentials | undefined;
  globalThis.fetch = (async (url, init) => {
    requested = String(url);
    credentials = init?.credentials;
    return Response.json({ code: "access_denied" }, { status: 403 });
  }) as typeof fetch;
  const view = render(React.createElement(MarkdownBody, { cwd: "/repo", sourceSessionId: "session-1", children: "![shot](./screens/shot.png)" }));
  fireEvent.error(view.getByAltText("shot"));
  await waitFor(() => assert.ok(view.getByText("Image blocked: /repo/screens/shot.png")));
  assert.ok(requested.startsWith("/api/files/repo/screens/shot.png?"));
  assert.ok(requested.includes("sessionId=session-1"));
  assert.equal(credentials, "same-origin");
});

test("does not call missing, authentication, network, or decode errors blocked", async () => {
  for (const response of [
    () => Response.json({ code: "file_not_found" }, { status: 404 }),
    () => Response.json({ code: "unauthorized" }, { status: 403 }),
    () => new Response("image", { status: 200 }),
    () => { throw new Error("network"); },
  ]) {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
    const view = render(React.createElement(MarkdownBody, { cwd: "/repo", children: "![shot](./shot.png)" }));
    fireEvent.error(view.getByAltText("shot"));
    await waitFor(() => assert.ok(view.getByText("Image unavailable: /repo/shot.png")));
    assert.equal(view.queryByText(/Image blocked/), null);
    view.unmount();
  }
});

test("does not inspect external image failures with fetch", () => {
  let fetched = false;
  globalThis.fetch = (async () => { fetched = true; throw new Error("unexpected fetch"); }) as unknown as typeof fetch;
  const view = render(React.createElement(MarkdownBody, { cwd: "/repo", children: "![external](https://example.com/image.png)" }));
  fireEvent.error(view.getByAltText("external"));
  assert.equal(fetched, false);
  assert.equal(view.queryByText(/Image blocked/), null);
});
