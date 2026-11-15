"use strict";

// Child processes use the same Bun executable as their parent.
export function resolveBunBinary(..._args: unknown[]): string {
  return process.execPath;
}
