import { Value } from "@sinclair/typebox/value";
import { apiErrorResponse, resolveHostOrError } from "@/lib/api-utils";
import {
  PlanningImageQuerySchema,
  PlanningHttpRequestSchema,
  type PlanningResult,
} from "@/lib/api-contracts/planning";
import {
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import { draftPlanningPrompt, PlanningDraftError } from "@/lib/planning-draft";
import { validateAgentImages } from "@/lib/image-attachments";
import { runPlanningLaunch } from "@/lib/planning-launch";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";

const MAX_BODY_BYTES = MAX_AGENT_COMMAND_REQUEST_BYTES;

/**
 * @apiContract workspacePlanningImageGet
 * @apiUsage Preview a saved Notes or task image.
 * @apiInputs Provide kind, ownerId, imageId and optional host.
 * @apiInvariants The authenticated owning daemon reads only images referenced by that board or its launch snapshots.
 * @apiEffects Returns raster bytes without changing the board.
 * @apiRecovery Refresh the board if an image was removed or the host reconnects.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = {
    host: params.get("host") ?? undefined,
    kind: params.get("kind"),
    ownerId: params.get("ownerId"),
    imageId: params.get("imageId"),
  };
  if (!Value.Check(PlanningImageQuerySchema, query))
    return Response.json(
      { error: "Invalid planning image request", code: "invalid_request" },
      { status: 400 },
    );
  const resolved = resolveHostOrError(query.host);
  if ("response" in resolved) return resolved.response;
  try {
    const { imagePayloads } = await resolved.host.workspaceOps.planning({
      owner: { kind: query.kind, id: query.ownerId },
      input: { action: "readImages", ids: [query.imageId] },
    });
    const image = imagePayloads?.[0];
    if (!image)
      return Response.json(
        { error: "Planning image not found", code: "planning_image_not_found" },
        { status: 404 },
      );
    return new Response(Buffer.from(image.data, "base64"), {
      headers: {
        "content-type": image.mimeType,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * @apiContract workspacePlanningPost
 * @apiUsage Read or edit Repo and System notebooks and task boards, improve the contents of a task's Brief editor, or launch a saved task.
 * @apiInputs Select an owning daemon and stable Repo or System ID. Writes use the current revision. Notes and tasks accept PNG, JPEG, GIF or WebP attachments. If launch or resume returns a review, repeat that action with confirmation and selected refs. Maximum request size is 8 MiB.
 * @apiInvariants Improvement sends the Brief, target name and selected task images, never shared Notes or checkout contents. Saved attachment IDs must belong to the task.
 * @apiEffects Improvement returns replacement text without saving edits. Launch snapshots saved Notes and task images (at most ten images and 5 MiB combined) with the literal first message. Refresh never resends an uncertain message.
 * @apiRecovery Read the board after a conflict or lost reply. Resume a stale, unadmitted Effort to review a fresh plan under the same launch ID. Admitted Efforts retry their saved setup; never resend if first-message delivery is uncertain.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json(
        { error: "Planning request exceeds 8 MiB", code: "request_too_large" },
        { status: 413 },
      );
    return Response.json(
      { error: "Invalid JSON request body", code: "invalid_json" },
      { status: 400 },
    );
  }
  if (!Value.Check(PlanningHttpRequestSchema, body))
    return Response.json(
      { error: "Invalid planning request", code: "invalid_request" },
      { status: 400 },
    );
  try {
    const { host, owner, input } = body;
    const resolved = resolveHostOrError(host);
    if ("response" in resolved) return resolved.response;
    const target = resolved.host;
    let result: PlanningResult;
    if (input.action === "draft") {
      const board = await target.workspaceOps.planning({
        owner,
        input: { action: "read" },
      });
      const edits = input.images ?? [];
      const ids = edits.filter(
        (image): image is string => typeof image === "string",
      );
      const task = board.tasks.find(({ id }) => id === input.taskId);
      if (ids.some((id) => !task?.images?.some((image) => image.id === id)))
        return Response.json(
          {
            error: "Refresh the task before improving its Brief.",
            code: "planning_image_not_found",
          },
          { status: 404 },
        );
      const saved = ids.length
        ? ((
            await target.workspaceOps.planning({
              owner,
              input: { action: "readImages", ids },
            })
          ).imagePayloads ?? [])
        : [];
      let index = 0;
      const images = edits.map((image) =>
        typeof image === "string"
          ? saved[index++]
          : {
              type: "image" as const,
              mimeType: image.mimeType,
              data: image.data,
            },
      );
      const imageError = validateAgentImages(images);
      if (imageError)
        return Response.json(
          { error: imageError, code: "invalid_images" },
          { status: 400 },
        );
      result = {
        draft: await draftPlanningPrompt(
          board.name,
          input.brief,
          request.signal,
          images,
        ),
      };
    } else if (
      input.action === "launch" ||
      input.action === "resume" ||
      input.action === "refresh"
    ) {
      result = await runPlanningLaunch(target, owner, input);
    } else {
      result = { board: await target.workspaceOps.planning({ owner, input }) };
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof PlanningDraftError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    return apiErrorResponse(error);
  }
}
