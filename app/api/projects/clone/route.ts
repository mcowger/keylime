import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";
import type { CloneProgress } from "@/lib/git-clone";

/**
 * @apiContract workspaceClonePost
 * @apiUsage Clone a project and stream progress frames.
 * @apiInputs Send an id, destination parent, repository URL and optional hostId; paths are on that host.
 * @apiInvariants The client-provided id identifies the host clone job; progress is read with an advancing cursor.
 * @apiEffects Starts a host clone; request abort or stream cancellation asks the host to cancel.
 * @apiRecovery Disconnect cancellation is best effort and may race completion; inspect the destination before retrying.
 */
export async function POST(
  request: Request,
  { disableIdleTimeout }: { disableIdleTimeout: () => void },
) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (
      !isRecord(body) ||
      typeof body.id !== "string" ||
      typeof body.parent !== "string" ||
      typeof body.url !== "string"
    )
      return Response.json(
        { error: "Invalid clone request", code: "invalid_request" },
        { status: 400 },
      );
    const resolved = await resolveWorkspaceHost(body.hostId, null);
    if ("response" in resolved) return resolved.response;
    const { host } = resolved;
    const id = body.id;
    let active = true;
    const cancel = () => {
      void host.workspaceOps.cancelClone(id).catch(() => {});
    };
    const started = await host.workspaceOps.startClone(
      id,
      body.parent,
      body.url.trim(),
    );
    if (!started.ok) {
      request.signal.removeEventListener("abort", cancel);
      return opErrorResponse(started);
    }
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    let cursor = 0;
    const encoder = new TextEncoder();
    disableIdleTimeout();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            let page: CloneProgress;
            do {
              const result = await host.workspaceOps.readClone(id, cursor);
              if (!active) return;
              if (!result.ok) throw new Error(result.error);
              page = result.value;
            } while (!page.terminal && page.frames.length === 0);
            cursor = page.cursor;
            if (page.reset)
              controller.enqueue(
                encoder.encode(
                  `${JSON.stringify({ type: "output", text: "", reset: true })}\n`,
                ),
              );
            for (const frame of page.frames)
              controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
            if (page.terminal) {
              active = false;
              request.signal.removeEventListener("abort", cancel);
              controller.close();
            }
          } catch {
            if (!active) return;
            active = false;
            request.signal.removeEventListener("abort", cancel);
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "error", code: "clone_uncertain", error: "The clone connection was interrupted; its outcome is unknown. Check the destination before retrying." })}\n`,
              ),
            );
            controller.close();
          }
        },
        cancel() {
          active = false;
          request.signal.removeEventListener("abort", cancel);
          cancel();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(
      error,
      error instanceof RequestBodyTooLargeError
        ? 413
        : error instanceof SyntaxError
          ? 400
          : 500,
    );
  }
}

/**
 * @apiContract workspaceCloneDelete
 * @apiUsage Request cancellation of a clone.
 * @apiInputs Send the clone id and optional hostId.
 * @apiInvariants Cancellation is directed to the host that owns the job.
 * @apiEffects Asks the host to cancel; cancellation can race clone completion.
 * @apiRecovery Inspect the destination and job outcome after uncertainty rather than assuming rollback.
 */
export async function DELETE(request: Request) {
  try {
    const body: unknown = await parseJsonWithinLimit(request, 64 * 1024);
    if (!isRecord(body) || typeof body.id !== "string")
      return Response.json(
        { error: "Invalid clone request", code: "invalid_request" },
        { status: 400 },
      );
    const resolved = await resolveWorkspaceHost(body.hostId, null);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.cancelClone(body.id);
    return result.ok
      ? Response.json({ ok: true, ...result.value })
      : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(
      error,
      error instanceof RequestBodyTooLargeError
        ? 413
        : error instanceof SyntaxError
          ? 400
          : 500,
    );
  }
}
