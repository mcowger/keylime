import "../tests/setup-dom.ts";
import assert from "node:assert/strict";
import test from "node:test";
const { act, cleanup, renderHook } =
  await import("@testing-library/react/pure.js");

const { useProviderUsage, usageBucketLabel } =
  await import("./AppShell-provider-usage");

test("usageBucketLabel distinguishes Anthropic tiers and Antigravity buckets (#284)", () => {
  assert.equal(
    usageBucketLabel({ provider: "anthropic", tier: "fable" }),
    "Fable",
  );
  assert.equal(usageBucketLabel({ provider: "anthropic" }), undefined);
  assert.equal(
    usageBucketLabel({ provider: "google-antigravity", bucket: "Gemini" }),
    "Gemini",
  );
  assert.equal(
    usageBucketLabel({
      provider: "google-antigravity",
      bucket: "Claude & GPT (shared)",
    }),
    "Claude & GPT (shared)",
  );
  assert.equal(
    usageBucketLabel({
      provider: "google-antigravity",
      bucket: "Gemini",
      tier: "pro",
    }),
    "Gemini",
  );
  // Other providers' tiers are quota tiers, not bucket names.
  assert.equal(
    usageBucketLabel({ provider: "openai-codex", tier: "pro" }),
    undefined,
  );
});
const snapshot = (percent: number) => ({
  reports: [{ provider: "provider", fiveHour: { percent } }],
});

test("manual refresh gets fresh limits on older browsers while automatic polling stays silent", async () => {
  const originalFetch = globalThis.fetch;
  const originalInterval = window.setInterval;
  const originalClear = window.clearInterval;
  const sizeDescriptor = Object.getOwnPropertyDescriptor(
    URLSearchParams.prototype,
    "size",
  );
  const timers: { poll?: () => void } = {};
  let finishPoll: { resolve?: () => void } | undefined;
  let freshPercent = 10;
  let cachedPercent = 10;
  try {
    Reflect.deleteProperty(URLSearchParams.prototype, "size");
    Object.defineProperty(window, "setInterval", {
      configurable: true,
      writable: true,
      value: (callback: TimerHandler) => {
        assert.equal(typeof callback, "function");
        timers.poll = callback as () => void;
        return 1;
      },
    });
    window.clearInterval = () => {};
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (url: RequestInfo | URL) => {
        if (
          new URL(String(url), "http://localhost").searchParams.get(
            "refresh",
          ) === "true"
        )
          cachedPercent = freshPercent;
        if (finishPoll) {
          const pending = finishPoll;
          const { promise, resolve } = Promise.withResolvers<void>();
          pending.resolve = resolve;
          await promise;
        }
        return Response.json(snapshot(cachedPercent));
      },
    });
    const { result, unmount } = renderHook(() => useProviderUsage("", 300_000));
    await act(async () => {});
    assert.equal(result.current.snapshot?.reports[0].fiveHour?.percent, 10);
    freshPercent = 80;
    finishPoll = {};
    assert.ok(timers.poll);
    const runPoll = timers.poll;
    act(() => runPoll());
    assert.equal(
      result.current.loading,
      false,
      "background polling must not change the loading state",
    );
    assert.equal(result.current.snapshot?.reports[0].fiveHour?.percent, 10);
    await act(async () => {
      assert.ok(finishPoll?.resolve);
      finishPoll.resolve();
    });
    finishPoll = undefined;
    assert.equal(
      result.current.snapshot?.reports[0].fiveHour?.percent,
      10,
      "automatic polling must not force cache invalidation",
    );
    let refreshed;
    await act(async () => {
      refreshed = await result.current.refresh();
    });
    assert.equal(refreshed, true);
    assert.equal(
      result.current.snapshot?.reports[0].fiveHour?.percent,
      80,
      "manual refresh must request fresh limits even without URLSearchParams.size",
    );
    freshPercent = 95;
    finishPoll = {};
    act(() => runPoll());
    let queuedRefresh!: Promise<boolean>;
    act(() => {
      queuedRefresh = result.current.refresh();
    });
    await act(async () => {
      const resolve = finishPoll?.resolve;
      assert.ok(resolve);
      finishPoll = undefined;
      resolve();
      assert.equal(await queuedRefresh, true);
    });
    assert.equal(
      result.current.snapshot?.reports[0].fiveHour?.percent,
      95,
      "manual refresh during a background poll must still fetch fresh limits",
    );
    finishPoll = {};
    let cancelled;
    act(() => {
      cancelled = result.current.refresh();
    });
    unmount();
    await act(async () => {
      assert.ok(finishPoll?.resolve);
      finishPoll.resolve();
    });
    assert.equal(
      await cancelled,
      false,
      "an unmounted refresh cannot report success",
    );
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    window.setInterval = originalInterval;
    window.clearInterval = originalClear;
    if (sizeDescriptor)
      Object.defineProperty(URLSearchParams.prototype, "size", sizeDescriptor);
  }
});
