import { getSttJobAudio } from "@/lib/stt-jobs";

/** GET /api/stt/[jobId]/audio — the recording kept with a live job, for playback in any browser. */
/**
 * @apiContract getSttJobidAudio
 * @apiUsage Play back retained audio for a live transcription job.
 * @apiInputs Path jobId identifies the job; no owner or claim token is required.
 * @apiInvariants Audio is process-local and unavailable after claim, discard, expiry or restart; content type is restricted to bare audio types or octet-stream.
 * @apiEffects Reads audio without claiming it; response is private, no-store and nosniff.
 * @apiRecovery Missing audio or job returns 404; recording browsers may retain local audio for recovery.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const audio = getSttJobAudio((await params).jobId);
  if (!audio) {
    return Response.json(
      { error: "Transcription job not found", code: "stt_job_not_found" },
      { status: 404 },
    );
  }
  // The type came from the uploading browser: serve only a bare audio/* type
  // so a crafted upload cannot render as HTML on this origin.
  const type =
    /^audio\/[a-z0-9.+-]+/i.exec(audio.type)?.[0] ?? "application/octet-stream";
  return new Response(audio, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(audio.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
