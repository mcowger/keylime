import { expect, test } from "bun:test";
import { closeTerminal, terminalSnapshot } from "./terminal-client";

test("closing an exited terminal succeeds without hiding other failures", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ error: "Terminal not found", code: "terminal_not_found" }, { status: 404 })) as unknown as typeof fetch;
    await expect(closeTerminal("id", "local")).resolves.toBeUndefined();
    await expect(terminalSnapshot("id", "local")).rejects.toThrow("Terminal not found");
    globalThis.fetch = (async () => Response.json({ error: "Host not found", code: "host_not_found" }, { status: 404 })) as unknown as typeof fetch;
    await expect(closeTerminal("id", "local")).rejects.toThrow("Host not found");
    globalThis.fetch = (async () => Response.json({ error: "Host offline", code: "host_offline" }, { status: 503 })) as unknown as typeof fetch;
    await expect(closeTerminal("id", "local")).rejects.toThrow("Host offline");
  } finally {
    globalThis.fetch = original;
  }
});
