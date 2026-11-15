import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { render, screen, cleanup, fireEvent } =
  await import("@testing-library/react/pure.js");
const { ChatInput } = await import("./ChatInput");
afterEach(cleanup);

test("reasoning effort lives in model picker, preserves mapped provider levels and locks during streaming", () => {
  window.matchMedia = (media) => ({
    media,
    matches: false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  const changes: string[] = [];
  const props: React.ComponentProps<typeof ChatInput> = {
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
    screen
      .getByRole("img", { name: "Reasoning: low" })
      .getAttribute("data-level"),
    "low",
  );
  assert.equal(
    screen.queryByRole("slider", { name: "Change reasoning level" }),
    null,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Change model:/ }));
  const select = screen.getByRole("slider", {
    name: "Change reasoning level",
  });
  assert.ok(select.closest('[role="dialog"]'));
  assert.ok(screen.getByRole("button", { name: "Provider maximum" }));
  fireEvent.change(select, { target: { value: "1" } });
  assert.deepEqual(changes, ["ultra"]);
  view.rerender(
    React.createElement(ChatInput, {
      ...props,
      thinkingLevel: "ultra",
      isStreaming: true,
    }),
  );
  assert.equal(
    screen
      .getByRole("img", { name: "Reasoning: Provider maximum" })
      .getAttribute("data-level"),
    "ultra",
  );
  assert.equal(
    (
      screen.getByRole("slider", {
        name: "Change reasoning level",
      }) as HTMLInputElement
    ).disabled,
    true,
  );
});
