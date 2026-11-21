import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import type { AutoPrewalkMode } from "@/lib/api-contracts/runner-lifecycle";
import { setShowPrewalkControl } from "@/hooks/useShowPrewalkControl";
import { ChatInput } from "./ChatInput";
import { ModelPickerPanel } from "./ChatInput-model-picker";

// Testing Library binds its queries to the document installed by setup-dom.
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react/pure.js");

window.matchMedia = globalThis.matchMedia;

afterEach(() => {
  cleanup();
  localStorage.removeItem("keylime:show-prewalk-control");
});

test("the model picker can refresh during a run and displays the updated catalog", () => {
  let refreshes = 0;
  let revalidations = 0;
  const props = {
    onSend: async () => ({ status: "accepted" as const }),
    onAbort() {},
    onModelChange() {},
    onRefreshModels() {
      refreshes++;
    },
    onRevalidateModels() {
      revalidations++;
    },
    isStreaming: true,
    modelList: [{ id: "old", provider: "example", name: "Old" }],
  };
  const view = render(React.createElement(ChatInput, props));
  fireEvent.click(screen.getByRole("button", { name: /Change model/ }));
  fireEvent.click(screen.getByRole("button", { name: "More…" }));
  assert.equal(revalidations, 1);
  assert.ok(
    (screen.getByRole("menuitemradio", { name: "Old" }) as HTMLButtonElement)
      .disabled,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  assert.equal(refreshes, 1);

  view.rerender(
    React.createElement(ChatInput, {
      ...props,
      modelsLoading: true,
      modelsRefreshing: true,
    }),
  );
  assert.ok(
    (
      screen.getByRole("button", {
        name: "Refreshing models...",
      }) as HTMLButtonElement
    ).disabled,
  );
  view.rerender(
    React.createElement(ChatInput, {
      ...props,
      modelList: [{ id: "new", provider: "example", name: "New" }],
    }),
  );
  assert.ok(screen.getByRole("menuitemradio", { name: "New" }));
  assert.equal(screen.queryByRole("menuitemradio", { name: "Old" }), null);

  view.rerender(
    React.createElement(ChatInput, { ...props, modelError: "Refresh failed" }),
  );
  assert.ok(screen.getAllByText("Refresh failed").length > 0);
  assert.ok(screen.getByRole("button", { name: "Refresh models" }));
});

test("auto-prewalk can be selected without changing the model and reports errors", () => {
  const selected: string[] = [];
  let refreshes = 0;
  let modelChanges = 0;
  const props = {
    onSend: async () => ({ status: "accepted" as const }),
    onAbort() {},
    onModelChange() { modelChanges++; },
    onRefreshAutoPrewalk() { refreshes++; },
    onAutoPrewalkChange(mode: AutoPrewalkMode) { selected.push(mode); },
    autoPrewalk: "suggest" as const,
    isStreaming: false,
    modelList: [{ id: "old", provider: "example", name: "Old" }],
  };
  const view = render(React.createElement(ChatInput, props));
  fireEvent.click(screen.getByRole("button", { name: /Change model/ }));
  assert.equal(refreshes, 1);
  fireEvent.click(screen.getByRole("button", { name: "Auto Prewalk: Suggest" }));
  view.rerender(React.createElement(ChatInput, { ...props, autoPrewalk: "on" }));
  fireEvent.click(screen.getByRole("button", { name: "Auto Prewalk: On" }));
  view.rerender(React.createElement(ChatInput, { ...props, autoPrewalk: "off" }));
  fireEvent.click(screen.getByRole("button", { name: "Auto Prewalk: Off" }));
  view.rerender(React.createElement(ChatInput, { ...props, autoPrewalk: null }));
  fireEvent.click(screen.getByRole("button", { name: "Auto Prewalk: Default" }));
  assert.deepEqual(selected, ["on", "off", "suggest", "off"]);
  assert.equal(modelChanges, 0);
  view.rerender(React.createElement(ChatInput, { ...props, autoPrewalkError: "Command failed" }));
  assert.ok(screen.getByRole("alert").textContent?.includes("Command failed"));
  const button = screen.getByRole("button", { name: "Auto Prewalk: Suggest" });
  button.focus();
  view.rerender(React.createElement(ChatInput, { ...props, autoPrewalkPending: true }));
  assert.equal(document.activeElement, button);
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.equal(button.matches(":disabled"), false);
  fireEvent.click(button);
  assert.deepEqual(selected, ["on", "off", "suggest", "off"]);
  view.rerender(React.createElement(ChatInput, { ...props }));
  assert.equal(document.activeElement, button);
  fireEvent.click(button);
  assert.deepEqual(selected, ["on", "off", "suggest", "off", "on"]);
  view.rerender(React.createElement(ChatInput, { ...props, isStreaming: true }));
  assert.equal(button.matches(":disabled"), true);
});

test("prewalk control can be hidden and stays hidden after remount", () => {
  let refreshes = 0;
  const props = {
    onSend: async () => ({ status: "accepted" as const }),
    onAbort() {},
    onModelChange() {},
    onPlanModeChange() {},
    onRefreshAutoPrewalk() { refreshes++; },
    onAutoPrewalkChange() {},
    autoPrewalk: "suggest" as const,
    isStreaming: false,
  };
  const view = render(React.createElement(ChatInput, props));
  fireEvent.click(screen.getByRole("button", { name: /Change model/ }));
  assert.ok(screen.getByRole("button", { name: "Auto Prewalk: Suggest" }));
  assert.equal(refreshes, 1);
  act(() => setShowPrewalkControl(false));
  assert.equal(screen.queryByRole("button", { name: /Auto Prewalk/ }), null);
  assert.ok(screen.getByRole("button", { name: "Build mode. Switch to Plan" }));
  view.unmount();
  render(React.createElement(ChatInput, props));
  fireEvent.click(screen.getByRole("button", { name: /Change model/ }));
  assert.equal(refreshes, 2);
  assert.equal(screen.queryByRole("button", { name: /Auto Prewalk/ }), null);
  act(() => setShowPrewalkControl(true));
  assert.ok(screen.getByRole("button", { name: "Auto Prewalk: Suggest" }));
});

test("the model picker remains available when no models are returned", () => {
  const props = {
    onSend: async () => ({ status: "accepted" as const }),
    onAbort() {},
    onModelChange() {},
    onRefreshModels() {},
    isStreaming: false,
    modelList: [],
  };
  render(React.createElement(ChatInput, props));
  fireEvent.click(screen.getByRole("button", { name: /Change model/ }));
  assert.equal(screen.queryByRole("button", { name: "Refresh models" }), null);
  fireEvent.click(screen.getByRole("button", { name: "More…" }));
  assert.ok(screen.getByRole("button", { name: "Refresh models" }));
});

test("other models retain provider navigation on desktop and mobile", () => {
  const options = [
    { provider: "codex", modelId: "sol", name: "Sol" },
    { provider: "pi", modelId: "one", name: "Pi One" },
  ];

  for (const isMobile of [false, true]) {
    const { unmount } = render(
      React.createElement(ModelPickerPanel, {
        modelOptions: options,
        filteredModelOptions: options,
        currentModel: options[0],
        modelSearchQuery: "",
        onSearchQueryChange() {},
        onSelectModel() {},
        isMobile,
      }),
    );
    assert.equal(screen.queryByRole("menuitemradio", { name: "Sol" }), null);
    fireEvent.click(screen.getByRole("button", { name: "More…" }));
    if (!isMobile)
      assert.ok(screen.getByRole("menuitemradio", { name: "Sol" }));
    fireEvent.click(screen.getByRole("button", { name: "pi" }));
    assert.ok(screen.getByRole("menuitemradio", { name: "Pi One" }));
    assert.equal(screen.queryByRole("menuitemradio", { name: "Sol" }), null);
    if (isMobile) {
      fireEvent.click(screen.getByRole("button", { name: "pi" }));
      assert.ok(screen.getByRole("button", { name: "codex" }));
    }
    unmount();
  }
});

test("starring a model moves its only row out of More, and unstarring moves it back", () => {
  const sol = { provider: "codex", modelId: "sol", name: "Sol" };
  const options = [sol, { ...sol }];
  render(
    React.createElement(ModelPickerPanel, {
      modelOptions: options,
      filteredModelOptions: options,
      modelSearchQuery: "",
      onSearchQueryChange() {},
      onSelectModel() {},
      onRefreshModels() {},
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "More…" }));
  assert.ok(screen.getByRole("menuitemradio", { name: "Sol" }));
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Favorite Sol (codex)" }),
    );
    const favorites = screen.getByRole("group", { name: "Favorites" });
    assert.equal(
      screen.getByRole("menuitemradio"),
      within(favorites).getByRole("menuitemradio"),
    );
    assert.ok(screen.getByRole("button", { name: "Refresh models" }));

    fireEvent.click(
      within(favorites).getByRole("button", { name: "Favorite Sol (codex)" }),
    );
    assert.equal(screen.queryByRole("group", { name: "Favorites" }), null);
    assert.ok(screen.getByRole("menuitemradio", { name: "Sol" }));
  } finally {
    window.localStorage.removeItem("keylime:favorite-models");
  }
});

test("workspace roles use host and cwd, filter with search, and apply resolved choices", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  let requests = 0;
  let selected: [string, { provider: string | null; modelId: string | null; effectiveThinkingLevel: string | null }] | null = null;
  let closed = false;
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    requested = String(input);
    requests += 1;
    return Response.json({ roles: [
      { id: "default", provider: "p", modelId: "one", modelName: "One", thinkingLevel: "high", effectiveThinkingLevel: "low" },
      { id: "smol", provider: null, modelId: null, modelName: null, thinkingLevel: null, effectiveThinkingLevel: null },
      { id: "custom", provider: "p", modelId: "two", modelName: "Two", thinkingLevel: null, effectiveThinkingLevel: "medium" },
    ] });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  const props = {
    modelOptions: [],
    filteredModelOptions: [],
    modelSearchQuery: "",
    onSearchQueryChange() {},
    onSelectModel() {},
    roleHostId: "remote",
    roleCwd: "/workspace/a b",
    currentModel: { provider: "current", modelId: "selected" },
    roleSessionId: "session1",
    roleThinkingLevel: "low",
    onSelectRole: async (role: string, preview: { provider: string | null; modelId: string | null; effectiveThinkingLevel: string | null }) => {
      selected = [role, preview];
      return true;
    },
    onClose: () => { closed = true; },
    isMobile: true,
  };
  try {
    const view = render(React.createElement(ModelPickerPanel, props));
    await screen.findByRole("button", { name: /Default One · low/ });
    assert.equal(requested, "/api/chat-roles?hostId=remote&cwd=%2Fworkspace%2Fa+b&sessionId=session1&thinkingLevel=low&currentProvider=current&currentModelId=selected");
    assert.ok((screen.getByRole("button", { name: /Fast Unavailable/ }) as HTMLButtonElement).disabled);
    view.rerender(React.createElement(ModelPickerPanel, { ...props, roleThinkingLevel: "high" }));
    await waitFor(() => assert.equal(requests, 2));
    assert.ok(requested.includes("thinkingLevel=high"));
    await screen.findByRole("button", { name: /Default One · low/ });
    view.rerender(React.createElement(ModelPickerPanel, { ...props, roleThinkingLevel: "high", modelSearchQuery: "two" }));
    assert.equal(screen.queryByRole("button", { name: /Default One/ }), null);
    assert.ok(screen.getByRole("button", { name: /custom Two/ }));
    view.rerender(React.createElement(ModelPickerPanel, { ...props, roleThinkingLevel: "high" }));
    fireEvent.click(screen.getByRole("button", { name: /Default One · low/ }));
    await screen.findByRole("button", { name: /Default One · low/ });
    assert.deepEqual(selected, ["default", { provider: "p", modelId: "one", effectiveThinkingLevel: "low" }]);
    await Promise.resolve();
    assert.equal(closed, true);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("an unresolved default can use the native current-model fallback and reports rejection", async () => {
  const originalFetch = globalThis.fetch;
  let selected = "";
  globalThis.fetch = Object.assign(async () => Response.json({ roles: [
    { id: "default", provider: null, modelId: null, modelName: null, thinkingLevel: null, effectiveThinkingLevel: null },
    { id: "smol", provider: null, modelId: null, modelName: null, thinkingLevel: null, effectiveThinkingLevel: null },
  ] }), { preconnect: originalFetch.preconnect }) as typeof fetch;
  try {
    render(React.createElement(ModelPickerPanel, {
      modelOptions: [], filteredModelOptions: [], modelSearchQuery: "", onSearchQueryChange() {}, onSelectModel() {},
      roleHostId: "remote", roleCwd: "/workspace", onSelectRole: async (role: string) => { selected = role; return false; },
    }));
    const defaultRole = await screen.findByRole("button", { name: /Default Unavailable/ });
    assert.equal((defaultRole as HTMLButtonElement).disabled, false);
    assert.equal((screen.getByRole("button", { name: /Fast Unavailable/ }) as HTMLButtonElement).disabled, true);
    fireEvent.click(defaultRole);
    await screen.findByRole("alert");
    assert.equal(selected, "default");
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("a role reply from a previous session does not close the new picker", async () => {
  const originalFetch = globalThis.fetch;
  const reply = Promise.withResolvers<boolean>();
  let closed = false;
  globalThis.fetch = Object.assign(async () => Response.json({ roles: [
    { id: "smol", provider: "p", modelId: "one", modelName: "One", thinkingLevel: null, effectiveThinkingLevel: null },
  ] }), { preconnect: originalFetch.preconnect }) as typeof fetch;
  const props = {
    modelOptions: [], filteredModelOptions: [], modelSearchQuery: "", onSearchQueryChange() {}, onSelectModel() {},
    roleHostId: "remote", roleCwd: "/workspace", roleSessionId: "first",
    onSelectRole: () => reply.promise, onClose: () => { closed = true; },
  };
  try {
    const view = render(React.createElement(ModelPickerPanel, props));
    fireEvent.click(await screen.findByRole("button", { name: /Fast One/ }));
    view.rerender(React.createElement(ModelPickerPanel, { ...props, roleSessionId: "second" }));
    await screen.findByRole("button", { name: /Fast One/ });
    reply.resolve(true);
    await Promise.resolve();
    assert.equal(closed, false);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("reopening roles shows the scoped cache immediately and revalidates it", async () => {
  const originalFetch = globalThis.fetch;
  const refresh = Promise.withResolvers<Response>();
  const other = Promise.withResolvers<Response>();
  let requests = 0;
  const roles = (name: string) => ({ roles: [
    { id: "smol", provider: "p", modelId: name, modelName: name, thinkingLevel: null, effectiveThinkingLevel: null },
  ] });
  globalThis.fetch = Object.assign(async () => {
    requests++;
    if (requests === 1) return Response.json(roles("Cached"));
    if (requests === 2) return refresh.promise;
    return other.promise;
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  const props = {
    modelOptions: [], filteredModelOptions: [], modelSearchQuery: "", onSearchQueryChange() {}, onSelectModel() {},
    roleHostId: "cache-host", roleCwd: "/cache-workspace", roleSessionId: "cache-session",
    onSelectRole: async () => true,
  };
  try {
    const first = render(React.createElement(ModelPickerPanel, props));
    await screen.findByRole("button", { name: /Fast Cached/ });
    first.unmount();

    const reopened = render(React.createElement(ModelPickerPanel, props));
    assert.ok(screen.getByRole("button", { name: /Fast Cached/ }));
    assert.equal(requests, 2);
    await act(async () => refresh.resolve(Response.json(roles("Updated"))));
    assert.ok(screen.getByRole("button", { name: /Fast Updated/ }));

    reopened.rerender(React.createElement(ModelPickerPanel, { ...props, roleHostId: "another-host" }));
    assert.equal(screen.queryByRole("button", { name: /Fast Updated/ }), null);
    assert.equal(screen.queryByRole("button", { name: /Fast Cached/ }), null);
    await act(async () => other.resolve(Response.json(roles("Other"))));
    assert.ok(screen.getByRole("button", { name: /Fast Other/ }));
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});
