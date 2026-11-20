import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import * as transport from "@/lib/event-stream";
import { AppShell } from "./AppShell";

window.matchMedia = globalThis.matchMedia;
Object.defineProperty(document, "fonts", { value: new EventTarget() });
globalThis.fetch = Object.assign(
  async () => new Response(null, { status: 503 }),
  { preconnect: globalThis.fetch.preconnect },
);
mock.module("@/lib/event-stream", () => ({
  ...transport,
  openEventStream: () => Object.assign(new EventTarget(), { close() {} }),
}));

test("the first sidebar render honors a saved choice to hide provider usage", async () => {
  const key = "keylime:provider-usage-visible";
  window.localStorage.setItem(key, "false");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let firstSidebarIncludedUsage: boolean | undefined;
  try {
    await act(async () => {
      root.render(
        <Profiler
          id="app"
          onRender={() => {
            if (!container.querySelector("nav button.sidebar-settings-row"))
              return;
            firstSidebarIncludedUsage ??= Boolean(
              container.querySelector('section[aria-label="Provider Usage"]'),
            );
          }}
        >
          <AppShell appName="Keylime" />
        </Profiler>,
      );
    });
    assert.equal(firstSidebarIncludedUsage, false);
  } finally {
    act(() => root.unmount());
    container.remove();
    window.localStorage.removeItem(key);
  }
});
