import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { render, fireEvent, cleanup, waitFor, act } =
  await import("@testing-library/react/pure.js");
const { JobsPanel } = await import("./JobsPanel");
type JobCommand = {
  type: string;
  id?: string;
  incarnation?: string;
  generation?: string;
  session?: string;
};

afterEach(cleanup);

test("mobile inspector shows sanitized output, pauses follow, and cancels the selected job", async (t) => {
  const calls: JobCommand[] = [];
  const job = {
    id: "j1",
    incarnation: "i1",
    kind: "bash",
    status: "running",
    label: "Build",
    command: "make",
    ownerId: "s1",
    startTime: Date.now(),
    canCancel: true,
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, options?: RequestInit) => {
      const command: JobCommand = JSON.parse(String(options?.body));
      calls.push(command);
      const data =
        command.type === "get_jobs"
          ? { generation: "g1", jobs: [job], services: [], available: true }
          : command.type === "get_job_output"
            ? {
                id: "j1",
                incarnation: "i1",
                kind: "bash",
                generation: "g1",
                command: "make",
                cwd: "/work",
                pids: [42],
                output: "\u001b[31mhello\u001b[0m",
                start: 0,
                cursor: 14,
                open: true,
                truncated: true,
              }
            : { requested: true };
      return Response.json({ success: true, data });
    },
  );
  const view = render(
    React.createElement(JobsPanel, {
      sessionId: "s1",
      enabled: true,
      isMobile: true,
    }),
  );
  fireEvent.click(await view.findByRole("button", { name: /Build/ }));
  await view.findByText("hello");
  assert.ok(view.getByText("/work"));
  assert.ok(
    calls.some(
      (call) =>
        call.type === "get_job_output" &&
        call.id === "j1" &&
        call.incarnation === "i1",
    ),
  );
  assert.ok(view.getByText("Earlier output was truncated."));
  const output = view.getByText("hello");
  Object.defineProperties(output, {
    scrollHeight: { value: 100 },
    clientHeight: { value: 20 },
    scrollTop: { value: 0, writable: true },
  });
  fireEvent.scroll(output);
  assert.equal(
    (view.getByRole("checkbox", { name: "Follow output" }) as HTMLInputElement)
      .checked,
    false,
  );
  fireEvent.click(view.getByRole("button", { name: "Cancel job" }));
  await waitFor(() =>
    assert.ok(
      calls.some(
        (call) =>
          call.type === "cancel_job" &&
          call.id === "j1" &&
          call.incarnation === "i1" &&
          call.generation === "g1",
      ),
    ),
  );
  fireEvent.click(view.getByRole("button", { name: "Back to jobs" }));
  assert.equal(view.queryByText("hello"), null);
});

test("a pending cancellation from an old session does not block or disrupt the new session", async (t) => {
  const calls: JobCommand[] = [];
  const { promise: oldCancel, reject: rejectOld } =
    Promise.withResolvers<Response>();
  const { promise: newCancel, resolve: resolveNew } =
    Promise.withResolvers<Response>();
  const jobs = {
    s1: {
      id: "j1",
      incarnation: "i1",
      kind: "bash",
      status: "running",
      label: "Old job",
      startTime: Date.now(),
      canCancel: true,
    },
    s2: {
      id: "j2",
      incarnation: "i2",
      kind: "bash",
      status: "running",
      label: "New job",
      startTime: Date.now(),
      canCancel: true,
    },
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (url: RequestInfo | URL, options?: RequestInit) => {
      const session = String(url).includes("/s1") ? "s1" : "s2";
      const command: JobCommand = JSON.parse(String(options?.body));
      calls.push({ session, ...command });
      const job = jobs[session];
      if (command.type === "cancel_job")
        return session === "s1" ? oldCancel : newCancel;
      const data =
        command.type === "get_jobs"
          ? { generation: "g1", jobs: [job], services: [], available: true }
          : {
              id: job.id,
              incarnation: job.incarnation,
              kind: job.kind,
              generation: "g1",
              pids: [],
              output: "",
              start: 0,
              cursor: 0,
              open: true,
              truncated: false,
            };
      return Response.json({ success: true, data });
    },
  );
  const props = { sessionId: "s1", enabled: true, isMobile: false };
  const view = render(React.createElement(JobsPanel, props));
  fireEvent.click(await view.findByRole("button", { name: /Old job/ }));
  fireEvent.click(await view.findByRole("button", { name: "Cancel job" }));
  await waitFor(() =>
    assert.ok(
      calls.some(
        (call) =>
          call.type === "cancel_job" &&
          call.session === "s1" &&
          call.incarnation === "i1",
      ),
    ),
  );

  view.rerender(React.createElement(JobsPanel, { ...props, sessionId: "s2" }));
  fireEvent.click(await view.findByRole("button", { name: /New job/ }));
  fireEvent.click(await view.findByRole("button", { name: "Cancel job" }));
  await waitFor(() =>
    assert.ok(
      calls.some(
        (call) =>
          call.type === "cancel_job" &&
          call.session === "s2" &&
          call.id === "j2" &&
          call.incarnation === "i2",
      ),
    ),
  );

  await act(async () => {
    rejectOld(new Error("old cancellation failed"));
    await oldCancel.catch(() => {});
  });
  assert.equal(view.queryByText("old cancellation failed"), null);
  assert.ok(view.getAllByText("New job", { selector: "strong" }).length > 0);
  await act(async () => {
    resolveNew(Response.json({ success: true, data: { requested: false } }));
    await newCancel;
  });
  assert.ok(await view.findByRole("button", { name: "Cancel job" }));
});

test("unavailable sessions are not presented as an empty job list", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: { generation: "", jobs: [], services: [], available: false },
    }),
  );
  const view = render(
    React.createElement(JobsPanel, {
      sessionId: "s1",
      enabled: true,
      isMobile: false,
    }),
  );
  assert.ok(await view.findByText("Jobs are unavailable for this session."));
  assert.equal(view.queryByText("No jobs in this session."), null);
});
