/**
 * OMP profile-name validation, mirroring the omp CLI's own rule so a profile
 * saved here can never make the spawned `omp --profile …` child exit at startup
 * (which surfaces in the UI as an HTTP 500 on the first message).
 *
 * Names must match ^[a-z0-9][a-z0-9._-]{0,63}$, cannot end with a dot,
 * and cannot be a reserved device name (including names with extensions).
 */

// JavaScript's `$` also matches before a final newline; the CLI requires the
// entire name to match, including for untrimmed values read from disk.
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}(?![\s\S])/;

// omp rejects these names on every platform.
const RESERVED_PROFILE_BASE = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);


/** True when `name` is a profile name omp will accept (empty input is "no profile" and valid). */
export function isValidOmpProfile(name: string): boolean {
  if (!name) return true;
  if (!PROFILE_NAME_PATTERN.test(name)) return false;
  // A leading dot is already impossible (the pattern starts with [a-z0-9]),
  // so only a trailing dot remains to reject here.
  return !name.endsWith(".") && !RESERVED_PROFILE_BASE.has(name.split(".")[0]);
}
