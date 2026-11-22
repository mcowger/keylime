import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AdvisorStatusOverviewEntry } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { eventsCommands, subscribeHostEvents } from "../src/events";
import { sessionState } from "../src/commands/model";
import { createTestSession, type Frame, type TestSession } from "./harness";

let test: TestSession | undefined;
let unsubscribe: (() => void) | undefined;

afterEach(async () => {
  unsubscribe?.();
  await test?.dispose();
  test = undefined;
  unsubscribe = undefined;
});

type Event = { type: string } & Record<string, unknown>;

async function bridged(responses: { content: string[] }[] = []) {
  // No host listens here: the session's own channel stays closed and only this bridge reports.
  process.env.KEYLIME_HOST_SOCKET = path.join(
    os.tmpdir(),
    `keylime-events-test-${process.pid}.sock`,
  );
  test = await createTestSession({ responses });
  const session = test.session;
  const events: Event[] = [];
  const waiters = new Map<string, { count: number; resolve: () => void }>();
  const send = (frame: Frame) => {
    expect(["event", "workspace_jobs_changed"]).toContain(frame.t);
    const event =
      frame.t === "workspace_jobs_changed"
        ? { type: frame.t }
        : (frame.event as Event);
    events.push(event);
    const waiter = waiters.get(event.type);
    if (waiter && events.filter((item) => item.type === event.type).length >= waiter.count) {
      waiters.delete(event.type);
      waiter.resolve();
    }
  };
  const waitFor = (type: string, count = 1) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (events.filter((event) => event.type === type).length >= count) resolve();
    else waiters.set(type, { count, resolve });
    return promise;
  };
  unsubscribe = subscribeHostEvents(session, send);
  const filter = (args: Record<string, unknown>) =>
    eventsCommands.set_event_filter({ session, send }, args);
  return { session, events, waitFor, filter };
}

describe("host events bridge", () => {
  it("stamps message ids, sends deltas by default, and settles after the run", async () => {
    const { session, events, waitFor } = await bridged([
      { content: ["scripted reply"] },
    ]);
    await session.prompt("hello");
    await waitFor("session_settled");
    await waitFor("available_commands_update");

    const types = events.map((event) => event.type);
    expect(types.indexOf("session_settled")).toBeGreaterThan(
      types.lastIndexOf("agent_end"),
    );

    const assistantEnd = events.find(
      (event) =>
        event.type === "message_end" &&
        JSON.stringify(event).includes("scripted reply"),
    );
    const updates = events.filter((event) => event.type === "message_update");
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(update).toMatchObject({
        messageId: assistantEnd?.messageId,
        message: { role: "assistant" },
      });
      expect(Object.keys(update.message as object)).toEqual(["role"]);
    }
    expect(JSON.stringify(updates)).not.toContain('"partial"');
  });

  it("sends the whole partial in full mode and validates the filter", async () => {
    const { session, events, waitFor, filter } = await bridged([
      { content: ["full reply"] },
    ]);
    expect(await filter({ events: null, messageUpdates: "full" })).toEqual({
      events: null,
      messageUpdates: "full",
    });
    await expect(
      filter({ events: [""], messageUpdates: "full" }),
    ).rejects.toThrow("events must be null");
    await expect(
      filter({ events: null, messageUpdates: "some" }),
    ).rejects.toThrow("messageUpdates");

    await session.prompt("hello");
    await waitFor("agent_end");
    expect(
      events.find((event) => event.type === "message_update"),
    ).toMatchObject({
      message: { role: "assistant", content: expect.any(Array) },
    });
  });

  it("reports session renames", async () => {
    const { session, events, waitFor } = await bridged();
    session.sessionManager.setSessionName("renamed", "user");
    await waitFor("session_info_update");
    expect(
      events.find((event) => event.type === "session_info_update"),
    ).toMatchObject({
      title: "renamed",
      sessionId: session.sessionId,
    });
  });
  it("keeps review pending until advisor card delivery finishes and snapshots it on reconnect", async () => {
    const { session, events, waitFor } = await bridged();
    let advisors: AdvisorStatusOverviewEntry[] = [];
    const status = spyOn(session, "getAdvisorStatusOverview").mockImplementation(
      () => ({ configured: true, advisors }),
    );
    const delivery = Promise.withResolvers<boolean>();
    const catchup = spyOn(session, "waitForAdvisorCatchup").mockReturnValue(delivery.promise);
    const reviewEvents = () => events.filter((event) => event.type === "advisor_review");
    try {
      expect(sessionState(session).advisorReviewPending).toBe(false);
      advisors = [{ name: "reviewer", yielded: false, backlog: 1, status: "running", isPaused: false }];
      expect(sessionState(session).advisorReviewPending).toBe(true);
      await waitFor("advisor_review");
      expect(reviewEvents()).toEqual([{ type: "advisor_review", pending: true }]);

      // OMP can finish the model review before its card event is delivered.
      advisors = [];
      expect(sessionState(session).advisorReviewPending).toBe(true);
      unsubscribe?.();
      unsubscribe = subscribeHostEvents(session, (frame) => {
        if (frame.t === "event") events.push(frame.event as Event);
      });
      expect(reviewEvents()).toEqual([
        { type: "advisor_review", pending: true },
        { type: "advisor_review", pending: true },
      ]);
      delivery.resolve(true);
      await delivery.promise;
      // Let the tracker's continuation publish the completed drain.
      await Promise.resolve();
      expect(sessionState(session).advisorReviewPending).toBe(false);
      expect(reviewEvents().at(-1)).toEqual({ type: "advisor_review", pending: false });
    } finally {
      delivery.resolve(true);
      status.mockRestore();
      catchup.mockRestore();
    }
  });

  it("covers the asynchronous turn-end hook before the advisor backlog exists", async () => {
    const { session, events, waitFor } = await bridged([{ content: ["done"] }]);
    let advisors: AdvisorStatusOverviewEntry[] = [
      { name: "reviewer", yielded: false, backlog: 0, status: "running", isPaused: false },
    ];
    const status = spyOn(session, "getAdvisorStatusOverview").mockImplementation(
      () => ({ configured: true, advisors }),
    );
    const hook = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<boolean>();
    const catchup = spyOn(session, "waitForAdvisorCatchup").mockReturnValue(delivery.promise);
    session.agent.setOnTurnEnd(async () => {
      await hook.promise;
      advisors = [{ name: "reviewer", yielded: false, backlog: 1, status: "running", isPaused: false }];
    });
    try {
      const prompt = session.prompt("hello");
      await waitFor("turn_end");
      expect(sessionState(session).advisorReviewPending).toBe(true);
      expect(events.filter((event) => event.type === "advisor_review")).toEqual([
        { type: "advisor_review", pending: true },
      ]);
      hook.resolve();
      await prompt;
      await waitFor("agent_end");
      expect(sessionState(session).advisorReviewPending).toBe(true);
      advisors = [];
      expect(sessionState(session).advisorReviewPending).toBe(true);
      delivery.resolve(true);
      await waitFor("advisor_review", 2);
      expect(sessionState(session).advisorReviewPending).toBe(false);
    } finally {
      hook.resolve();
      delivery.resolve(true);
      status.mockRestore();
      catchup.mockRestore();
    }
  });

  it("clears the boundary when OMP skips a review on its configured cadence", async () => {
    const { session, waitFor } = await bridged([{ content: ["done"] }]);
    const status = spyOn(session, "getAdvisorStatusOverview").mockReturnValue({
      configured: true,
      advisors: [{ name: "reviewer", yielded: false, backlog: 0, status: "running", isPaused: false }],
    });
    const hook = Promise.withResolvers<void>();
    session.agent.setOnTurnEnd(() => hook.promise);
    try {
      const prompt = session.prompt("hello");
      await waitFor("turn_end");
      expect(sessionState(session).advisorReviewPending).toBe(true);
      hook.resolve();
      await prompt;
      await waitFor("advisor_review", 2);
      expect(sessionState(session).advisorReviewPending).toBe(false);
    } finally {
      hook.resolve();
      status.mockRestore();
    }
  });

  it("does not clear after a failed catchup until card processing is idle", async () => {
    const { session, waitFor } = await bridged();
    let advisors: AdvisorStatusOverviewEntry[] = [
      { name: "reviewer", yielded: false, backlog: 1, status: "running", isPaused: false },
    ];
    const status = spyOn(session, "getAdvisorStatusOverview").mockImplementation(
      () => ({ configured: true, advisors }),
    );
    const idle = Promise.withResolvers<void>();
    const catchup = spyOn(session, "waitForAdvisorCatchup").mockResolvedValue(false);
    const waitIdle = spyOn(session, "waitForIdle").mockReturnValue(idle.promise);
    try {
      expect(sessionState(session).advisorReviewPending).toBe(true);
      await waitFor("advisor_review");
      advisors = [{ name: "reviewer", yielded: true, backlog: 1, status: "error", isPaused: false }];
      await Promise.resolve();
      expect(sessionState(session).advisorReviewPending).toBe(true);
      idle.resolve();
      await waitFor("advisor_review", 2);
      expect(sessionState(session).advisorReviewPending).toBe(false);
    } finally {
      idle.resolve();
      status.mockRestore();
      catchup.mockRestore();
      waitIdle.mockRestore();
    }
  });

  it("keeps queued work pending after an unsuccessful drain while the advisor can still recover", async () => {
    const { session, waitFor } = await bridged();
    let advisors: AdvisorStatusOverviewEntry[] = [
      { name: "reviewer", yielded: false, backlog: 1, status: "error", isPaused: true },
    ];
    const status = spyOn(session, "getAdvisorStatusOverview").mockImplementation(
      () => ({ configured: true, advisors }),
    );
    const retry = Promise.withResolvers<boolean>();
    const catchup = spyOn(session, "waitForAdvisorCatchup")
      .mockResolvedValueOnce(false)
      .mockReturnValue(retry.promise);
    const idleEntered = Promise.withResolvers<void>();
    const waitIdle = spyOn(session, "waitForIdle").mockImplementation(() => {
      idleEntered.resolve();
      return Promise.resolve();
    });
    try {
      expect(sessionState(session).advisorReviewPending).toBe(true);
      await waitFor("advisor_review");
      // Neither an error status nor a pause proves queued work was abandoned.
      await idleEntered.promise;
      await Promise.resolve();
      expect(sessionState(session).advisorReviewPending).toBe(true);
      advisors = [];
      retry.resolve(true);
      await waitFor("advisor_review", 2);
      expect(sessionState(session).advisorReviewPending).toBe(false);
    } finally {
      retry.resolve(true);
      status.mockRestore();
      catchup.mockRestore();
      waitIdle.mockRestore();
    }
  });

});
