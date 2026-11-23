import { formatCompactNumber } from "../lib/format";
import { isRecord } from "../lib/type-guards";
import type { operations } from "./generated/web-http";

type Message =
  operations["getSession"]["responses"][200]["content"]["application/json"]["context"]["messages"][number];
export type NativeToolCall = Extract<
  Extract<Message, { role: "assistant" }>["content"][number],
  { type: "toolCall" }
>;
export type NativeToolResult = Extract<Message, { role: "toolResult" }>;

export type NativeToolCategory =
  | "read"
  | "search"
  | "edit"
  | "terminal"
  | "todo"
  | "task"
  | "code"
  | "web"
  | "hub"
  | "agent-message"
  | "other";

/** Display values for one tool row; hubTitle and resultMeta are absent when null. */
export interface NativeToolPresentation {
  category: NativeToolCategory;
  iconOnly: boolean;
  displayName: string;
  intent: string;
  preview: string;
  language: string;
  hubTitle: string | null;
  resultMeta: string | null;
}

// Keep in step with the PWA's MessageView-tool-format and ToolCallBlock. Those
// modules use web-only imports and cannot be loaded by the native Metro bundle.
function categoryFor(name: string): NativeToolCategory {
  name = name.toLowerCase();
  if (name === "hub") return "hub";
  if (
    name === "read" ||
    name.endsWith(".read") ||
    name.endsWith("_read") ||
    name === "file_read"
  )
    return "read";
  if (
    name === "grep" ||
    name === "glob" ||
    name === "ast_grep" ||
    name.includes("search") ||
    name.endsWith(".grep") ||
    name.endsWith(".glob")
  )
    return "search";
  if (
    name === "edit" ||
    name === "write" ||
    name === "ast_edit" ||
    name.endsWith(".edit") ||
    name.endsWith(".write")
  )
    return "edit";
  if (["bash", "terminal", "exec", "shell", "cmd"].includes(name))
    return "terminal";
  if (name === "todo" || name.endsWith(".todo")) return "todo";
  if (
    name === "task" ||
    name === "agent" ||
    name.endsWith(".task") ||
    name.endsWith(".agent")
  )
    return "task";
  if (name === "eval" || name.endsWith(".eval")) return "code";
  if (name === "web_search" || name === "browser" || name.includes("browser"))
    return "web";
  return "other";
}

function todoPreview(input: Record<string, unknown>): string | null {
  if (typeof input.op !== "string") return null;
  const task = typeof input.task === "string" ? input.task : undefined;
  const items = Array.isArray(input.items)
    ? input.items.filter((item): item is string => typeof item === "string")
    : undefined;
  switch (input.op) {
    case "done":
      return task ? `Completed "${task}"` : "Completed task";
    case "start":
      return task ? `Started "${task}"` : "Started task";
    case "append":
      return task
        ? `Added "${task}"`
        : items?.length
          ? `Added ${items.length} task${items.length > 1 ? "s" : ""}`
          : "Added task";
    case "init": {
      const count = Array.isArray(input.list)
        ? input.list.reduce(
            (sum, phase) =>
              sum +
              (isRecord(phase) && Array.isArray(phase.items)
                ? phase.items.length
                : 0),
            0,
          )
        : (items?.length ?? 0);
      return `Initialized plan (${count} tasks)`;
    }
    case "block":
      return task ? `Blocked "${task}"` : "Blocked task";
    case "unblock":
      return task ? `Unblocked "${task}"` : "Unblocked task";
    case "drop":
      return task ? `Dropped "${task}"` : "Dropped task";
    default:
      return `Task: ${input.op}${task ? ` "${task}"` : ""}`;
  }
}

function askPreview(input: Record<string, unknown>): string | null {
  if (!Array.isArray(input.questions)) return null;
  const prompts = input.questions
    .filter(isRecord)
    .map((question) => {
      const header =
        typeof question.header === "string" ? question.header.trim() : "";
      const prompt =
        typeof question.question === "string" ? question.question.trim() : "";
      return header && prompt ? `${header}: ${prompt}` : header || prompt;
    })
    .filter(Boolean);
  if (!prompts.length)
    return input.questions.length
      ? `${input.questions.length} question${input.questions.length === 1 ? "" : "s"}`
      : "";
  const label =
    prompts.length === 1 ? "Question" : `${prompts.length} questions`;
  return `${label}: ${prompts.map((prompt) => `“${prompt}”`).join(" · ")}`;
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function toolPreview(
  block: NativeToolCall,
  category: NativeToolCategory,
): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  if (block.toolName.toLowerCase() === "ask") {
    const preview = askPreview(input);
    if (preview !== null) return preview.slice(0, 120);
  }
  if (category === "todo") {
    const preview = todoPreview(input);
    if (preview !== null) return preview;
  }
  if (category === "hub") {
    if (input.op === "send") return hubSend(input)?.snippet ?? "send";
    if (input.op === "jobs") return "jobs";
    if (typeof input.op === "string") return input.op;
  }
  const keys = Object.keys(input);
  if (!keys.length) return "";
  for (const key of ["command", "path", "file_path", "pattern", "query"]) {
    if (key in input) return previewValue(input[key]).slice(0, 120);
  }
  return previewValue(input[keys[0]]).slice(0, 120);
}

function hubSend(
  input: Record<string, unknown>,
): { to: string[]; snippet: string } | null {
  if (input.op !== "send") return null;
  const raw = Array.isArray(input.to)
    ? input.to
    : typeof input.to === "string"
      ? [input.to]
      : [];
  const to = raw
    .filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    )
    .slice(0, 10);
  if (!to.length) return null;
  const message = typeof input.message === "string" ? input.message : "";
  const firstLine =
    message
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  return {
    to,
    snippet: firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine,
  };
}

function hubJobs(details: unknown): { label: string; status: string }[] | null {
  if (
    !isRecord(details) ||
    details.op !== "jobs" ||
    !Array.isArray(details.jobs)
  )
    return null;
  const jobs: { label: string; status: string }[] = [];
  for (const job of details.jobs) {
    if (!isRecord(job) || typeof job.id !== "string" || !job.id) continue;
    jobs.push({
      label: typeof job.label === "string" && job.label ? job.label : job.id,
      status: typeof job.status === "string" ? job.status : "running",
    });
    if (jobs.length >= 50) break;
  }
  return jobs.length ? jobs : null;
}

/** Compact usage metadata shown beneath a tool row, if supplied by the result. */
export function getNativeToolResultMeta(
  result?: NativeToolResult,
): string | null {
  if (!result || !isRecord(result.details)) return null;
  const usage = isRecord(result.details.usage)
    ? result.details.usage
    : result.details;
  const readNumber = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0)
        return value;
    }
    return undefined;
  };
  const input = readNumber("input", "inputTokens", "input_tokens");
  const output = readNumber("output", "outputTokens", "output_tokens");
  const cacheRead = readNumber("cacheRead", "cache_read", "cacheReadTokens");
  const cacheWrite = readNumber(
    "cacheWrite",
    "cache_write",
    "cacheWriteTokens",
  );
  const parts = [
    input ? `in ${formatCompactNumber(input)}` : null,
    output ? `out ${formatCompactNumber(output)}` : null,
    cacheRead ? `cache R ${formatCompactNumber(cacheRead)}` : null,
    cacheWrite ? `cache W ${formatCompactNumber(cacheWrite)}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

/** Whole seconds from the assistant message timestamp to the result, as in the PWA. */
export function getNativeToolDuration(
  startTimestamp: number | undefined,
  result?: NativeToolResult,
): number | undefined {
  if (!startTimestamp || !result?.timestamp) return undefined;
  const seconds = Math.round((result.timestamp - startTimestamp) / 1000);
  return seconds > 0 && Number.isFinite(seconds) ? seconds : undefined;
}

/** Derive row labels and icon category without interpreting or modifying tool execution. */
export function getNativeToolPresentation(
  block: NativeToolCall,
  result?: NativeToolResult,
): NativeToolPresentation {
  const originalCategory = categoryFor(block.toolName);
  const path = typeof block.input?.path === "string" ? block.input.path : "";
  const isWrite = block.toolName.toLowerCase() === "write";
  const agentMessage = isWrite && /^agent:\/\//i.test(path);
  const device = isWrite
    ? /^xd:\/\/([a-z][a-z0-9_]*)(?:[?#].*)?$/i.exec(path)?.[1]
    : undefined;
  const name = agentMessage ? "agent" : (device ?? block.toolName);
  const iconOnly =
    /^(?:read|file_read|grep|glob|search|ast_grep|web_search|edit|write|ast_edit|bash|terminal|exec|shell|cmd|todo|task|agent|eval|browser|hub)$/i.test(
      name,
    ) ||
    /^(?:functions|tools)\.(?:read|grep|glob|edit|write|todo|task|eval|agent)$/i.test(
      name,
    );
  const send =
    originalCategory === "hub" && isRecord(block.input)
      ? hubSend(block.input)
      : null;
  const jobs = originalCategory === "hub" ? hubJobs(result?.details) : null;
  let hubTitle: string | null = null;
  let hubPreview: string | null = null;
  if (send) {
    const receipts = isRecord(result?.details)
      ? result.details.receipts
      : undefined;
    const outcomes = Array.isArray(receipts)
      ? receipts.map((receipt) =>
          isRecord(receipt) && typeof receipt.outcome === "string"
            ? receipt.outcome
            : null,
        )
      : [];
    const outcome =
      outcomes.length &&
      outcomes.every((item) => item !== null && item === outcomes[0])
        ? outcomes[0]
        : null;
    hubTitle = `IRC → ${send.to.join(", ")}${outcome ? ` ${outcome}` : ""}`;
    hubPreview = send.snippet || send.to.join(", ");
  } else if (jobs) {
    const waiting = jobs.some((job) =>
      ["running", "started", "waiting"].includes(job.status),
    );
    hubTitle = `${waiting ? "waiting on " : ""}${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
    hubPreview = jobs.map((job) => job.label).join(" · ");
  }
  return {
    category: agentMessage
      ? "agent-message"
      : device
        ? categoryFor(device)
        : originalCategory,
    iconOnly,
    displayName: name.replace(/^mcp__/i, ""),
    intent:
      block.intent?.trim() ||
      (typeof block.input?.i === "string" ? block.input.i.trim() : ""),
    preview:
      originalCategory === "code"
        ? ""
        : (hubPreview ?? toolPreview(block, originalCategory)),
    language:
      originalCategory === "code" && typeof block.input?.language === "string"
        ? block.input.language.trim().toLowerCase()
        : "",
    hubTitle,
    resultMeta: getNativeToolResultMeta(result),
  };
}
