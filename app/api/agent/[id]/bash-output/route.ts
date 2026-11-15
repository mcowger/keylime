import {
  apiErrorResponse,
  opErrorResponse,
  resolveWorkspaceHost,
} from "@/lib/api-utils";
import { workspaceReadStream } from "@/lib/workspace-http";

/**
 * @apiContract getAgentBashOutput
 * @apiUsage Read or download full bash output referenced by a session.
 * @apiInputs path is required; hostId may select the host and download=1 streams the file instead of returning JSON text.
 * @apiInvariants The owning host authorizes the session reference; display reads have a size cap, while downloads stream bytes as UTF-8 text without that display cap.
 * @apiEffects Reads host storage; the download stream stops with the request signal. No process is started.
 * @apiRecovery On display size 413 use download=1; reconnect and restart the download after an interrupted stream.
 */
export async function GET(
  request: Request,
  {
    params,
    disableIdleTimeout,
  }: { params: Promise<{ id: string }>; disableIdleTimeout: () => void },
) {
  try {
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const path = query.get("path");
    if (!path)
      return Response.json({ error: "path required" }, { status: 400 });
    const resolved = await resolveWorkspaceHost(
      query.get("hostId") ?? undefined,
      id,
    );
    if ("response" in resolved) return resolved.response;
    const { host } = resolved;
    if (query.get("download") === "1") {
      const opened = await host.workspaceOps.openBashOutput(id, path);
      if (!opened.ok) return opErrorResponse(opened);
      disableIdleTimeout();
      return new Response(
        workspaceReadStream(
          host,
          opened.value,
          0,
          opened.value.info.size - 1,
          request.signal,
        ),
        {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": 'attachment; filename="bash-output.log"',
            "Cache-Control": "no-store",
          },
        },
      );
    }
    const result = await host.workspaceOps.readBashOutput(id, path);
    if (!result.ok) return opErrorResponse(result);
    if (result.value.tooLarge)
      return Response.json(
        {
          error: `Full output is too large to display (limit ${result.value.maxBytes} bytes)`,
          data: { size: result.value.size, maxBytes: result.value.maxBytes },
        },
        { status: 413 },
      );
    return Response.json({
      success: true,
      data: { output: result.value.output },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
