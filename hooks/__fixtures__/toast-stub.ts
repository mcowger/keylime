// Test stub for components/ui/toast.tsx: the DOM-backed toast must never fire
// inside these tests. Calls are
// recorded so tests can assert what the user was told.
export const toastCalls: Array<["success" | "error" | "info", ...unknown[]]> =
  [];
export const toast = {
  success(...args: unknown[]) {
    toastCalls.push(["success", ...args]);
  },
  error(...args: unknown[]) {
    toastCalls.push(["error", ...args]);
  },
  info(...args: unknown[]) {
    toastCalls.push(["info", ...args]);
  },
  close() {},
};
export default toast;
