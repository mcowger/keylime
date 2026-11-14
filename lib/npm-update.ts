import packageJson from "../package.json";
import { releaseRepo } from "./release-repo";
import { isUpdateDisabled } from "./update-policy";
import { isNewerVersion } from "./version-compare";

const NPM_PACKAGE = "@kahme247/ompweb";
const CHECK_TTL_MS = 60 * 60 * 1000;

export interface NpmUpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  /** "binary": the compiled release (scripts/build-binary.ts), which updates by download, not by a package manager. */
  installMethod: "bun" | "binary";
  /** The terminal command that updates this install; for "binary", the release download page. */
  updateCommand: string;
  updatesDisabled?: boolean;
}

let cached: { checkedAt: number; status: NpmUpdateStatus } | null = null;

export async function checkNpmUpdate(force = false): Promise<NpmUpdateStatus> {
  const currentVersion = packageJson.version;
  const installMethod = Bun.isStandaloneExecutable ? "binary" : "bun";
  const updateCommand = installMethod === "binary" ? `https://github.com/${releaseRepo()}/releases/latest` : "bun add -g @kahme247/ompweb";

  if (isUpdateDisabled()) {
    return { currentVersion, availableVersion: null, updateAvailable: false, installMethod, updateCommand, updatesDisabled: true };
  }
  if (!force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.status;

  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const data = response.ok ? await response.json() as { version?: unknown } : null;
    const availableVersion = typeof data?.version === "string" ? data.version : null;
    const status: NpmUpdateStatus = {
      currentVersion,
      availableVersion,
      updateAvailable: Boolean(availableVersion && isNewerVersion(availableVersion, currentVersion)),
      installMethod,
      updateCommand,
    };
    cached = { checkedAt: Date.now(), status };
    return status;
  } catch {
    return { currentVersion, availableVersion: null, updateAvailable: false, installMethod, updateCommand };
  }
}

