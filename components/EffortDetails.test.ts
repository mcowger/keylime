import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import type { EffortRecord } from "@/lib/api-contracts/systems";
import { EffortDetails } from "./EffortDetails";

const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react/pure.js");

test("a failed Effort can dismiss stale output without stopping the replacement", async () => {
  const exited: EffortRecord["services"][number] = {
    id: "build",
    name: "Build log",
    command: "echo done",
    terminalId: "exited-terminal",
    status: "exited",
  };
  const effort: EffortRecord = {
    id: "effort",
    systemId: "system",
    systemName: "Example",
    name: "Failed setup",
    root: "/efforts/example/failed-setup",
    branch: "example/failed-setup",
    slug: "failed-setup",
    status: "failed",
    members: [],
    services: [exited],
    sessionIds: [],
  };
  const replacement: EffortRecord = {
    ...effort,
    services: [
      { ...exited, status: "running", terminalId: "replacement-terminal" },
    ],
  };
  const initialFetch = globalThis.fetch;
  const deletes: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(init?.method, "DELETE");
      deletes.push(String(input));
      return Response.json({ code: "terminal_not_found" }, { status: 404 });
    },
    { preconnect: initialFetch.preconnect },
  );

  function Dialog() {
    const [current, setCurrent] = React.useState(effort);
    return React.createElement(EffortDetails, {
      host: "linked-host",
      effort: current,
      async action(input) {
        assert.equal(input.action, "list");
        setCurrent(replacement);
        return { root: "/efforts", systems: [], efforts: [replacement] };
      },
      onClose() {},
      onOpenWorkspace() {},
      onNewChat() {},
      onOpenSession() {},
      onOpenTerminal() {},
    });
  }

  try {
    render(React.createElement(Dialog));
    assert.equal(screen.getByRole("status").textContent, "Setup failed");
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss output for Build log" }),
    );
    await waitFor(() => {
      const services = screen.getByRole("region", { name: "Effort services" });
      assert.match(services.textContent ?? "", /Build log · running/);
      assert.equal(
        screen.queryByRole("button", { name: "Dismiss output for Build log" }),
        null,
      );
    });
    assert.deepEqual(deletes, [
      "/api/terminals/exited-terminal?hostId=linked-host",
    ]);
    assert.equal(screen.queryByRole("alert"), null);
  } finally {
    cleanup();
    globalThis.fetch = initialFetch;
  }
});
