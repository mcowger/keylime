import { afterEach, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityTracker, activityFor } from "../src/activity";
import { subscribeHostEvents } from "../src/events";
import { createTestSession, type TestSession } from "./harness";

let test: TestSession | undefined;
let unsubscribe: (() => void) | undefined;
afterEach(async () => {
  unsubscribe?.();
  await test?.dispose();
  test = undefined;
  unsubscribe = undefined;
});

it("measures output independently of request latency and ignores late tool ends", () => {
  const tracker = new ActivityTracker(() => {});
  tracker.request(1000);
  tracker.output("abcdefgh", 11000);
  tracker.output("abcdefgh", 12000);
  expect(tracker.snapshot()).toMatchObject({ kind: "streaming", rate: 4 });
  tracker.toolStart("tool");
  tracker.request(13000);
  tracker.toolEnd("tool");
  expect(tracker.snapshot()).toMatchObject({
    kind: "waiting",
    startedAt: 13000,
  });
  tracker.reset();
  tracker.output("late", 14000);
  expect(tracker.snapshot().kind).toBe("idle");
});

it("observes real model calls before and after a tool", async () => {
  process.env.OMPWEB_HOST_SOCKET = path.join(
    os.tmpdir(),
    `ompweb-activity-${process.pid}.sock`,
  );
  test = await createTestSession({
    toolNames: ["read"],
    responses: [
      {
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "missing.txt" },
          },
        ],
      },
      { content: ["done"] },
    ],
  });
  const activities: string[] = [];
  unsubscribe = subscribeHostEvents(test.session, (frame) => {
    const event = frame.event as { type?: string; activity?: { kind: string } };
    if (event.type === "model_activity" && event.activity)
      activities.push(event.activity.kind);
  });
  await test.session.prompt("read the file");
  const first = activities.indexOf("waiting");
  const stream = activities.indexOf("streaming", first + 1);
  const tools = activities.indexOf("tools", stream + 1);
  const second = activities.indexOf("waiting", tools + 1);
  const lastStream = activities.indexOf("streaming", second + 1);
  const idle = activities.indexOf("idle", lastStream + 1);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(stream).toBeGreaterThan(first);
  expect(tools).toBeGreaterThan(stream);
  expect(second).toBeGreaterThan(tools);
  expect(lastStream).toBeGreaterThan(second);
  expect(idle).toBeGreaterThan(lastStream);
  expect(activityFor(test.session)?.kind).toBe("idle");
});
