import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import type { AutoPrewalkMode } from "@/lib/api-contracts/runner-lifecycle";
import { ChatInput } from "./ChatInput";
import { ModelPickerPanel } from "./ChatInput-model-picker";

// Testing Library binds its queries to the document installed by setup-dom.
const { cleanup, fireEvent, render, screen, within } =
  await import("@testing-library/react/pure.js");

window.matchMedia = globalThis.matchMedia;

afterEach(() => cleanup());

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
  fireEvent.click(screen.getByRole("button", { name: "Auto Prewalk: Unknown" }));
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
