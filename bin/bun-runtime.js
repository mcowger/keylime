"use strict";

// Child processes use the same Bun executable as their parent.
function resolveBunBinary() {
  return process.execPath;
}

module.exports = { resolveBunBinary };
