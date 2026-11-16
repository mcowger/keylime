import {
  getTab,
  listTabs,
  type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { CommandContext, CommandTable } from "./types";
import { CommandError } from "./types";

const CAPTURE_TIMEOUT_MS = 5_000;
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

export const browserCommands: CommandTable = {
  /** @apiCommand browser_list */
  async browser_list(ctx) {
    const owner = ctx.session.getEvalKernelOwnerId();
    if (!owner) return { tabs: [] };
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
      return { mimeType: "image/jpeg", data: image.data };
    } finally {
      // Detaching also stops the session's screencast; never close the browser or page.
      void cdp.detach().catch(() => undefined);
    }
  },
};
