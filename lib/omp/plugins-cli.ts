export const ANSI_RE = /\x1B\[[0-9;]*m/g;

/** Parse `--json` stdout, tolerating stray non-JSON lines before the payload. */
export function parseJsonLoose<T>(stdout: string): T | null {
  const cleaned = stdout.replace(ANSI_RE, "");
  const start = cleaned.search(/[{[]/);
  if (start < 0) return null;
  try {
    return JSON.parse(cleaned.slice(start)) as T;
  } catch {
    return null;
  }
}
