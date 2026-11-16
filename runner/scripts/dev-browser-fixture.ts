import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { launchHeadlessBrowser, closeLaunchedBrowser, removeUserDataDir, type LaunchHeadlessResult } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, releaseBrowser, type BrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { createHostedAgentSession } from "../src/session";
import { getSessionDirNameForCwd, getSessionsDir } from "../../lib/omp/paths";

const root = process.env.KEYLIME_UI_FIXTURE_ROOT;
if (!root || process.env.HOME !== path.join(root, "home") ||
    process.env.PI_CODING_AGENT_DIR !== path.join(root, "home", ".omp", "agent"))
  throw new Error("Browser fixture requires the isolated dev launcher");

const cwd = realpathSync(path.join(root, "projects", "atlas"));
const sessionFile = path.join(getSessionsDir(), getSessionDirNameForCwd(cwd), "2026-01-01_11111111-1111-4111-8111-111111111111.jsonl");
const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
auth.keys.setRuntime("mock", "fixture-key");
const mock = createMockModel({ responses: [] });
const { session } = await createHostedAgentSession({
  cwd,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  modelRegistry: new ModelRegistry(auth),
  model: mock,
  sessionManager: await SessionManager.open(sessionFile, undefined, undefined, { throwIfMissing: true }),
  settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false, "todo.reminders": false }),
  disableExtensionDiscovery: true,
  skills: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  enableMCP: false, enableLsp: false, skipPythonPreflight: true, hasUI: true, toolNames: [],
});
session.agent.streamFn = mock.stream;
let launched: LaunchHeadlessResult | undefined;
let browser: BrowserHandle | undefined;
try {
  launched = await launchHeadlessBrowser({ headless: true, viewport: { width: 1280, height: 720 } });
  const endpoint = new URL(launched.wsEndpoint);
  browser = await acquireBrowser({ kind: "connected", cdpUrl: `http://${endpoint.host}` }, { cwd });
  await acquireTab("keylime-dev-fixture", browser, {
    url: pathToFileURL(path.join(cwd, "browser-fixture.html")).href,
    waitUntil: "load", viewport: { width: 1280, height: 720 }, timeoutMs: 30000,
    ownerSessionId: session.getEvalKernelOwnerId(), persist: true,
  });
  console.log("[dev] Browser fixture ready: atlas → Plan the Atlas project → Browser");
  const { promise, resolve } = Promise.withResolvers<void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, resolve);
  await promise;
} finally {
  await releaseTab("keylime-dev-fixture", { kill: false }).catch(() => {});
  if (browser) await releaseBrowser(browser, { kill: false }).catch(() => {});
  if (launched) {
    await closeLaunchedBrowser(launched.browser).catch(() => {});
    if (launched.userDataDir) await removeUserDataDir(launched.userDataDir).catch(() => {});
  }
  await session.dispose();
  auth.close();
}
