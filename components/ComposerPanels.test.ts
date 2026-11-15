import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BtwRecord } from "@/lib/btw";

const { ActivityPanel, ComposerPanels } = await import("./ComposerPanels");

const noop = () => {};

test("composer renders nothing without a side question", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ComposerPanels)), "");
});

test("attaches todo plan and subagent roster with live states", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityPanel, {
      todoPhases: [
        {
          name: "Implementation",
          tasks: [{ content: "Wire panels", status: "in_progress" }],
        },
      ],
      subagents: [
        {
          id: "SurfaceMap",
          agent: "scout",
          status: "started",
          task: "Map the surface",
          index: 0,
        },
        {
          id: "s2",
          agent: "worker",
          status: "completed",
          task: "Write the code",
          index: 1,
        },
      ],
      onSelectSubagent: noop,
    }),
  );

  assert.match(html, /Tasks/);
  assert.match(html, /Wire panels/);
  assert.match(html, /Subagents/);
  assert.match(html, /scout/);
  assert.match(html, />SurfaceMap</);
  assert.match(html, /Map the surface/);
  assert.match(html, /Completed \(1\)/);
  assert.doesNotMatch(html, /Write the code/);
  assert.match(html, /aria-label="1 running · 2 total"/);
  assert.doesNotMatch(html, />1 running · 2 total</);
});

test("live chips show current tool, telemetry, and async marker", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityPanel, {
      todoPhases: [],
      subagents: [
        {
          id: "s1",
          agent: "scout",
          status: "started",
          task: "Map the surface",
          index: 0,
          detached: true,
          progress: {
            currentTool: "read",
            lastIntent: "Inspect foo.ts",
            tokens: 2200,
            cost: 0.0041,
            contextTokens: 8000,
            contextWindow: 32000,
            resolvedModel: "provider/gpt-x:high",
          },
        },
      ],
      onSelectSubagent: noop,
    }),
  );

  assert.match(html, /Map the surface/);
  assert.match(html, /read — Inspect foo\.ts/);
  assert.match(html, /data-subagent-metric="2\.2k tok"/);
  assert.match(html, /data-subagent-metric="8k\/32k ctx"/);
  assert.match(html, />25\.0%</);
  assert.match(html, /Map the surface[\s\S]*data-subagent-metric="scout"/);
  assert.match(html, /data-subagent-metric="gpt-x"/);
  assert.doesNotMatch(html, />2\.2k tok</);
  assert.doesNotMatch(html, />8k\/32k ctx</);
  assert.match(html, /⤴/);
});

test("retrying chips surface retry state instead of the activity line", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityPanel, {
      todoPhases: [],
      subagents: [
        {
          id: "s1",
          agent: "worker",
          status: "started",
          task: "Write the code",
          index: 0,
          progress: {
            retryState: {
              attempt: 2,
              maxAttempts: 5,
              delayMs: 1000,
              errorMessage: "429",
              startedAtMs: 1,
            },
          },
        },
      ],
      onSelectSubagent: noop,
    }),
  );
  assert.match(html, /data-subagent-metric="retrying 2\/5"/);
  assert.doesNotMatch(html, />retrying 2\/5</);
});

test("activity keeps todo progress summary accessible", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityPanel, {
      todoPhases: [
        {
          name: "Implementation",
          tasks: [
            { content: "Checklist item 1", status: "pending" },
            { content: "Checklist item 2", status: "completed" },
          ],
        },
      ],
      subagents: [],
      onSelectSubagent: noop,
    }),
  );
  assert.match(html, /Tasks/);
  assert.match(html, /1\/2 complete/);
});

test("completed chips are initially hidden", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityPanel, {
      todoPhases: [],
      subagents: [
        {
          id: "s1",
          agent: "scout",
          status: "completed",
          task: "Finished task",
          index: 0,
          source: "history",
        },
      ],
      onSelectSubagent: noop,
    }),
  );
  assert.match(html, /Completed \(1\)/);
  assert.doesNotMatch(html, /Finished task/);
});

test("chips show agent source, nested count, and async marker", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityPanel, {
      todoPhases: [],
      subagents: [
        {
          id: "s1",
          agent: "scout",
          status: "started",
          task: "Map the surface",
          index: 0,
          agentSource: "user",
          detached: true,
          progress: {
            lastIntent: "Inspect foo.ts",
            inflightTaskDetails: {
              progress: [
                { id: "g1", agent: "task" },
                { id: "g2", agent: "task" },
              ],
            },
          },
        },
      ],
      onSelectSubagent: noop,
    }),
  );
  assert.match(html, /Inspect foo\.ts/);
  assert.match(html, /data-subagent-metric="user"/);
  assert.match(html, /data-subagent-metric="2 nested"/);
  assert.match(html, /⤴/);
});

test("zero context tokens never print a null gauge", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityPanel, {
      todoPhases: [],
      subagents: [
        {
          id: "s1",
          agent: "scout",
          status: "started",
          task: "Map the surface",
          index: 0,
          progress: {
            currentTool: "read",
            contextTokens: 0,
            contextWindow: 32000,
          },
        },
      ],
      onSelectSubagent: noop,
    }),
  );
  assert.doesNotMatch(html, /null/);
  assert.match(html, />0\.0%</);
  assert.match(html, /read/);
});

test("a side question keeps Copy for the earlier answer when its follow-up ended without text", () => {
  const record: BtwRecord = {
    id: "b1",
    leafId: null,
    question: "what is 2+2",
    answer: "It is 4.",
    status: "complete",
    createdAt: 1,
    updatedAt: 2,
    followUps: [
      {
        question: "and 3+3?",
        answer: "",
        status: "cancelled",
        createdAt: 3,
        updatedAt: 4,
      },
    ],
  };
  const html = renderToStaticMarkup(
    React.createElement(ComposerPanels, {
      btw: {
        record,
        onCancel: noop,
        onFollowUp: async () => true,
        onClose: noop,
      },
    }),
  );
  assert.match(html, /It is 4\./);
  assert.match(html, /Cancelled/);
  assert.match(html, />Copy answer</);
});
