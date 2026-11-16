"use strict";

// Shared systemd EnvironmentFile helpers for the keylime Linux service.
// Runtime settings live in ~/.omp/agent/web-service.env so changing the
// port, bind address, or password does not require regenerating the unit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getServiceEnvPath(home = os.homedir()): string {
  const configuredDir = process.env.PI_CODING_AGENT_DIR?.replace(
    /^~(?=\/|$)/,
    home,
  );
  return path.join(
    configuredDir || path.join(home, ".omp", "agent"),
    "web-service.env",
  );
}

// Escape a value for a double-quoted systemd env-file assignment.
export function escapeEnvValue(value: unknown): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ");
}

export function serializeServiceEnv(entries: Record<string, unknown>): string {
  return (
    Object.entries(entries)
      .map(([key, value]) => `${key}="${escapeEnvValue(value)}"`)
      .join("\n") + "\n"
  );
}

// Parse KEY="value" lines. Tolerate comments, blank lines, and unquoted
// values so the file can also be edited by hand.
export function parseServiceEnv(text: unknown): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    if (quoted) value = value.slice(1, -1);
    entries[key] = value.replace(/\\(["\\])/g, "$1");
  }
  return entries;
}

export function readServiceEnv(
  envPath = getServiceEnvPath(),
): Record<string, string> {
  try {
    return parseServiceEnv(fs.readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

// Atomic write, user-readable only: this file may contain the web password.
export function writeServiceEnv(
  entries: Record<string, unknown>,
  envPath = getServiceEnvPath(),
): string {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const temporary = `${envPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, serializeServiceEnv(entries), { mode: 0o600 });
  fs.renameSync(temporary, envPath);
  fs.chmodSync(envPath, 0o600);
  return envPath;
}
