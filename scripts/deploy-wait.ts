export const ACTIVATION_WAIT_MS = 60_000;

/** A busy host is retryable; unavailable/old control protocols are not proof of idleness. */
export async function waitForIdleDrain(
  drain: (deadline: number) => Promise<void>,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onBusy?: () => void;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  const deadline = now() + (options.timeoutMs ?? ACTIVATION_WAIT_MS);
  do {
    try {
      await drain(deadline);
      return now() < deadline;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "host_busy"
      )
        throw error;
    }
    options.onBusy?.();
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(1000, remaining));
  } while (now() < deadline);
  return false;
}
