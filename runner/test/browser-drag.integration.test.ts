import { expect, it } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { closeLaunchedBrowser, launchHeadlessBrowser, removeUserDataDir } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { getTabsMapForTest, type TabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { browserCommands } from "../src/commands/browser";
import type { CommandContext } from "../src/commands/types";

// Opt in explicitly: this launches Chromium and may download it on a new machine.
it.skipIf(process.env.KEYLIME_TEST_BROWSER !== "1")("dragging selects text in a real session-owned Chromium page", async () => {
  const launched = await launchHeadlessBrowser({ headless: true, viewport: { width: 800, height: 600 } });
  const tabs = getTabsMapForTest();
  const name = "keylime-drag-integration";
  try {
    const page = await launched.browser.newPage();
    await page.setContent('<input id="text" value="abcdefghijklmnopqrstuvwxyz" style="position:absolute;left:20px;top:20px;width:500px;font:24px monospace">');
    const target = page.target();
    if (!("_targetId" in target) || typeof target._targetId !== "string") throw new Error("Chromium target id unavailable");
    const id = target._targetId;
    tabs.set(name, {
      name, targetId: id, ownerSessionId: "owner", backend: "worker", state: "alive",
      kindTag: "headless", info: { title: "", url: "about:blank" },
      browser: { browser: launched.browser },
    } as unknown as TabSession);
    const ctx = { session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession, send() {} } satisfies CommandContext;
    await browserCommands.browser_control(ctx, { id, actions: [
      { type: "pointer", event: "down", x: 30, y: 35, button: "left", buttons: 1, clickCount: 1, modifiers: 0 },
      { type: "pointer", event: "move", x: 180, y: 35, button: "none", buttons: 1, clickCount: 0, modifiers: 0 },
      { type: "pointer", event: "up", x: 180, y: 35, button: "left", buttons: 0, clickCount: 1, modifiers: 0 },
    ] });
    const selection = await page.$eval("#text", (element) => {
      const input = element as HTMLInputElement;
      return { start: input.selectionStart, end: input.selectionEnd };
    });
    expect(selection.start).not.toBeNull();
    expect(selection.end! - selection.start!).toBeGreaterThan(1);
  } finally {
    tabs.delete(name);
    await closeLaunchedBrowser(launched.browser);
    if (launched.userDataDir) await removeUserDataDir(launched.userDataDir);
  }
}, 60_000);
