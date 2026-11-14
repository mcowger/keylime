import { expect, test } from "bun:test";
import { ACTIVATION_WAIT_MS, waitForIdleDrain } from "./deploy-wait";

test("activation reaches its force-cutover deadline after 60 seconds of busy work", async () => {
  let clock = 0;
  let attempts = 0;
  const result = await waitForIdleDrain(
    async () => {
      attempts++;
      throw Object.assign(new Error("active run"), { code: "host_busy" });
    },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  expect(result).toBe(false);
  expect(clock).toBe(60_000);
  expect(ACTIVATION_WAIT_MS).toBe(60_000);
  expect(attempts).toBe(60);
});

test("activation proceeds when busy work settles before its deadline", async () => {
  let clock = 0;
  let calls = 0;
  const result = await waitForIdleDrain(
    async () => {
      if (++calls < 3)
        throw Object.assign(new Error("busy"), { code: "host_busy" });
    },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  expect(result).toBe(true);
  expect(clock).toBe(2000);
});

test("an unavailable daemon is never treated as idle", async () => {
  await expect(
    waitForIdleDrain(async () => {
      throw new Error("unknown control command");
    }),
  ).rejects.toThrow("unknown control command");
});
