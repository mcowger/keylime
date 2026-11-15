import { getGitHubReleaseNotes } from "@/lib/github-release-notes";
import { checkNpmUpdate } from "@/lib/npm-update";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function noContent(): Response {
  return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
}

/**
 * @apiContract getAppUpdateNotes
 * @apiUsage Fetch release notes for the currently available web application update.
 * @apiInputs No parameters; the available version comes from the normal cached update check.
 * @apiInvariants The response is no-store. Notes are returned only when their version matches the available update; otherwise the response is 204.
 * @apiEffects May contact the package registry and release service; no update is started.
 * @apiRecovery Missing notes and lookup failures both produce 204; retry later if notes are needed.
 */
export async function GET() {
  try {
    const status = await checkNpmUpdate(false);
    if (!status.updateAvailable || !status.availableVersion) return noContent();

    const notes = await getGitHubReleaseNotes(status.availableVersion);
    if (!notes || notes.version !== status.availableVersion) return noContent();
    return Response.json(notes, { headers: NO_STORE_HEADERS });
  } catch {
    return noContent();
  }
}
