import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { render, screen, cleanup, fireEvent } =
  await import("@testing-library/react/pure.js");
const { ChatInput } = await import("./ChatInput.tsx");
afterEach(cleanup);

test("reasoning effort lives in model picker, preserves mapped provider levels and locks during streaming", () => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const changes = [];
  const props = {
    onSend: async () => ({ status: "accepted" }),
    onAbort() {},
    model: { provider: "only", modelId: "one" },
    modelList: [{ provider: "only", id: "one", name: "One" }],
    onModelChange() {},
    onThinkingLevelChange: (level) => changes.push(level),
    thinkingLevel: "low",
    availableThinkingLevels: ["low", "ultra"],
    thinkingLevelMap: { ultra: "Provider maximum" },
    isStreaming: false,
  };
  const view = render(React.createElement(ChatInput, props));
  assert.equal(
    screen.queryByRole("combobox", { name: "Change reasoning level" }),
    null,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Change model:/ }));
  const select = screen.getByRole("combobox", {
    name: "Change reasoning level",
  });
  assert.ok(select.closest('[role="dialog"]'));
  assert.ok(screen.getByRole("option", { name: "Provider maximum" }));
  fireEvent.change(select, { target: { value: "ultra" } });
  assert.deepEqual(changes, ["ultra"]);
  view.rerender(
    React.createElement(ChatInput, { ...props, isStreaming: true }),
  );
  assert.equal(
    screen.getByRole("combobox", { name: "Change reasoning level" }).disabled,
    true,
  );
});
