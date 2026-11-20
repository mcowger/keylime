import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
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
  activeTab: "system",
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
  sessionId: null,
  onModelsSaved: noop,
  onPluginsReloaded: noop,
  onSelectTab: noop,
  onClose: noop,
} as const;

function fakeSettings(
  t: TestContext,
  stored: { uploadRetentionDays: number | null },
  endpoint = "/api/web-settings?hostId=local",
) {
  const puts: Array<BodyInit | null | undefined> = [];
  let putStatus = 200;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) !== endpoint) return Response.json({});
      if (init?.method === "PUT") {
        puts.push(init.body);
        return Response.json({}, { status: putStatus });
      }
      return Response.json(stored);
    },
    { preconnect: originalFetch.preconnect },
  );
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  return {
    puts,
    failPuts: () => {
      putStatus = 500;
    },
  };
}

test("the upload retention control offers Never, 7, 30 and 90 days, saves a change and restores a failed one", async (t) => {
  const { puts, failPuts } = fakeSettings(t, { uploadRetentionDays: 30 });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const select = within(container).getByRole("combobox", {
    name: "Delete sent uploads after",
  });
  const list = await openChoices(select);
  assert.deepEqual(
    within(list)
      .getAllByRole("option")
      .map((option) => option.textContent),
    ["Never", "7 days", "30 days", "90 days"],
  );
  assert.equal(select.textContent, "30 days");

  await choose(select, "Never");
  await settle();
  assert.deepEqual(puts, ['{"uploadRetentionDays":null}']);
  assert.equal(select.textContent, "Never");

  failPuts();
  await choose(select, "90 days");
  await settle();
  assert.equal(puts.at(-1), '{"uploadRetentionDays":90}');
  assert.equal(
    select.textContent,
    "Never",
    "a failed save restores the previous choice",
  );
});

test("a retention set through the API stays visible as its own choice", async (t) => {
  fakeSettings(t, { uploadRetentionDays: 14 });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const select = within(container).getByRole("combobox", {
    name: "Delete sent uploads after",
  });
  assert.equal(select.textContent, "14 days");
  const list = await openChoices(select);
  assert.equal(
    within(list).getAllByRole("option").at(-1)?.textContent,
    "14 days",
  );
});

test("upload retention reads and writes the selected host", async (t) => {
  const hostId = "laptop";
  const { puts } = fakeSettings(
    t,
    { uploadRetentionDays: 7 },
    `/api/web-settings?hostId=${hostId}`,
  );
  const { container } = render(
    createElement(SettingsConfig, {
      ...settingsProps,
      remoteHost: true,
      hostId,
    }),
  );
  await settle();
  const select = within(container).getByRole("combobox", {
    name: "Delete sent uploads after",
  });
  assert.equal(select.textContent, "7 days");
  await choose(select, "Never");
  await settle();
  assert.deepEqual(puts, ['{"uploadRetentionDays":null}']);
});
