import "../tests/setup-dom.ts";
import { test, expect } from "bun:test";
import React from "react";
import { SubagentTranscriptDialog } from "./SubagentTranscriptDialog";
import type { SubagentInfo } from "@/lib/subagent-types";

// Testing Library must bind to the document installed by setup-dom first.
const { render, screen, fireEvent, waitFor, cleanup } =
  await import("@testing-library/react/pure.js");

test("keeps the dialog and transcript stable during live refreshes", async () => {
  const originalFetch = globalThis.fetch;
  let completionRequests = 0;
  const refresh = Promise.withResolvers<Response>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("mode=completion")) {
      completionRequests++;
      if (completionRequests === 2) return await refresh.promise;
      return Response.json({ completion: "Finished output", truncated: false });
    }
    const from = Number(
      new URL(url, "https://omp.test").searchParams.get("fromByte"),
    );
    return Response.json({
      messages: [
        { role: "user", content: from ? "Second message" : "First message" },
      ],
      fromByte: from,
      nextByte: from + 1,
      totalBytes: from + 1,
    });
  }) as typeof fetch;
  const agent: SubagentInfo = {
    id: "Agent",
    agent: "task",
    index: 0,
    status: "started",
    source: "history",
  };
  const props = {
    subagent: agent,
    sessionId: "session",
    transcriptVersion: 0,
    onClose: () => {},
  };
  try {
    const view = render(React.createElement(SubagentTranscriptDialog, props));
    await screen.findByText("Finished output");
    const dialog = screen.getByRole("dialog");
    const toggle = screen.getByRole("button", { name: /show transcript/i });
    view.rerender(
      React.createElement(SubagentTranscriptDialog, {
        ...props,
        transcriptVersion: 1,
      }),
    );
    await waitFor(() => expect(completionRequests).toBe(2), { timeout: 3000 });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/loading/i)).toBeNull();
    refresh.resolve(
      Response.json({ completion: "Finished output", truncated: false }),
    );
    fireEvent.click(toggle);
    await screen.findByText("First message");
    view.rerender(
      React.createElement(SubagentTranscriptDialog, {
        ...props,
        transcriptVersion: 2,
      }),
    );
    await screen.findByText("Second message", {}, { timeout: 3000 });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    view.rerender(
      React.createElement(SubagentTranscriptDialog, {
        ...props,
        subagent: { ...agent, source: "live" },
        transcriptVersion: 2,
      }),
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Second message")).toBeTruthy();
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});
