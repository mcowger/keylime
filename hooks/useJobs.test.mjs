import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mergeJobOutput } from "./useJobs.ts";
import { useJobs } from "./useJobs.ts";
const { act, cleanup, renderHook, waitFor } =
  await import("@testing-library/react/pure.js");

const frame = (output, start, cursor, truncated = false) => ({
  id: "j",
  incarnation: "j-first",
  kind: "bash",
  generation: "g",
  pids: [],
  open: true,
  output,
  start,
  cursor,
  truncated,
});

test("output deltas preserve the tail, while gaps and snapshots replace it", () => {
  let tail = mergeJobOutput(
    { text: "", cursor: 0, truncated: false },
    frame("abc", 0, 3),
  );
  tail = mergeJobOutput(tail, frame("de", 3, 5));
  assert.equal(tail.text, "abcde");
  tail = mergeJobOutput(tail, frame("new", 9, 12, true));
  assert.deepEqual(tail, { text: "new", cursor: 12, truncated: true });
  tail = mergeJobOutput(tail, frame("snapshot", 0, 8));
  assert.deepEqual(tail, { text: "snapshot", cursor: 8, truncated: false });
});

test("oversized output is bounded and remains marked truncated across deltas", () => {
  let tail = mergeJobOutput(
    { text: "", cursor: 0, truncated: false },
    frame("x".repeat(262145), 0, 262145),
  );
  assert.equal(tail.text.length, 262144);
  assert.equal(tail.truncated, true);
  tail = mergeJobOutput(tail, frame("y", 262145, 262146));
  assert.equal(tail.text.length, 262144);
  assert.equal(tail.text.at(-1), "y");
  assert.equal(tail.truncated, true);
});

test("lost rosters disable cancellation and evicted running jobs become unavailable", async () => {
  const job = {
    id: "j",
    incarnation: "j-first",
    kind: "bash",
    status: "running",
    label: "job",
    startTime: 1,
    canCancel: true,
  };
  let roster = { available: true, generation: "g", jobs: [job], services: [] };
  let cancellations = 0;
  globalThis.fetch = async (_url, init) => {
    const command = JSON.parse(init.body);
    if (command.type === "cancel_job") cancellations++;
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: command.type === "get_jobs" ? roster : frame("live", 0, 4),
      }),
    };
  };
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  try {
    const view = renderHook(() => useJobs("s1", true));
    await flush();
    act(() => view.result.current.select(job));
    await flush();
    assert.equal(view.result.current.selected.canCancel, true);
    roster = { available: false, generation: "", jobs: [], services: [] };
    act(() => view.result.current.refresh());
    await flush();
    assert.equal(view.result.current.snapshot.jobs.length, 1);
    assert.equal(view.result.current.selected.canCancel, false);
    await act(async () => {
      await view.result.current.cancel();
    });
    assert.equal(cancellations, 0);
    roster = { available: true, generation: "g", jobs: [], services: [] };
    act(() => view.result.current.refresh());
    await flush();
    assert.equal(view.result.current.selected.status, "unavailable");
    assert.equal(view.result.current.selected.canCancel, false);
  } finally {
    cleanup();
    delete globalThis.fetch;
  }
});

for (const outcome of ["reject", "refuse"]) {
  test(`cancellation ${outcome} releases ownership while Jobs is hidden`, async () => {
    const job = {
      id: "j",
      incarnation: "j-first",
      kind: "bash",
      status: "running",
      label: "job",
      startTime: 1,
      canCancel: true,
    };
    const roster = {
      available: true,
      generation: "g",
      jobs: [job],
      services: [],
    };
    const originalFetch = globalThis.fetch;
    let settle;
    let cancellations = 0;
    const response = (data) => ({
      ok: true,
      json: async () => ({ success: true, data }),
    });
    globalThis.fetch = async (_url, init) => {
      const command = JSON.parse(init.body);
      if (command.type === "cancel_job") {
        cancellations++;
        if (cancellations === 1)
          return new Promise((resolve, reject) => {
            settle = () =>
              outcome === "reject"
                ? reject(new Error("Cancellation refused"))
                : resolve(response({ requested: false }));
          });
        return response({ requested: false });
      }
      return response(
        command.type === "get_jobs" ? roster : frame("live", 0, 4),
      );
    };
    try {
      const view = renderHook(({ enabled }) => useJobs("s1", enabled), {
        initialProps: { enabled: true },
      });
      await waitFor(() =>
        assert.equal(view.result.current.snapshot?.available, true),
      );
      await act(async () => {
        view.result.current.select(job);
      });
      await waitFor(() =>
        assert.equal(view.result.current.selected.canCancel, true),
      );
      let cancellation;
      act(() => {
        cancellation = view.result.current.cancel();
      });
      await waitFor(() => assert.equal(cancellations, 1));
      assert.equal(view.result.current.selected.canCancel, false);
      view.rerender({ enabled: false });
      await act(async () => {
        settle();
        await cancellation;
      });
      view.rerender({ enabled: true });
      await waitFor(() =>
        assert.equal(view.result.current.selected.canCancel, true),
      );
      await act(async () => {
        await view.result.current.cancel();
      });
      assert.equal(cancellations, 2);
    } finally {
      cleanup();
      globalThis.fetch = originalFetch;
    }
  });
}

test("a reused job ID cannot replace retained completion output or inherit its cancellation", async () => {
  const completed = {
    id: "j",
    incarnation: "j-first",
    kind: "task",
    status: "completed",
    label: "first task",
    startTime: 1,
    endTime: 2,
    canCancel: false,
  };
  const replacement = {
    ...completed,
    incarnation: "j-second",
    status: "running",
    label: "replacement task",
    startTime: 3,
    endTime: undefined,
    canCancel: true,
  };
  let roster = {
    available: true,
    generation: "g",
    jobs: [completed],
    services: [],
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const command = JSON.parse(init.body);
    calls.push(command);
    const data =
      command.type === "get_jobs"
        ? roster
        : command.type === "cancel_job"
          ? { requested: false }
          : {
              ...frame(
                command.incarnation === completed.incarnation
                  ? "first final output"
                  : "replacement output",
                0,
                18,
              ),
              kind: "task",
              incarnation: command.incarnation,
            };
    return { ok: true, json: async () => ({ success: true, data }) };
  };
  try {
    const view = renderHook(() => useJobs("s1", true));
    await waitFor(() =>
      assert.equal(
        view.result.current.snapshot?.jobs[0].incarnation,
        completed.incarnation,
      ),
    );
    act(() => view.result.current.select(completed));
    await waitFor(() =>
      assert.equal(view.result.current.output, "first final output"),
    );
    roster = { ...roster, jobs: [replacement] };
    act(() => view.result.current.refresh());
    await waitFor(() =>
      assert.equal(
        view.result.current.snapshot.jobs[0].incarnation,
        replacement.incarnation,
      ),
    );
    assert.equal(
      view.result.current.selected.incarnation,
      completed.incarnation,
    );
    assert.equal(view.result.current.output, "first final output");
    assert.equal(view.result.current.selected.canCancel, false);
    assert.equal(
      calls.some(
        (call) =>
          call.type === "get_job_output" &&
          call.incarnation === replacement.incarnation,
      ),
      false,
    );
    act(() => view.result.current.select(replacement));
    await waitFor(() =>
      assert.equal(view.result.current.output, "replacement output"),
    );
    await act(async () => {
      await view.result.current.cancel();
    });
    assert.equal(
      calls.find((call) => call.type === "cancel_job")?.incarnation,
      replacement.incarnation,
    );
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});
