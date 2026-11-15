import assert from "node:assert/strict";
import "../tests/setup-dom.ts";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, waitFor } =
  await import("@testing-library/react/pure.js");

const { FileExplorer } = await import("./FileExplorer");

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("a listing that finishes after the directory changed does not overwrite the current one", async () => {
  let releaseStale!: () => void;
  const stale = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  const file = (name: string) => ({
    name,
    isDir: false,
    size: 0,
    modified: "",
  });
  let wsRequests = 0;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    const href = String(url);
    if (href.startsWith("/api/git/"))
      return Response.json({ isGitRepository: false, files: [] });
    if (href.startsWith("/api/files/ws?")) {
      // The first request is the one the cwd change supersedes.
      if (wsRequests++ === 0) {
        await stale;
        return Response.json({ entries: [file("stale.txt")] });
      }
      return Response.json({ entries: [file("current.txt")] });
    }
    return Response.json({ entries: [] });
  }) as typeof fetch;

  const props = { hostId: "local", onOpenFile() {} };
  const { container, rerender } = render(
    React.createElement(FileExplorer, { ...props, cwd: "/ws" }),
  );
  rerender(React.createElement(FileExplorer, { ...props, cwd: "/other" }));
  rerender(React.createElement(FileExplorer, { ...props, cwd: "/ws" }));
  await waitFor(() =>
    assert.ok(container.querySelector('[data-file-path="/ws/current.txt"]')),
  );

  releaseStale();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    container.querySelector('[data-file-path="/ws/stale.txt"]'),
    null,
  );
  assert.ok(container.querySelector('[data-file-path="/ws/current.txt"]'));
});
