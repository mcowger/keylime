import {
  apiErrorResponse,
  opErrorResponse,
  resolveSessionHostOr404,
} from "@/lib/api-utils";
import { getContentDisposition } from "@/lib/content-disposition";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";

/** Render a session to self-contained HTML with the omp binary on its host (`omp --export`). */
/**
 * @apiContract exportSession
 * @apiUsage Render persisted session history as self-contained HTML using omp on the owning host.
 * @apiInputs id identifies the session; inline=1 requests inline disposition only for the local host.
 * @apiInvariants Remote host HTML is always an attachment, even when inline was requested. The result reflects the host's export at request time.
 * @apiEffects Runs the host export operation and returns HTML; it does not mutate the session.
 * @apiRecovery Retry the read when the host and its omp binary are available; restart an interrupted download.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const inline = new URL(req.url).searchParams.get("inline") === "1";

  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.exportSession(id);
    if (!result.ok) return opErrorResponse(result);
    // Another host's HTML is untrusted: opened inline it would run on this origin. This machine's daemon is the server's own.
    const asInline = inline && resolved.host.id === LOCAL_HOST_ID;
    return new Response(result.value.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": getContentDisposition(
          result.value.fileName,
          asInline,
          "session.html",
        ),
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
