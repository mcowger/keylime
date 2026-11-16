import { expect, it } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  getTabsMapForTest,
  type TabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { browserCommands } from "../src/commands/browser";
import type { CommandContext } from "../src/commands/types";

it("lists only live Chromium tabs owned by the session and captures only the exact owned target", async () => {
  const tabs = getTabsMapForTest();
  const names = ["keylime-test-owned", "keylime-test-other", "keylime-test-unowned", "keylime-test-webkit", "keylime-test-dead"];
  const calls: string[] = [];
  let clip: unknown;
  let detached = false;
  const cdp = {
    async send(method: string, params?: { clip?: unknown }) {
      calls.push(method);
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { pageX: 45, pageY: 900, clientWidth: 1920, clientHeight: 1080 } };
      if (method === "Page.captureScreenshot") {
        clip = params?.clip;
        return { data: "anBlZw==" };
      }
      return {};
    },
    async detach() { detached = true; },
  };
  const target = {
    _targetId: "owned-target",
    async createCDPSession() { calls.push("attach-owned"); return cdp; },
  };
  const wrongTarget = {
    _targetId: "wrong-target",
    async createCDPSession() { calls.push("attach-wrong"); return cdp; },
  };
  function add(name: string, targetId: string, ownerSessionId: string | undefined, backend: string, state = "alive") {
    tabs.set(name, {
      name, targetId, ownerSessionId, backend, state,
      kindTag: backend === "worker" ? "headless" : "webkit",
      info: { title: name, url: `https://example.test/${name}` },
      browser: { browser: { targets: () => [wrongTarget, target] } },
    } as unknown as TabSession);
  }
  const ctx = {
    session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession,
    send() {},
  } satisfies CommandContext;
  try {
    add(names[0], "owned-target", "owner", "worker");
    add(names[1], "other-target", "other", "worker");
    add(names[2], "unowned-target", undefined, "worker");
    add(names[3], "webkit-target", "owner", "webkit");
    add(names[4], "dead-target", "owner", "worker", "dead");

    expect(await browserCommands.browser_list(ctx, {})).toEqual({
      tabs: [{ id: "owned-target", title: names[0], url: `https://example.test/${names[0]}` }],
    });
    for (const id of ["other-target", "unowned-target", "webkit-target", "dead-target", "wrong-target", "missing"]) {
      await expect(browserCommands.browser_capture(ctx, { id })).rejects.toThrow("Browser tab not found");
    }
    expect(calls).toEqual([]);
    expect(await browserCommands.browser_capture(ctx, { id: "owned-target" })).toEqual({
      mimeType: "image/jpeg", data: "anBlZw==",
    });
    expect(calls).toEqual(["attach-owned", "Page.startScreencast", "Page.getLayoutMetrics", "Page.captureScreenshot"]);
    expect(clip).toEqual({ x: 45, y: 900, width: 1920, height: 1080, scale: 2 / 3 });
    expect(detached).toBe(true);
  } finally {
    for (const name of names) tabs.delete(name);
  }
});

it("rejects capture if ownership changes while attaching", async () => {
  const tabs = getTabsMapForTest();
  const name = "keylime-test-changed-owner";
  const attached = Promise.withResolvers<unknown>();
  let detached = false;
  const tab = {
    name, targetId: "changing-target", ownerSessionId: "owner", backend: "worker", state: "alive",
    kindTag: "headless", info: { title: "", url: "https://example.test" },
    browser: { browser: { targets: () => [{ _targetId: "changing-target", createCDPSession: () => attached.promise }] } },
  } as unknown as TabSession;
  const ctx = {
    session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession,
    send() {},
  } satisfies CommandContext;
  try {
    tabs.set(name, tab);
    const capture = browserCommands.browser_capture(ctx, { id: "changing-target" });
    tab.ownerSessionId = "other";
    attached.resolve({ detach: async () => { detached = true; } });
    await expect(capture).rejects.toThrow("Browser tab not found");
    expect(detached).toBe(true);
  } finally {
    tabs.delete(name);
  }
});
