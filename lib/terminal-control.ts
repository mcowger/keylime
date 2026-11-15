// Apply the touch Ctrl latch to one typed character, leaving paste and escape
// sequences unchanged until a character or accessory key consumes the latch.
export function applyTerminalControl(
  data: string,
  latched: boolean,
): { data: string; consumed: boolean } {
  if (!latched || data.length !== 1) return { data, consumed: false };
  const code = data.toUpperCase().charCodeAt(0);
  if (data === " ") data = "\x00";
  else if (code >= 51 && code <= 55) data = String.fromCharCode(code - 51 + 27);
  else if (data === "8" || data === "?") data = "\x7f";
  else if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
  return { data, consumed: true };
}
