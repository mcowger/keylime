/**
 * Client-safe comparable form for project/session paths.
 *
 * Pure string normalization — no node:path or process.platform — so it can
 * be imported from browser components and server modules.
 * Callers always pass absolute paths, so no cwd resolution is needed.
 */

export function comparableProjectPath(value: string): string {
  return value.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}
