import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react/pure.js");
const { SettingsConfig } = await import("./SettingsConfig");

const noop = () => {};
const settle = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const openChoices = async (select: HTMLElement) => {
  fireEvent.click(select);
  return waitFor(() => within(document.body).getByRole("listbox"));
};
const choose = async (select: HTMLElement, name: string) => {
  if (select.getAttribute("aria-expanded") !== "true")
    await openChoices(select);
  const option = within(within(document.body).getByRole("listbox")).getByRole(
    "option",
    { name },
  );
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await settle();
};

const settingsProps = {
  activeTab: "general",
  toolCallsDefaultCollapsed: false,
  onToolCallsDefaultCollapsedChange: noop,
  hideToolActivity: false,
  onHideToolActivityChange: noop,
  neverFoldActivity: false,
  onNeverFoldActivityChange: noop,
  showToolCallsUnfolded: false,
  onShowToolCallsUnfoldedChange: noop,
  expandThinkingByDefault: "off",
  onExpandThinkingByDefaultChange: noop,
  onHideThinkingBlockChange: noop,
  providerUsageVisible: false,
  onProviderUsageVisibleChange: noop,
  scopeNativeSelectAll: false,
  onScopeNativeSelectAllChange: noop,
  openUrlAutomatically: false,
  onOpenUrlAutomaticallyChange: noop,
  cwd: null,
  remoteHost: false,
  cluster: false,
  sessionId: null,
  onModelsSaved: noop,
  onPluginsReloaded: noop,
  appUpdate: null,
  onRefreshAppUpdate: async () => null,
  onRequestAppUpdate: noop,
  onSelectTab: noop,
  onClose: noop,
} as const;

test("thinking expansion offers all modes and reports selection changes", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => new Response("{}", { status: 200 }),
    { preconnect: originalFetch.preconnect },
  );
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  const changes: string[] = [];
  const { container } = render(
    createElement(SettingsConfig, {
      ...settingsProps,
      expandThinkingByDefault: "latest",
      onExpandThinkingByDefaultChange: (value) => changes.push(value),
    }),
  );
  await settle();
  const select = within(container).getByRole("combobox", {
    name: "Expand thinking blocks",
  });
  const list = await openChoices(select);
  assert.deepEqual(
    within(list)
      .getAllByRole("option")
      .map((option) => option.textContent),
    ["Off", "Latest", "Always"],
  );
  assert.equal(select.textContent, "Latest");
  await choose(select, "Always");
  await choose(select, "Off");
  assert.deepEqual(changes, ["always", "off"]);
});

test("the browser transport control offers SSE and the WebSocket link, saves a change and restores a failed one", async (t) => {
  const puts: Array<BodyInit | null | undefined> = [];
  let putStatus = 200;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) !== "/api/web-settings") return Response.json({});
      if (init?.method === "PUT") {
        puts.push(init.body);
        return Response.json({}, { status: putStatus });
      }
      return Response.json({ browserTransport: "sse" });
    },
    { preconnect: originalFetch.preconnect },
  );
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const page = within(container);
  const select = page.getByRole("combobox", {
    name: "Browser connection",
  }) as HTMLButtonElement;
  const list = await openChoices(select);
  assert.deepEqual(
    within(list)
      .getAllByRole("option")
      .map((option) => option.textContent),
    ["Server-sent events + HTTP", "WebSocket link (default)"],
  );
  assert.equal(select.textContent, "Server-sent events + HTTP");
  assert.equal(select.disabled, false);

  await choose(select, "WebSocket link (default)");
  await settle();
  assert.deepEqual(puts, ['{"browserTransport":"ws"}']);
  assert.equal(select.textContent, "WebSocket link (default)");

  putStatus = 500;
  await choose(select, "Server-sent events + HTTP");
  await settle();
  assert.equal(puts.at(-1), '{"browserTransport":"sse"}');
  assert.equal(
    select.textContent,
    "WebSocket link (default)",
    "a failed save restores the previous mode",
  );
});

test("the browser transport control is disabled while its save is in flight, so two saves cannot finish out of order", async (t) => {
  const { promise: putPending, resolve: releasePut } =
    Promise.withResolvers<void>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) !== "/api/web-settings") return Response.json({});
      if (init?.method === "PUT") {
        await putPending;
        return Response.json({});
      }
      return Response.json({ browserTransport: "sse" });
    },
    { preconnect: originalFetch.preconnect },
  );
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const select = within(container).getByRole("combobox", {
    name: "Browser connection",
  }) as HTMLButtonElement;
  await choose(select, "WebSocket link (default)");
  await settle();
  assert.equal(
    select.disabled,
    true,
    "a second change cannot start while the first save is in flight",
  );
  await act(async () => {
    releasePut();
  });
  await settle();
  assert.equal(select.disabled, false);
});

test("the browser transport control shows the WebSocket link when the server sends no value or the read fails", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  for (const answer of [
    () => Response.json({}),
    () => Response.json({}, { status: 500 }),
    () => Promise.reject(new Error("offline")),
  ]) {
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL) =>
        String(url) === "/api/web-settings" ? answer() : Response.json({}),
      { preconnect: originalFetch.preconnect },
    );
    const { container, unmount } = render(
      createElement(SettingsConfig, settingsProps),
    );
    await settle();
    assert.equal(
      within(container).getByRole("combobox", { name: "Browser connection" })
        .textContent,
      "WebSocket link (default)",
    );
    unmount();
  }
});
