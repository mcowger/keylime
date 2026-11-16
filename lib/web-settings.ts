import type { WebServerSettings as ContractWebServerSettings } from "./api-contracts/configuration-models";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import {
  BROWSER_TRANSPORTS,
  type BrowserTransportState,
} from "./event-stream-protocol";
import {
  DEFAULT_UPLOAD_RETENTION_DAYS,
  isUploadRetentionDays,
} from "./upload-limits";
import { isRecord } from "./type-guards";

/** keylime's own server-side settings (omp's config.yml stays omp's). */
export type WebServerSettings = ContractWebServerSettings;

const DEFAULTS: WebServerSettings = {
  autoResumeSessions: false,
  agentToolsEnabled: false,
  agentEnv: {},
  browserTransport: "ws",
  uploadRetentionDays: DEFAULT_UPLOAD_RETENTION_DAYS,
};

/** What every hello and `transport` frame tells the browser. */
export function browserTransportState(
  settings = loadWebServerSettings(),
): BrowserTransportState {
  return { transport: settings.browserTransport };
}

/** String-valued entries only — the allow-list lives in lib/omp/agent-env.ts. */
function readAgentEnvRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, string]> = [];
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") entries.push([name, entry]);
  }
  return Object.fromEntries(entries);
}

function settingsPath(): string {
  return resolve(getAgentDir(), "keylime-settings.json");
}

declare global {
  // Survives `bun --hot` re-evaluation, which creates fresh module instances.
  var __keylimeSettingsCache:
    { path: string; settings: WebServerSettings } | undefined;
}

export function loadWebServerSettings(): WebServerSettings {
  const path = settingsPath();
  const cached = globalThis.__keylimeSettingsCache;
  if (cached?.path === path) return cached.settings;
  let settings = DEFAULTS;
  try {
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(raw)) {
        settings = {
          autoResumeSessions: raw.autoResumeSessions === true,
          agentToolsEnabled: raw.agentToolsEnabled === true,
          agentEnv: readAgentEnvRecord(raw.agentEnv),
          browserTransport:
            BROWSER_TRANSPORTS.find(
              (transport) => transport === raw.browserTransport,
            ) ?? "ws",
          uploadRetentionDays: isUploadRetentionDays(raw.uploadRetentionDays)
            ? raw.uploadRetentionDays
            : DEFAULT_UPLOAD_RETENTION_DAYS,
        };
      }
    }
  } catch {
    // Unreadable settings fall back to the defaults.
  }
  globalThis.__keylimeSettingsCache = { path, settings };
  return settings;
}

/** Atomic write (temp file + rename), like the project registry. Private to its user: it holds agentEnv. */
export function saveWebServerSettings(
  patch: Partial<WebServerSettings>,
): WebServerSettings {
  const path = settingsPath();
  const settings = { ...loadWebServerSettings(), ...patch };
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
  globalThis.__keylimeSettingsCache = { path, settings };
  return settings;
}
