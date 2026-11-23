import { isRecord } from "../lib/type-guards";
import type { operations } from "./generated/web-http";

type Message =
  operations["getSession"]["responses"][200]["content"]["application/json"]["context"]["messages"][number];
export type ChatToolResult = Extract<Message, { role: "toolResult" }>;
export type ChatToolResults = Record<string, ChatToolResult>;
type ToolEvent = Record<string, unknown> & { type: string };

/** Apply an accumulated tool frame. Updates and ends replace, rather than append, output. */
export function applyToolEvent(
  results: ChatToolResults,
  event: ToolEvent,
  messages: readonly Message[],
): ChatToolResults {
  const id = event.toolCallId;
  if (typeof id !== "string" || !id) return results;
  if (
    messages.some(
      (message) => message.role === "toolResult" && message.toolCallId === id,
    )
  ) {
    if (!Object.hasOwn(results, id)) return results;
    const next = { ...results };
    delete next[id];
    return next;
  }
  const previous = Object.hasOwn(results, id) ? results[id] : undefined;
  // A late start/update must not overwrite a completed result.
  if (previous && !previous.partial && event.type !== "tool_execution_end")
    return results;
  const isEnd = event.type === "tool_execution_end";
  const isUpdate = event.type === "tool_execution_update";
  if (!isEnd && !isUpdate && event.type !== "tool_execution_start")
    return results;
  const payload = isRecord(isEnd ? event.result : event.partialResult)
    ? ((isEnd ? event.result : event.partialResult) as Record<string, unknown>)
    : null;
  const toolName =
    typeof event.toolName === "string" ? event.toolName : previous?.toolName;
  const result: ChatToolResult = {
    role: "toolResult",
    toolCallId: id,
    ...(toolName ? { toolName } : {}),
    content: Array.isArray(payload?.content)
      ? (payload.content as ChatToolResult["content"])
      : [],
    ...(payload?.details !== undefined ? { details: payload.details } : {}),
    ...(isEnd
      ? { isError: payload?.isError === true || event.isError === true }
      : { partial: true }),
  };
  return { ...results, [id]: result };
}

/** A covered snapshot represents running frames, but deliberately omits ends. */
export function applyCoveredToolEvent(
  results: ChatToolResults,
  event: ToolEvent,
  messages: readonly Message[],
): ChatToolResults {
  return event.type === "tool_execution_end"
    ? applyToolEvent(results, event, messages)
    : results;
}

/** Replace running snapshots, retain completed results until history contains them. */
export function reconcileToolSnapshot(
  results: ChatToolResults,
  events: readonly ToolEvent[],
  messages: readonly Message[],
): ChatToolResults {
  const saved = new Set(
    messages.flatMap((message) =>
      message.role === "toolResult" ? [message.toolCallId] : [],
    ),
  );
  let next: ChatToolResults = Object.fromEntries(
    Object.entries(results).filter(
      ([id, result]) => !result.partial && !saved.has(id),
    ),
  );
  for (const event of events) next = applyToolEvent(next, event, messages);
  return next;
}

/** A run or stream boundary discards running frames but not uncommitted ends. */
export function retainEndedTools(results: ChatToolResults): ChatToolResults {
  return Object.fromEntries(
    Object.entries(results).filter(([, result]) => !result.partial),
  );
}
