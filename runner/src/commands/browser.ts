import path from "node:path";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { BrowserControlArgsSchema } from "../../../lib/api-contracts/runner-lifecycle";
import {
  getTab,
  listTabs,
  type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { CommandContext, CommandTable } from "./types";
import { launchHeadlessBrowser, closeLaunchedBrowser, type LaunchHeadlessResult } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, releaseBrowser, type BrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { CommandError } from "./types";

const CAPTURE_TIMEOUT_MS = 5_000;
const CONTROL_TIMEOUT_MS = 5_000;
const MAX_IMAGE_BASE64_LENGTH = 1024 * 1024;

function ownedTab(ctx: CommandContext, id: string): WorkerTabSession | undefined {
  const owner = ctx.session.getEvalKernelOwnerId();
  if (!owner) return undefined;
  for (const info of listTabs()) {
    if (info.targetId !== id) continue;
    const tab = getTab(info.name);
    if (tab?.state === "alive" && tab.backend === "worker" &&
        tab.ownerSessionId === owner && tab.targetId === id) return tab;
  }
  return undefined;
}

let fixtureOpening: Promise<void> | undefined;
async function openIsolatedFixture(ctx: CommandContext): Promise<void> {
  const root = process.env.KEYLIME_UI_FIXTURE_ROOT;
  if (process.env.KEYLIME_BROWSER_FIXTURE !== "1" || !root ||
      process.env.HOME !== path.join(root, "home") ||
      process.env.PI_CODING_AGENT_DIR !== path.join(root, "home", ".omp", "agent") ||
      ctx.session.sessionManager.getSessionId() !== "11111111-1111-4111-8111-111111111111" ||
      ctx.session.sessionManager.getCwd() !== realpathSync(path.join(root, "projects", "atlas"))) return;
  if (!fixtureOpening) {
    fixtureOpening = (async () => {
      const owner = ctx.session.getEvalKernelOwnerId();
      if (!owner) throw new Error("Browser fixture session has no owner");
      const cwd = ctx.session.sessionManager.getCwd();
      // Keep the Chromium profile inside the explicitly isolated dev directory.
      const profile = mkdtempSync(path.join(root, "browser-profile-"));
      let launched: LaunchHeadlessResult | undefined;
      let browser: BrowserHandle | undefined;
      try {
        launched = await launchHeadlessBrowser({ headless: true, viewport: { width: 1280, height: 720 }, args: [`--user-data-dir=${profile}`] });
        browser = await acquireBrowser({ kind: "connected", cdpUrl: `http://${new URL(launched.wsEndpoint).host}` }, { cwd });
        if (ctx.session.getEvalKernelOwnerId() !== owner ||
            ctx.session.sessionManager.getSessionId() !== "11111111-1111-4111-8111-111111111111")
          throw new Error("Browser fixture session changed");
        await acquireTab("keylime-dev-fixture", browser, {
          url: pathToFileURL(path.join(cwd, "browser-fixture.html")).href,
          waitUntil: "load", viewport: { width: 1280, height: 720 }, timeoutMs: 30000,
          ownerSessionId: owner, persist: true,
        });
        if (ctx.session.getEvalKernelOwnerId() !== owner ||
            ctx.session.sessionManager.getSessionId() !== "11111111-1111-4111-8111-111111111111")
          throw new Error("Browser fixture session changed");
      } catch (error) {
        await releaseTab("keylime-dev-fixture", { kill: false }).catch(() => {});
        if (browser) await releaseBrowser(browser, { kill: false }).catch(() => {});
        if (launched) await closeLaunchedBrowser(launched.browser).catch(() => {});
        rmSync(profile, { recursive: true, force: true });
        throw error;
      }
    })();
    void fixtureOpening.catch(() => { fixtureOpening = undefined; });
  }
  await fixtureOpening;
}

export const browserCommands: CommandTable = {
  /** @apiCommand browser_list */
  async browser_list(ctx) {
    const owner = ctx.session.getEvalKernelOwnerId();
    if (!owner) return { tabs: [] };
    await openIsolatedFixture(ctx);
    return {
      tabs: listTabs().flatMap((info) => {
        const tab = getTab(info.name);
        return tab?.state === "alive" && tab.backend === "worker" &&
          tab.ownerSessionId === owner && tab.targetId === info.targetId &&
          info.targetId.length > 0 && info.targetId.length <= 1024
          ? [{ id: info.targetId, title: info.title.slice(0, 2048), url: info.url.slice(0, 8192) }]
          : [];
      }).slice(0, 128),
    };
  },

  /** @apiCommand browser_capture */
  async browser_capture(ctx, args) {
    if (typeof args.id !== "string" || !args.id || args.id.length > 1024)
      throw new CommandError("Invalid browser tab id", "invalid_argument");
    const id = args.id;
    const tab = ownedTab(ctx, id);
    if (!tab) throw new CommandError("Browser tab not found", "not_found");
    // OMP's pinned Puppeteer CDP target exposes this ID; never fall back to an
    // active page or create a target when it is unavailable.
    const target = tab.browser.browser.targets().find(
      (item) => "_targetId" in item && item._targetId === id,
    );
    if (!target) throw new CommandError("Browser tab not found", "not_found");

    const signal = AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
    const { promise: timeout, reject } = Promise.withResolvers<never>();
    signal.addEventListener("abort", () => reject(new Error("Browser capture timed out")), { once: true });
    const withinDeadline = <T>(promise: Promise<T>) => Promise.race([promise, timeout]);
    const opening = target.createCDPSession();
    // A timed-out attachment may still complete; detach it without touching the tab.
    void opening.then((session) => {
      if (signal.aborted) void session.detach().catch(() => undefined);
    }, () => undefined);
    const cdp = await withinDeadline(opening);
    try {
      if (ownedTab(ctx, id) !== tab) throw new CommandError("Browser tab not found", "not_found");
      // A temporary screencast keeps background tabs drawing without activating them.
      await withinDeadline(cdp.send("Page.startScreencast", {
        format: "jpeg", quality: 1, maxWidth: 1, maxHeight: 1,
      }).catch(() => undefined));
      const metrics = await withinDeadline(cdp.send("Page.getLayoutMetrics"));
      const viewport = metrics.cssVisualViewport;
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        throw new Error("Browser viewport unavailable");
      const image = await withinDeadline(cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 70,
        captureBeyondViewport: false,
        clip: { x: viewport.pageX, y: viewport.pageY, width, height, scale: Math.min(1, 1280 / width, 720 / height) },
      }));
      if (ownedTab(ctx, id) !== tab) throw new CommandError("Browser tab not found", "not_found");
      if (image.data.length > MAX_IMAGE_BASE64_LENGTH)
        throw new Error("Browser capture exceeds size limit");
      return { mimeType: "image/jpeg", data: image.data, width, height };
    } finally {
      // Detaching also stops the session's screencast; never close the browser or page.
      void cdp.detach().catch(() => undefined);
    }
  },

  /** @apiCommand browser_control */
  async browser_control(ctx, args) {
    if (!Value.Check(BrowserControlArgsSchema, args))
      throw new CommandError("Invalid browser control action", "invalid_argument");
    const { id, action } = args;
    if (action.type === "navigate") {
      let url: URL;
      try { url = new URL(action.url); } catch {
        throw new CommandError("Invalid browser navigation URL", "invalid_argument");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new CommandError("Invalid browser navigation URL", "invalid_argument");
    }
    const tab = ownedTab(ctx, id);
    if (!tab) throw new CommandError("Browser tab not found", "not_found");
    const target = tab.browser.browser.targets().find(
      (item) => "_targetId" in item && item._targetId === id,
    );
    if (!target) throw new CommandError("Browser tab not found", "not_found");

    const signal = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
    const { promise: timeout, reject } = Promise.withResolvers<never>();
    signal.addEventListener("abort", () => reject(new Error("Browser control timed out")), { once: true });
    const withinDeadline = <T>(promise: Promise<T>) => Promise.race([promise, timeout]);
    const opening = target.createCDPSession();
    void opening.then((session) => {
      if (signal.aborted) void session.detach().catch(() => undefined);
    }, () => undefined);
    const cdp = await withinDeadline(opening);
    const assertOwned = () => {
      if (ownedTab(ctx, id) !== tab) throw new CommandError("Browser tab not found", "not_found");
    };
    try {
      assertOwned();
      switch (action.type) {
        case "navigate": {
          const result = await withinDeadline(cdp.send("Page.navigate", { url: action.url }));
          if (result.errorText) throw new Error("Browser navigation failed");
          break;
        }
        case "back":
        case "forward": {
          const history = await withinDeadline(cdp.send("Page.getNavigationHistory"));
          const entry = history.entries[history.currentIndex + (action.type === "back" ? -1 : 1)];
          if (entry) {
            assertOwned();
            await withinDeadline(cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }));
          }
          break;
        }
        case "reload":
          await withinDeadline(cdp.send("Page.reload"));
          break;
        case "pointer": {
          const button = action.event === "move" && action.button === "none"
            ? (action.buttons & 1 ? "left" : action.buttons & 2 ? "right" : action.buttons & 4 ? "middle" : "none")
            : action.button;
          await withinDeadline(cdp.send("Input.dispatchMouseEvent", {
            type: action.event === "move" ? "mouseMoved" : action.event === "down" ? "mousePressed" : "mouseReleased",
            x: action.x, y: action.y, button,
            buttons: action.buttons,
            clickCount: action.clickCount, modifiers: action.modifiers,
          }));
          break;
        }
        case "wheel":
          await withinDeadline(cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel", x: action.x, y: action.y,
            deltaX: action.deltaX, deltaY: action.deltaY, modifiers: action.modifiers,
          }));
          break;
        case "key":
          await withinDeadline(cdp.send("Input.dispatchKeyEvent", {
            type: action.event === "down" ? "rawKeyDown" : "keyUp",
            key: action.key, code: action.code, windowsVirtualKeyCode: action.windowsVirtualKeyCode,
            modifiers: action.modifiers, autoRepeat: action.repeat,
          }));
          break;
        case "text":
          await withinDeadline(cdp.send("Input.insertText", { text: action.text }));
          break;
        case "touch":
          await withinDeadline(cdp.send("Input.dispatchTouchEvent", {
            type: action.event === "start" ? "touchStart" : action.event === "move" ? "touchMove" : action.event === "end" ? "touchEnd" : "touchCancel",
            touchPoints: action.points, modifiers: action.modifiers,
          }));
          break;
      }
      assertOwned();
      return {};
    } finally {
      void cdp.detach().catch(() => undefined);
    }
  },
};
