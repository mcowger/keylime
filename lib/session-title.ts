/**
 * Session title derivation. omp auto-generates titles itself (persisted in the
 * fixed-width title slot), so unlike pi-web there is no in-process LLM title
 * run here — the auto-name endpoint returns the stored/live title when one
 * exists and otherwise derives a fallback from the first user message.
 */

const MAX_DERIVED_TITLE_LENGTH = 60;

const TITLE_STOP_WORDS: Record<string, true> = {
  a: true, an: true, and: true, are: true, as: true, at: true, be: true,
  can: true, could: true, do: true, for: true, from: true, how: true,
  i: true, in: true, is: true, it: true, me: true, my: true, of: true,
  on: true, or: true, please: true, the: true, this: true, to: true,
  we: true, what: true, when: true, with: true, you: true,
};

/** A temporary topic label, not a persisted or model-generated session name. */
export function temporarySessionTitle(firstMessage: string | undefined): string | null {
  if (!firstMessage || firstMessage === "(no messages)") return null;
  const words = firstMessage.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];
  const chosen: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    const key = word.toLocaleLowerCase("en");
    if (Object.hasOwn(TITLE_STOP_WORDS, key) || seen.has(key)) continue;
    seen.add(key);
    chosen.push(Array.from(word).slice(0, 24).join(""));
    if (chosen.length === 4) break;
  }
  return chosen.length ? chosen.join(" · ") : null;
}

/** First-line, control-character-free, whitespace-collapsed view of a title. */
export function sanitizeSessionTitle(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const firstLine = value.split(/\r?\n/)[0] ?? "";
  const stripped = firstLine
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * Derive a fallback title from a session's first user message: first line,
 * truncated to ~60 characters by code points. Returns null when the message
 * has no usable text (e.g. "(no messages)").
 */
export function deriveSessionTitleFromFirstMessage(
  firstMessage: string | undefined,
): string | null {
  if (!firstMessage || firstMessage === "(no messages)") return null;
  const sanitized = sanitizeSessionTitle(firstMessage);
  if (!sanitized || !/[\p{L}\p{N}]/u.test(sanitized)) return null;

  const characters = Array.from(sanitized);
  if (characters.length <= MAX_DERIVED_TITLE_LENGTH) return sanitized;
  return `${characters.slice(0, MAX_DERIVED_TITLE_LENGTH).join("").trimEnd()}…`;
}
