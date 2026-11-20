/**
 * Environment variables injected into the `omp` child process (issue #104).
 *
 * The values live in keylime's own settings file (~/.omp/agent/keylime-settings.json,
 * see lib/web-settings.ts) — omp's config.yml stays omp's. `getAgentEnvOverrides()`
 * is what lib/hosts/local-host.ts passes as the spawn env overrides; it runs inside the
 * spawn path, so it must never throw: a missing, unreadable or hand-edited settings
 * file yields `{}` and the child simply inherits process.env unchanged.
 *
 * Operators configure these values locally; linked settings never carry them.
 */
import { loadLocalAgentEnv } from "../web-settings";

export {
  formatAgentEnvText,
  isDeniedAgentEnvName,
  parseAgentEnvText,
  sanitizeAgentEnvValues,
  type AgentEnvErrorLabels,
  type AgentEnvParseResult,
} from "./agent-env-policy";

/**
 * Environment overrides for the `omp` child process, from keylime's settings file.
 * Never throws: unreadable settings fall back to `{}` so spawning is unaffected.
 * Values from hand-edited files still pass through the reserved-name policy.
 */
export function getAgentEnvOverrides(): Record<string, string> {
  try {
    return loadLocalAgentEnv();
  } catch {
    return {};
  }
}
