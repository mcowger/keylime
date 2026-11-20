import type {
  BrowserSettings,
  HostSettings,
  HostSettingsPatch,
} from "./api-contracts/configuration-models";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "./omp/paths";
import { sanitizeAgentEnvValues } from "./omp/agent-env-policy";
import { type BrowserTransportState } from "./event-stream-protocol";
import { isUploadRetentionDays } from "./upload-limits";
import { isRecord } from "./type-guards";

function hostSettingsPath(): string {
  return resolve(getAgentDir(), "keylime-settings.json");
}

function browserSettingsPath(): string {
  return resolve(getAgentDir(), "keylime-browser-settings.json");
}

function readSettings(path: string, preserve = false): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(value)) return value;
    if (preserve) throw new Error("Settings file must contain an object");
  } catch (error) {
    if (preserve && (!isRecord(error) || error.code !== "ENOENT")) {
      throw new Error(
        "Cannot read daemon settings; the existing file was not changed",
      );
    }
    // Missing or unreadable settings use defaults for reads, not writes.
  }
  return {};
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function hostPolicy(raw: Record<string, unknown>): HostSettings {
  const days = isUploadRetentionDays(raw.uploadRetentionDays)
    ? raw.uploadRetentionDays
    : readSettings(resolve(getAgentDir(), "keylime", "upload-retention.json"))
        .days;
  return {
    autoResumeSessions: raw.autoResumeSessions === true,
    agentToolsEnabled: raw.agentToolsEnabled === true,
    uploadRetentionDays: isUploadRetentionDays(days) ? days : null,
  };
}

export function loadHostSettings(): HostSettings {
  return hostPolicy(readSettings(hostSettingsPath()));
}

export function parseHostSettingsPatch(
  value: unknown,
): HostSettingsPatch | null {
  if (!isRecord(value)) return null;
  const patch: HostSettingsPatch = {};
  for (const [key, entry] of Object.entries(value)) {
    switch (key) {
      case "autoResumeSessions":
      case "agentToolsEnabled":
        if (typeof entry !== "boolean") return null;
        patch[key] = entry;
        break;
      case "uploadRetentionDays":
        if (!isUploadRetentionDays(entry)) return null;
        patch[key] = entry;
        break;
      default:
        return null;
    }
  }
  return patch;
}

export function saveHostSettings(value: unknown): HostSettings {
  const patch = parseHostSettingsPatch(value);
  if (!patch) throw new TypeError("Invalid host settings patch");
  const path = hostSettingsPath();
  const raw = readSettings(path, Object.keys(patch).length > 0);
  const settings = { ...hostPolicy(raw), ...patch };
  if (Object.keys(patch).length) writeSettings(path, { ...raw, ...patch });
  return settings;
}

/** Operator-managed in the daemon's local settings file, never part of a wire payload. */
export function loadLocalAgentEnv(): Record<string, string> {
  const { agentEnv } = readSettings(hostSettingsPath());
  if (!isRecord(agentEnv)) return {};
  return sanitizeAgentEnvValues(
    Object.fromEntries(
      Object.entries(agentEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  ).values;
}

export function loadBrowserSettings(): BrowserSettings {
  const { browserTransport } = readSettings(browserSettingsPath());
  return { browserTransport: browserTransport === "sse" ? "sse" : "ws" };
}

export function saveBrowserSettings(
  settings: BrowserSettings,
): BrowserSettings {
  const { browserTransport } = settings;
  writeSettings(browserSettingsPath(), { browserTransport });
  return { browserTransport };
}

export function browserTransportState(
  settings = loadBrowserSettings(),
): BrowserTransportState {
  return { transport: settings.browserTransport };
}
