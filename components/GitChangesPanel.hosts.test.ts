import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React, { act } from "react";
import test, { afterEach } from "node:test";
const { render, cleanup, waitFor } =
  await import("@testing-library/react/pure.js");
const { GitChangesPanel } = await import("./GitChangesPanel");
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("same-path Git patches follow their host and ignore a late prior-owner patch", async () => {
  let releaseAlpha!: () => void;
  const patch = (label: string) => ({
    supported: true,
    status: "modified",
    patch: `diff --git a/report.txt b/report.txt\n--- a/report.txt\n+++ b/report.txt\n@@ -1 +1 @@\n-old\n+${label}\n`,
  });
  type Patch = { supported: boolean; status: string; patch: string };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const host = url.searchParams.get("hostId");
      if (url.pathname.endsWith("/status"))
        return Response.json({
          isGitRepository: true,
          repositoryRoot: "/same",
          files: [
            {
              filePath: "/same/report.txt",
              status: "modified",
              code: "M",
              indexStatus: " ",
              worktreeStatus: "M",
            },
          ],
        });
      if (host === "beta") return Response.json(patch("Beta patch bytes"));
      const { promise, resolve } = Promise.withResolvers<Patch>();
      releaseAlpha = () => resolve(patch("Late alpha bytes"));
      return Object.assign(new Response(), { json: () => promise });
    },
    { preconnect: originalFetch.preconnect },
  );
  const props = { cwd: "/same", hostId: "alpha", onOpenFile() {} };
  const view = render(React.createElement(GitChangesPanel, props));
  await waitFor(() => assert.equal(typeof releaseAlpha, "function"));
  view.rerender(
    React.createElement(GitChangesPanel, { ...props, hostId: "beta" }),
  );
  await waitFor(() =>
    assert.ok(view.container.textContent!.includes("Beta patch bytes")),
  );
  await act(async () => {
    releaseAlpha();
  });
  assert.ok(view.container.textContent!.includes("Beta patch bytes"));
  assert.equal(view.container.textContent!.includes("Late alpha bytes"), false);
});
