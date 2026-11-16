import {
  parseFormDataWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import {
  isSttAfter,
  MAX_STT_AUDIO_BYTES,
  MAX_STT_REQUEST_BYTES,
} from "@/lib/stt";
import { listSttJobs, readSttConfig, startSttJob } from "@/lib/stt-jobs";

const MAX_SCOPE_LENGTH = 1024;

/** GET /api/stt?scope=<draft key> — live jobs for that composer, newest first. */
/**
 * @apiContract getStt
 * @apiUsage Discover live transcription jobs for a composer, newest first.
 * @apiInputs Query scope is required and at most 1024 characters.
 * @apiInvariants Views contain status and error, never transcript text; gone jobs are excluded.
 * @apiEffects Reads the process-local job store without starting transcription.
 * @apiRecovery Invalid scope returns 400; jobs disappear after expiry or server restart.
 */
export async function GET(request: Request) {
  const scope = new URL(request.url).searchParams.get("scope");
  if (!scope || scope.length > MAX_SCOPE_LENGTH) {
    return Response.json(
      { error: "scope is required", code: "missing_scope" },
      { status: 400 },
    );
  }
  return Response.json({ jobs: listSttJobs(scope) });
}

/**
 * POST /api/stt (multipart: file, optional scope) — keeps the audio and starts
 * a server-side transcription job. Returns 202 { jobId }; poll
 * GET /api/stt/[jobId] for the result.
 */
/**
 * @apiContract postStt
 * @apiUsage Upload recording once and follow the returned jobId via GET and claim via DELETE.
 * @apiInputs Multipart file is required and nonempty, at most 25MB; optional scope is at most 1024 characters, owner is truncated to 128, and after selects send, steer or followup.
 * @apiInvariants Owner identifies the recording tab, not the per-composer claim token; absent after means insert. Jobs and audio live in process memory.
 * @apiEffects Starts one upstream transcription and retains audio for playback or retry; success returns 202.
 * @apiRecovery Missing configuration returns 501, invalid input 400, oversized audio 413 and capacity exhaustion 429. A repeated upload creates a new job, not a deduplicated retry.
 */
export async function POST(request: Request) {
  try {
    const config = readSttConfig();
    if (!config) {
      return Response.json(
        {
          error:
            "STT not configured. Set KEYLIME_STT_ENDPOINT or KEYLIME_STT_MODEL.",
        },
        { status: 501 },
      );
    }

    const formData = await parseFormDataWithinLimit(
      request,
      MAX_STT_REQUEST_BYTES,
    );
    const file = formData.get("file");
    if (!file || typeof file === "string" || file.size === 0) {
      return Response.json(
        { error: "Audio file is required", code: "missing_audio_file" },
        { status: 400 },
      );
    }
    if (file.size > MAX_STT_AUDIO_BYTES) {
      return Response.json(
        { error: "Audio file too large (max 25MB)", code: "audio_too_large" },
        { status: 413 },
      );
    }
    const scope = formData.get("scope");
    if (
      scope !== null &&
      (typeof scope !== "string" || scope.length > MAX_SCOPE_LENGTH)
    ) {
      return Response.json(
        { error: "Invalid scope", code: "invalid_scope" },
        { status: 400 },
      );
    }
    // The uploader's claim token: it gets first claim on the transcript.
    const owner = formData.get("owner");
    // What to do with the transcript (send/steer/followup); absent = insert.
    const after = formData.get("after");
    if (after !== null && !isSttAfter(after)) {
      return Response.json(
        { error: "Invalid after", code: "invalid_after" },
        { status: 400 },
      );
    }

    const jobId = startSttJob(config, {
      audio: file,
      scope: scope || null,
      owner:
        typeof owner === "string" && owner ? owner.slice(0, 128) : undefined,
      after: after ?? undefined,
    });
    if (!jobId) {
      return Response.json(
        { error: "Too many transcriptions in progress", code: "stt_busy" },
        { status: 429 },
      );
    }
    return Response.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "Audio file too large (max 25MB)", code: "audio_too_large" },
        { status: 413 },
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
