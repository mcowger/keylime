import {
  isApiRequestOriginAllowed,
  shouldCheckApiRequestOrigin,
} from "@/lib/request-security";
import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import { checkNpmUpdate } from "@/lib/npm-update";
import {
  abortPreparedSelfUpdate,
  acknowledgeSelfUpdate,
  armSelfUpdateLauncher,
  commitSelfUpdate,
  getSelfUpdateStatus,
  getSelfUpdateSupport,
  markSelfUpdateStopping,
  prepareSelfUpdate,
  SelfUpdateError,
  validateCommitSelfUpdate,
} from "@/lib/self-update";

type CommitResult = { accepted: true; attemptId: string };

async function commitAppUpdate(attemptId: string): Promise<CommitResult> {
  let launcherArmed = false;
  try {
    const commitState = validateCommitSelfUpdate(attemptId);
    if (commitState === "replay") return { accepted: true, attemptId };
    if (commitState === "ready") markSelfUpdateStopping(attemptId);
    await armSelfUpdateLauncher(attemptId);
    launcherArmed = true;
    return await commitSelfUpdate(attemptId);
  } catch (error) {
    if (!launcherArmed) {
      const reason =
        error instanceof SelfUpdateError
          ? error.message
          : "The application update could not be committed";
      await abortPreparedSelfUpdate(attemptId, reason);
    }
    throw error;
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof SelfUpdateError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.httpStatus },
    );
  }
  return Response.json(
    {
      error: "The application update could not be started",
      code: "update_failed",
    },
    { status: 500 },
  );
}

/**
 * @apiContract getAppUpdate
 * @apiUsage Inspect the web application's available package update and self-update support.
 * @apiInputs Set force=1 to bypass the npm update check's process cache; other values do not force it.
 * @apiInvariants This is a no-store response, but the underlying npm check normally uses a process-local cache. Self-update status is omitted when updates are disabled.
 * @apiEffects May contact the package registry; it does not start an update.
 * @apiRecovery A failed registry check may leave availability unknown; retry or force a fresh check rather than treating it as proof that no update exists.
 */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  const status = await checkNpmUpdate(force);
  const support = getSelfUpdateSupport();
  const selfUpdateStatus = status.updatesDisabled
    ? null
    : getSelfUpdateStatus();
  return Response.json(
    {
      ...status,
      selfUpdateSupported: support.supported,
      ...(selfUpdateStatus ? { selfUpdateStatus } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * @apiContract postAppUpdate
 * @apiUsage Prepare and commit a web application self-update, inspect its status, or acknowledge completion. This is distinct from restarting omp sessions or updating a daemon.
 * @apiInputs Send application/json of at most 4096 bytes: exactly {action:"prepare"}, {action:"status"}, or {action:"commit"|"acknowledge", attemptId:string}.
 * @apiInvariants Browser-origin requests must pass the origin check. Commit requires the prepared attempt and its state preconditions; a replay of an accepted commit returns acceptance again. A 202 is acceptance, not installation completion.
 * @apiEffects Preparation creates update state; commit arms the launcher and initiates stopping, installation and restart. Status is no-store; acknowledgment changes retained completion state.
 * @apiRecovery After an uncertain commit, inspect status using the attempt ID before acting; replaying that same commit is recognized. A failure before the launcher is armed aborts the prepared attempt.
 */
export async function POST(request: Request) {
  if (
    shouldCheckApiRequestOrigin(request) &&
    !isApiRequestOriginAllowed(request)
  ) {
    return Response.json(
      {
        error: "Cross-origin API requests are not allowed",
        code: "cross_origin_forbidden",
      },
      { status: 403 },
    );
  }
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  ) {
    return Response.json(
      {
        error: "Content-Type must be application/json",
        code: "unsupported_media_type",
      },
      { status: 415 },
    );
  }
  try {
    const body = await parseJsonWithinLimit<Record<string, unknown> | null>(
      request,
      4_096,
    );
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new SelfUpdateError(
        "invalid_action",
        "action must be prepare, commit, status, or acknowledge",
      );
    const keys = Object.keys(body);
    if (body.action === "prepare" && keys.length === 1) {
      const result = await prepareSelfUpdate();
      return Response.json(result, { status: 202 });
    }
    if (
      body.action === "acknowledge" &&
      keys.length === 2 &&
      typeof body.attemptId === "string"
    ) {
      return Response.json(acknowledgeSelfUpdate(body.attemptId));
    }
    if (
      body.action === "commit" &&
      keys.length === 2 &&
      typeof body.attemptId === "string"
    ) {
      const result = await commitAppUpdate(body.attemptId);
      return Response.json(result, { status: 202 });
    }
    if (body.action === "status" && keys.length === 1) {
      const selfUpdateStatus = getSelfUpdateStatus();
      return Response.json(selfUpdateStatus ?? null, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    throw new SelfUpdateError(
      "invalid_action",
      "action must be prepare, commit, status, or acknowledge",
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json(
        { error: error.message, code: "body_too_large" },
        { status: 413 },
      );
    if (error instanceof SyntaxError)
      return errorResponse(
        new SelfUpdateError("invalid_json", "Request body must be valid JSON"),
      );
    return errorResponse(error);
  }
}
