import {
  closeSttJob,
  getSttJob,
  readSttConfig,
  retrySttJob,
} from "@/lib/stt-jobs";

type Params = { params: Promise<{ jobId: string }> };

const notFound = () =>
  Response.json(
    { error: "Transcription job not found", code: "stt_job_not_found" },
    { status: 404 },
  );

/**
 * GET /api/stt/[jobId] — { id, status: "pending" | "done" | "error" | "gone", error? },
 * or 404 for an unknown/expired job. The transcript is never here: claim it
 * with DELETE ?claim=<token>. "gone" means another browser claimed or
 * discarded it. Job failures are 200 payloads, not 5xx, so an intermediate
 * proxy cannot swap them for its own error page.
 */
/**
 * @apiContract getSttJobid
 * @apiUsage Poll a transcription job until done, error or gone before claiming it.
 * @apiInputs Path jobId identifies the process-local job.
 * @apiInvariants The view never contains transcript text; upstream failures are 200 error-status views.
 * @apiEffects Reads job status without claiming or starting work.
 * @apiRecovery Unknown or expired jobs return 404; settled jobs expire after one hour and tombstones after ten minutes or earlier pruning; restart loses the store.
 */
export async function GET(_req: Request, { params }: Params) {
  const job = getSttJob((await params).jobId);
  return job ? Response.json(job) : notFound();
}

/** POST /api/stt/[jobId]?owner=<token> — retry a failed job with the audio the server kept. */
/**
 * @apiContract postSttJobid
 * @apiUsage Retry a failed transcription using its retained audio rather than uploading another job.
 * @apiInputs Path jobId and optional query owner, truncated to 128 characters, identify the job and retrying tab.
 * @apiInvariants Only an error job with audio starts a new attempt; pending or settled jobs return their current view, preventing duplicate attempts.
 * @apiEffects Reassigns ownership to the retrying tab and launches an upstream request when eligible.
 * @apiRecovery Returns 501 if unconfigured, 429 if pending capacity is full and 404 if missing or expired; retry a busy request later.
 */
export async function POST(req: Request, { params }: Params) {
  const config = readSttConfig();
  if (!config) {
    return Response.json(
      {
        error:
          "STT not configured. Set OMP_WEB_STT_ENDPOINT or OMP_WEB_STT_MODEL.",
      },
      { status: 501 },
    );
  }
  const owner =
    new URL(req.url).searchParams.get("owner")?.slice(0, 128) || undefined;
  const job = retrySttJob(config, (await params).jobId, owner);
  if (job === "busy") {
    return Response.json(
      { error: "Too many transcriptions in progress", code: "stt_busy" },
      { status: 429 },
    );
  }
  return job ? Response.json(job) : notFound();
}

/**
 * DELETE /api/stt/[jobId]?claim=<instance token>&owner=<tab token> — claim a
 * finished transcript, or (without `claim`) discard the job. Returns the job
 * as it was before closing: only the first claimer of a "done" job sees
 * status "done" with its text (repeatable with the same claim token), and
 * only the job's owner also gets its send/queue `after`; everyone else sees
 * "gone".
 */
/**
 * @apiContract deleteSttJobid
 * @apiUsage Claim a done transcript or omit claim to discard the job.
 * @apiInputs Path jobId and optional query claim (per composer instance) and owner (tab identity), each truncated to 128 characters.
 * @apiInvariants Only the first claim token receives text; the same token can replay its result. Owner has a 15-second first-claim grace and alone receives after; duplicated tabs may share owner but must use distinct claim tokens.
 * @apiEffects A successful claim or discard frees audio, aborts any attempt and leaves a gone tombstone; a claim on unfinished work changes nothing.
 * @apiRecovery Repeat a lost claim response with the same claim token; done without text during owner grace means retry, while other claimants see gone. Missing or expired jobs return 404; tombstones last up to ten minutes and may be pruned.
 */
export async function DELETE(req: Request, { params }: Params) {
  const query = new URL(req.url).searchParams;
  const claim = query.get("claim")?.slice(0, 128) || undefined;
  const owner = query.get("owner")?.slice(0, 128) || undefined;
  const job = closeSttJob((await params).jobId, claim, owner);
  return job ? Response.json(job) : notFound();
}
