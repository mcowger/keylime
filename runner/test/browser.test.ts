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
      mimeType: "image/jpeg", data: "anBlZw==", width: 1920, height: 1080,
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

it("dispatches each control action only to its exact session-owned target", async () => {
  const tabs = getTabsMapForTest();
  const name = "keylime-test-control";
  const calls: { method: string; params: unknown }[] = [];
  let detached = 0;
  const cdp = {
    async send(method: string, params?: unknown) {
      calls.push({ method, params });
      if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [{ id: 11 }, { id: 12 }, { id: 13 }] };
      return {};
    },
    async detach() { detached++; },
  };
  const target = { _targetId: "control-target", async createCDPSession() { return cdp; } };
  const ctx = { session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession, send() {} } satisfies CommandContext;
  try {
    tabs.set(name, {
      name, targetId: "control-target", ownerSessionId: "owner", backend: "worker", state: "alive",
      kindTag: "headless", info: { title: "", url: "https://example.test" },
      browser: { browser: { targets: () => [target] } },
    } as unknown as TabSession);
    const actions = [
      { type: "navigate", url: "https://example.test/path" },
      { type: "back" }, { type: "forward" }, { type: "reload" },
      { type: "pointer", event: "down", x: 32, y: 48, button: "left", buttons: 1, clickCount: 1, modifiers: 8 },
      { type: "pointer", event: "up", x: 32, y: 48, button: "left", buttons: 0, clickCount: 1, modifiers: 0 },
      { type: "pointer", event: "move", x: 33, y: 49, button: "none", buttons: 0, clickCount: 0, modifiers: 0 },
      { type: "wheel", x: 20, y: 30, deltaX: -2, deltaY: 100, modifiers: 1 },
      { type: "key", event: "down", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, repeat: false },
      { type: "key", event: "up", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, repeat: false },
      { type: "text", text: "héllo" },
      { type: "touch", event: "start", points: [{ id: 1, x: 10, y: 20 }], modifiers: 0 },
      { type: "touch", event: "end", points: [], modifiers: 0 },
    ];
    expect(await browserCommands.browser_control(ctx, { id: "control-target", actions })).toEqual({});
    expect(calls).toEqual([
      { method: "Page.navigate", params: { url: "https://example.test/path" } },
      { method: "Page.getNavigationHistory", params: undefined },
      { method: "Page.navigateToHistoryEntry", params: { entryId: 11 } },
      { method: "Page.getNavigationHistory", params: undefined },
      { method: "Page.navigateToHistoryEntry", params: { entryId: 13 } },
      { method: "Page.reload", params: undefined },
      { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 32, y: 48, button: "left", buttons: 1, clickCount: 1, modifiers: 8 } },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 32, y: 48, button: "left", buttons: 0, clickCount: 1, modifiers: 0 } },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 33, y: 49, button: "none", buttons: 0, clickCount: 0, modifiers: 0 } },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 20, y: 30, deltaX: -2, deltaY: 100, modifiers: 1 } },
      { method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, autoRepeat: false } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, autoRepeat: false } },
      { method: "Input.insertText", params: { text: "héllo" } },
      { method: "Input.dispatchTouchEvent", params: { type: "touchStart", touchPoints: [{ id: 1, x: 10, y: 20 }], modifiers: 0 } },
      { method: "Input.dispatchTouchEvent", params: { type: "touchEnd", touchPoints: [], modifiers: 0 } },
    ]);
    expect(detached).toBe(1);
  } finally {
    tabs.delete(name);
  }
});

it("dispatches a typing batch in order over one CDP session", async () => {
  const tabs = getTabsMapForTest();
  const name = "keylime-test-typing-batch";
  const calls: { method: string; params: unknown }[] = [];
  let attachments = 0;
  const ctx = { session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession, send() {} } satisfies CommandContext;
  try {
    tabs.set(name, {
      name, targetId: name, ownerSessionId: "owner", backend: "worker", state: "alive",
      kindTag: "headless", info: { title: "", url: "https://example.test" },
      browser: { browser: { targets: () => [{ _targetId: name, async createCDPSession() {
        attachments++;
        return { async send(method: string, params: unknown) { calls.push({ method, params }); }, async detach() {} };
      } }] } },
    } as unknown as TabSession);
    await browserCommands.browser_control(ctx, { id: name, actions: [
      { type: "key", event: "down", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, repeat: false },
      { type: "text", text: "a" },
      { type: "key", event: "up", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, repeat: false },
    ] });
    expect(attachments).toBe(1);
    expect(calls).toEqual([
      { method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, autoRepeat: false } },
      { method: "Input.insertText", params: { text: "a" } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0, autoRepeat: false } },
    ]);
  } finally { tabs.delete(name); }
});

it("stops a batch when ownership changes or an action fails", async () => {
  const tabs = getTabsMapForTest();
  const name = "keylime-test-batch-interruption";
  const calls: string[] = [];
  let failure = false;
  let detached = 0;
  const tab = {
    name, targetId: name, ownerSessionId: "owner", backend: "worker", state: "alive",
    kindTag: "headless", info: { title: "", url: "https://example.test" },
    browser: { browser: { targets: () => [{ _targetId: name, async createCDPSession() {
      return { async send(method: string) {
        calls.push(method);
        if (failure) throw new Error("dispatch failed");
        tab.ownerSessionId = "other";
      }, async detach() { detached++; } };
    } }] } },
  } as unknown as TabSession;
  const ctx = { session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession, send() {} } satisfies CommandContext;
  const args = { id: name, actions: [{ type: "reload" }, { type: "text", text: "suffix" }] };
  try {
    tabs.set(name, tab);
    await expect(browserCommands.browser_control(ctx, args)).rejects.toThrow("Browser tab not found");
    expect(calls).toEqual(["Page.reload"]);
    tab.ownerSessionId = "owner";
    failure = true;
    calls.length = 0;
    await expect(browserCommands.browser_control(ctx, args)).rejects.toThrow("dispatch failed");
    expect(calls).toEqual(["Page.reload"]);
    expect(detached).toBe(2);
  } finally { tabs.delete(name); }
});

it("rejects malformed or unauthorized control actions without dispatching input", async () => {
  const tabs = getTabsMapForTest();
  const name = "keylime-test-control-guard";
  let attachments = 0;
  const ctx = { session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession, send() {} } satisfies CommandContext;
  try {
    tabs.set(name, {
      name, targetId: "guard-target", ownerSessionId: "owner", backend: "worker", state: "alive",
      kindTag: "headless", info: { title: "", url: "https://example.test" },
      browser: { browser: { targets: () => [{ _targetId: "guard-target", async createCDPSession() { attachments++; } }] } },
    } as unknown as TabSession);
    const invalid = [
      { type: "navigate", url: "file:///etc/passwd" },
      { type: "navigate", url: "not a url" },
      { type: "pointer", event: "down", x: -1, y: 1, button: "left", clickCount: 1, modifiers: 0 },
      { type: "pointer", event: "down", x: NaN, y: 1, button: "left", clickCount: 1, modifiers: 0 },
      { type: "key", event: "down", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 16, repeat: false },
      { type: "text", text: "x".repeat(65537) },
      { type: "reload", unexpected: true },
      { type: "unknown" },
    ];
    for (const action of invalid)
      await expect(browserCommands.browser_control(ctx, { id: "guard-target", actions: [{ type: "reload" }, action] })).rejects.toThrow();
    await expect(browserCommands.browser_control(ctx, { id: "guard-target", actions: [] })).rejects.toThrow();
    await expect(browserCommands.browser_control(ctx, { id: "wrong-target", actions: [{ type: "reload" }] })).rejects.toThrow("Browser tab not found");
    const tab = tabs.get(name)!;
    tab.ownerSessionId = "other";
    await expect(browserCommands.browser_control(ctx, { id: "guard-target", actions: [{ type: "reload" }] })).rejects.toThrow("Browser tab not found");
    expect(attachments).toBe(0);
  } finally {
    tabs.delete(name);
  }
});

it("does not dispatch control after ownership changes during attachment", async () => {
  const tabs = getTabsMapForTest();
  const name = "keylime-test-control-changed-owner";
  const attached = Promise.withResolvers<unknown>();
  let dispatched = false;
  let detached = false;
  const tab = {
    name, targetId: "changing-control", ownerSessionId: "owner", backend: "worker", state: "alive",
    kindTag: "headless", info: { title: "", url: "https://example.test" },
    browser: { browser: { targets: () => [{ _targetId: "changing-control", createCDPSession: () => attached.promise }] } },
  } as unknown as TabSession;
  const ctx = { session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession, send() {} } satisfies CommandContext;
  try {
    tabs.set(name, tab);
    const control = browserCommands.browser_control(ctx, { id: "changing-control", actions: [{ type: "reload" }] });
    tab.ownerSessionId = "other";
    attached.resolve({ send: async () => { dispatched = true; }, detach: async () => { detached = true; } });
    await expect(control).rejects.toThrow("Browser tab not found");
    expect(dispatched).toBe(false);
    expect(detached).toBe(true);
  } finally {
    tabs.delete(name);
  }
});

it("does not navigate history when ownership changes while reading it", async () => {
  const tabs = getTabsMapForTest();
  const name = "keylime-test-control-history-owner";
  const history = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  const calls: string[] = [];
  let detached = false;
  const tab = {
    name, targetId: "history-control", ownerSessionId: "owner", backend: "worker", state: "alive",
    kindTag: "headless", info: { title: "", url: "https://example.test" },
    browser: { browser: { targets: () => [{
      _targetId: "history-control",
      async createCDPSession() {
        return { send: async (method: string) => { calls.push(method); started.resolve(); return history.promise; }, detach: async () => { detached = true; } };
      },
    }] } },
  } as unknown as TabSession;
  const ctx = { session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession, send() {} } satisfies CommandContext;
  try {
    tabs.set(name, tab);
    const control = browserCommands.browser_control(ctx, { id: "history-control", actions: [{ type: "back" }] });
    await started.promise;
    tab.ownerSessionId = "other";
    history.resolve({ currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] });
    await expect(control).rejects.toThrow("Browser tab not found");
    expect(calls).toEqual(["Page.getNavigationHistory"]);
    expect(detached).toBe(true);
  } finally {
    tabs.delete(name);
  }
});

it("times out a stalled attachment and detaches it if it arrives late", async () => {
  const tabs = getTabsMapForTest();
  const name = "keylime-test-control-timeout";
  const attached = Promise.withResolvers<unknown>();
  let dispatched = false;
  let detached = false;
  const ctx = { session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession, send() {} } satisfies CommandContext;
  try {
    tabs.set(name, {
      name, targetId: "timeout-control", ownerSessionId: "owner", backend: "worker", state: "alive",
      kindTag: "headless", info: { title: "", url: "https://example.test" },
      browser: { browser: { targets: () => [{ _targetId: "timeout-control", createCDPSession: () => attached.promise }] } },
    } as unknown as TabSession);
    await expect(browserCommands.browser_control(ctx, { id: "timeout-control", actions: [{ type: "reload" }] })).rejects.toThrow("Browser control timed out");
    attached.resolve({ send: async () => { dispatched = true; }, detach: async () => { detached = true; } });
    await Promise.resolve();
    expect(dispatched).toBe(false);
    expect(detached).toBe(true);
  } finally {
    tabs.delete(name);
  }
}, 8000);

it("rejects video requests for tabs and streams not owned by the session", async () => {
  const tabs = getTabsMapForTest();
  const name = "keylime-test-video-other-owner";
  const ctx = { session: { getEvalKernelOwnerId: () => "owner" } as unknown as AgentSession, send() {} } satisfies CommandContext;
  try {
    tabs.set(name, {
      name, targetId: "other-video", ownerSessionId: "other", backend: "worker", state: "alive",
      kindTag: "headless", info: { title: "", url: "https://example.test" },
      browser: { browser: { connected: false } },
    } as unknown as TabSession);
    await expect(browserCommands.browser_video_start(ctx, { id: "other-video" })).rejects.toThrow("Browser tab not found");
    await expect(browserCommands.browser_video_start(ctx, { id: "" })).rejects.toThrow("Invalid browser video arguments");
    await expect(browserCommands.browser_video_next(ctx, { id: "other-video", streamId: "missing" })).rejects.toThrow("Browser video stream not found");
    await expect(browserCommands.browser_video_stop(ctx, { id: "other-video", streamId: "missing" })).rejects.toThrow("Browser video stream not found");
  } finally {
    tabs.delete(name);
  }
});
