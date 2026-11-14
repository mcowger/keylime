import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { render, fireEvent, cleanup } = await import("@testing-library/react/pure.js");
const { SidebarActivity } = await import("./SidebarActivity.tsx");

test("sidebar shows only live agents and unfinished actionable todos", () => {
  let selected;
  const view = render(React.createElement(SidebarActivity, {
    todoPhases: [{ name: "Phase", tasks: [
      { content: "Working", status: "in_progress" },
      { content: "Upcoming", status: "pending" },
      { content: "Finished", status: "completed" },
      { content: "Blocked", status: "blocked" },
      { content: "Abandoned", status: "abandoned" },
    ] }],
    subagents: [
      { id: "Live", agent: "task", status: "started", index: 0 },
      { id: "Done", agent: "task", status: "completed", index: 1 },
      { id: "Historic", agent: "task", status: "started", source: "history", index: 2 },
    ],
    onSelectSubagent: (agent) => { selected = agent.id; },
  }));
  assert.ok(view.getByText("Working"));
  assert.ok(view.getByText("Upcoming"));
  assert.equal(view.queryByText("Finished"), null);
  assert.equal(view.queryByText("Blocked"), null);
  assert.equal(view.queryByText("Abandoned"), null);
  assert.equal(view.queryByText(/Done:/), null);
  assert.equal(view.queryByText(/Historic:/), null);
  fireEvent.click(view.getByRole("button", { name: /Live:/ }));
  assert.equal(selected, "Live");
  cleanup();
});
